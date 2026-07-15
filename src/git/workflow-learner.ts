// Workflow Learner — observes team Git patterns and provides tailored advice
// Learns: branch naming, PR size norms, merge preferences, reviewer assignments
// All analysis is local (git log), no external services

import { gitExec } from "./advisor.js";
import fs from "fs";
import path from "path";

export interface WorkflowProfile {
  /** Learned branch naming patterns */
  branchPatterns: Array<{ prefix: string; description: string; usageCount: number }>;
  /** Typical PR size stats */
  prSize: {
    medianFiles: number;
    medianLines: number;
    p75Files: number;
    p75Lines: number;
  };
  /** Merge preferences */
  mergePreference: {
    squash: number;
    merge: number;
    rebase: number;
  };
  /** Reviewer assignments (file → reviewer mappings) */
  reviewerMappings: Array<{ path: string; reviewer: string; count: number }>;
  /** Active hours */
  activeHours: Array<{ hour: number; count: number }>;
  /** Last updated */
  updatedAt: string;
  /** Total observations */
  observationCount: number;
}

const PROFILE_PATH = ".agent/workflow-profile.json";

// ---- Learn ----

export async function learnWorkflow(
  workingDir: string
): Promise<WorkflowProfile> {
  const existing = loadProfile(workingDir);
  const now = new Date().toISOString();

  try {
    // 1. Branch naming patterns
    const branchPatterns = await learnBranchPatterns(workingDir);

    // 2. PR size norms (from merge commits)
    const prSize = await learnPRSize(workingDir);

    // 3. Merge preferences
    const mergePreference = await learnMergePreference(workingDir);

    // 4. Active hours
    const activeHours = await learnActiveHours(workingDir);

    const profile: WorkflowProfile = {
      branchPatterns,
      prSize,
      mergePreference,
      reviewerMappings: existing?.reviewerMappings ?? [],
      activeHours,
      updatedAt: now,
      observationCount: (existing?.observationCount ?? 0) + 1,
    };

    saveProfile(workingDir, profile);
    return profile;
  } catch {
    return existing ?? emptyProfile();
  }
}

// ---- Check against learned patterns ----

export interface WorkflowAdvice {
  category: "branch" | "pr_size" | "merge" | "reviewer" | "timing";
  severity: "info" | "warning" | "suggestion";
  message: string;
}

/** Compare user's current action against learned patterns */
export function checkAgainstProfile(
  profile: WorkflowProfile,
  context: {
    branchName?: string;
    changedFiles?: number;
    changedLines?: number;
    filesModified?: string[];
    currentHour?: number;
  }
): WorkflowAdvice[] {
  const advice: WorkflowAdvice[] = [];

  // 1. Branch name check
  if (context.branchName && profile.branchPatterns.length > 0) {
    const matchingPattern = profile.branchPatterns.find((p) =>
      context.branchName!.startsWith(p.prefix)
    );

    if (!matchingPattern) {
      const examples = profile.branchPatterns
        .slice(0, 3)
        .map((p) => `\`${p.prefix}xxx\``)
        .join("、");

      advice.push({
        category: "branch",
        severity: "suggestion",
        message: `💡 你的分支名 \`${context.branchName}\` 不符合团队惯例。常见命名：${examples}`,
      });
    }
  }

  // 2. PR size check
  if (context.changedFiles && context.changedLines && profile.prSize.p75Files > 0) {
    if (
      context.changedFiles > profile.prSize.p75Files ||
      context.changedLines > profile.prSize.p75Lines
    ) {
      advice.push({
        category: "pr_size",
        severity: "warning",
        message: `⚠️ 你当前改了 ${context.changedFiles} 个文件、${context.changedLines} 行，超过团队 75% 的 PR 大小（${profile.prSize.p75Files} 文件、${profile.prSize.p75Lines} 行）。建议拆成 ${Math.ceil(context.changedFiles / profile.prSize.medianFiles)} 个 PR。`,
      });
    }
  }

  // 3. Merge preference
  const dominant = dominantMerge(profile.mergePreference);
  if (dominant.type === "squash" && dominant.pct > 0.7) {
    advice.push({
      category: "merge",
      severity: "info",
      message: `💡 团队最近 ${Math.round(dominant.pct * 100)}% 的 PR 用 squash merge，你的 commit message 不用太讲究"一个功能一个提交"（因为最终会被 squash 成一条），但那条最终 message 需要写清楚。`,
    });
  }

  // 4. Active hours
  if (context.currentHour && profile.activeHours.length > 0) {
    const peakHours = profile.activeHours.slice(0, 3).map((h) => h.hour);
    if (peakHours.includes(context.currentHour)) {
      advice.push({
        category: "timing",
        severity: "info",
        message: `💡 现在是团队 push 高峰期，建议在 rebase 时留意冲突。`,
      });
    }
  }

  return advice;
}

// ---- Internal learning functions ----

async function learnBranchPatterns(
  workingDir: string
): Promise<WorkflowProfile["branchPatterns"]> {
  const branches = await gitExec(
    ["branch", "-r", "--format=%(refname:short)"],
    workingDir
  ).catch(() => "");

  const patterns = new Map<string, { description: string; count: number }>();
  const knownPrefixes: Record<string, string> = {
    "feat/": "功能开发",
    "fix/": "Bug 修复",
    "docs/": "文档",
    "chore/": "杂项",
    "refactor/": "重构",
    "test/": "测试",
    "hotfix/": "紧急修复",
    "release/": "发布",
    "feature/": "功能开发",
  };

  for (const branch of branches.split("\n").filter(Boolean)) {
    // Strip "origin/"
    const name = branch.replace(/^origin\//, "");
    const known = Object.entries(knownPrefixes).find(([prefix]) =>
      name.startsWith(prefix)
    );
    if (known) {
      const [prefix, desc] = known;
      const entry = patterns.get(prefix) ?? { description: desc, count: 0 };
      entry.count++;
      patterns.set(prefix, entry);
    }
  }

  return Array.from(patterns.entries())
    .map(([prefix, data]) => ({
      prefix,
      description: data.description,
      usageCount: data.count,
    }))
    .sort((a, b) => b.usageCount - a.usageCount);
}

async function learnPRSize(workingDir: string): Promise<WorkflowProfile["prSize"]> {
  // Look at merge commits and their diff stats
  const merges = await gitExec(
    ["log", "--merges", "-30", "--format=%H"],
    workingDir
  ).catch(() => "");

  const hashList = merges.split("\n").filter(Boolean);
  const fileCounts: number[] = [];
  const lineChanges: number[] = [];

  for (const hash of hashList.slice(0, 20)) {
    try {
      const stat = await gitExec(
        ["diff", "--shortstat", `${hash}^1`, hash],
        workingDir
      );

      const filesMatch = stat.match(/(\d+) files? changed/);
      const linesMatch = stat.match(/(\d+) insertions?/);
      const delMatch = stat.match(/(\d+) deletions?/);

      if (filesMatch) fileCounts.push(Number(filesMatch[1]));
      const ins = linesMatch ? Number(linesMatch[1]) : 0;
      const del = delMatch ? Number(delMatch[1]) : 0;
      if (ins + del > 0) lineChanges.push(ins + del);
    } catch {
      // skip this merge
    }
  }

  return {
    medianFiles: percentile(fileCounts, 0.5),
    medianLines: percentile(lineChanges, 0.5),
    p75Files: percentile(fileCounts, 0.75),
    p75Lines: percentile(lineChanges, 0.75),
  };
}

async function learnMergePreference(
  workingDir: string
): Promise<WorkflowProfile["mergePreference"]> {
  const log = await gitExec(
    ["log", "-50", "--format=%s"],
    workingDir
  ).catch(() => "");

  let squash = 0;
  let merge = 0;
  let rebase = 0;

  for (const line of log.split("\n")) {
    if (line.includes("squash") || line.startsWith("(#")) squash++;
    else if (line.startsWith("Merge branch") || line.startsWith("Merge pull"))
      merge++;
    else rebase++;
  }

  return { squash, merge, rebase };
}

async function learnActiveHours(
  workingDir: string
): Promise<WorkflowProfile["activeHours"]> {
  const log = await gitExec(
    ["log", "-100", "--format=%ai"],
    workingDir
  ).catch(() => "");

  const hourCounts = new Map<number, number>();

  for (const line of log.split("\n").filter(Boolean)) {
    const hour = new Date(line).getHours();
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
  }

  return Array.from(hourCounts.entries())
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => b.count - a.count);
}

// ---- Helpers ----

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const arr = [...sorted].sort((a, b) => a - b);
  const idx = Math.floor(arr.length * p);
  return arr[Math.min(idx, arr.length - 1)];
}

function dominantMerge(merge: WorkflowProfile["mergePreference"]): {
  type: string;
  pct: number;
} {
  const total = merge.squash + merge.merge + merge.rebase;
  if (total === 0) return { type: "unknown", pct: 0 };

  if (merge.squash >= merge.merge && merge.squash >= merge.rebase) {
    return { type: "squash", pct: merge.squash / total };
  }
  if (merge.merge >= merge.rebase) {
    return { type: "merge", pct: merge.merge / total };
  }
  return { type: "rebase", pct: merge.rebase / total };
}

function emptyProfile(): WorkflowProfile {
  return {
    branchPatterns: [],
    prSize: { medianFiles: 0, medianLines: 0, p75Files: 0, p75Lines: 0 },
    mergePreference: { squash: 0, merge: 0, rebase: 0 },
    reviewerMappings: [],
    activeHours: [],
    updatedAt: new Date().toISOString(),
    observationCount: 0,
  };
}

function loadProfile(workingDir: string): WorkflowProfile | null {
  const filePath = path.join(workingDir, PROFILE_PATH);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // corrupted or unreadable
  }
  return null;
}

function saveProfile(workingDir: string, profile: WorkflowProfile): void {
  const filePath = path.join(workingDir, PROFILE_PATH);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf-8");
}
