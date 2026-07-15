// Intent Verification — "你说了要改 A，怎么还改了 B？"
// Before commit/push, compares changed files against the active plan
// Works with Grill Me's intention tree to catch WIP creep

import { gitExec } from "./advisor.js";
import type { PlanDoc } from "../plan/tree.js";

export interface IntentVerification {
  /** Overall assessment */
  matchesIntent: boolean;
  /** Files classified by relevance */
  relevant: string[];
  suspicious: string[];
  unrelated: string[];
  /** Per-file explanations */
  fileExplanations: Array<{
    file: string;
    status: "relevant" | "suspicious" | "unrelated";
    reason: string;
  }>;
  /** Suggestion for commit message */
  suggestedMessage?: string;
  /** Warning message if any */
  warning?: string;
}

/** Verify that changed files match the active plan's intent */
export async function verifyIntent(
  workingDir: string,
  plan: PlanDoc | null
): Promise<IntentVerification | null> {
  // Get changed files
  const changed = await getStagedOrUnstagedFiles(workingDir);
  if (changed.length === 0) return null;

  const explanations: IntentVerification["fileExplanations"] = [];
  const relevant: string[] = [];
  const suspicious: string[] = [];
  const unrelated: string[] = [];

  for (const file of changed) {
    const assessment = assessFileIntent(file, plan);
    explanations.push(assessment);

    switch (assessment.status) {
      case "relevant":
        relevant.push(file);
        break;
      case "suspicious":
        suspicious.push(file);
        break;
      case "unrelated":
        unrelated.push(file);
        break;
    }
  }

  const matchesIntent = suspicious.length === 0 && unrelated.length === 0;

  let warning: string | undefined;
  if (!matchesIntent) {
    const parts: string[] = [];
    if (suspicious.length > 0) {
      parts.push(
        `⚠️ ${suspicious.length} 个文件不在当前计划范围内：`,
        ...suspicious.map((f) => `  - ${f}`)
      );
    }
    if (unrelated.length > 0) {
      parts.push(
        `❓ ${unrelated.length} 个文件与计划无关：`,
        ...unrelated.map((f) => `  - ${f}`)
      );
    }
    if (plan) {
      parts.push(`\n当前计划：「${plan.title}」`);
      parts.push(`计划范围：${plan.files.join(", ")}`);
    }
    parts.push(
      ``,
      `建议：`,
      suspicious.length > 0 ? `  - 可疑文件：确认是否确实属于当前任务，如果是，更新计划文件列表` : ``,
      unrelated.length > 0 ? `  - 无关文件：stash 掉，单独提交；或在 commit message 中解释原因` : ``,
    );
    warning = parts.filter(Boolean).join("\n");
  }

  // Generate suggested commit message
  const suggestedMessage = plan
    ? generateCommitMessage(plan, relevant)
    : undefined;

  return {
    matchesIntent,
    relevant,
    suspicious,
    unrelated,
    fileExplanations: explanations,
    suggestedMessage,
    warning,
  };
}

// ---- File assessment ----

function assessFileIntent(
  file: string,
  plan: PlanDoc | null
): { file: string; status: "relevant" | "suspicious" | "unrelated"; reason: string } {
  if (!plan) {
    return {
      file,
      status: "relevant",
      reason: "无活跃计划，无法验证",
    };
  }

  // 1. Direct match: file is in plan's files list
  if (plan.files.some((f) => matchesFile(file, f))) {
    return { file, status: "relevant", reason: "在计划文件列表中" };
  }

  // 2. Semantic match: file name/path shares keywords with plan title/goal
  const planKeywords = extractKeywords(plan.title + " " + plan.goal);
  const fileKeywords = extractKeywords(file);

  const overlap = planKeywords.filter((k) => fileKeywords.includes(k));
  if (overlap.length >= 2) {
    return {
      file,
      status: "relevant",
      reason: `与计划关键词相关：${overlap.join(", ")}`,
    };
  }

  // 3. Patterns that are often unrelated but acceptable
  if (file === "package.json" || file.includes("node_modules")) {
    return {
      file,
      status: "suspicious",
      reason: "依赖变更 — 可能和当前任务相关，但需要确认",
    };
  }

  if (file.endsWith(".test.ts") || file.endsWith(".test.js") || file.endsWith("_test.py")) {
    // Test files are likely related if the source file is in plan
    const sourceFile = file
      .replace(".test", "")
      .replace("__tests__/", "")
      .replace("test/", "src/");
    if (plan.files.some((f) => matchesFile(sourceFile, f))) {
      return { file, status: "relevant", reason: "关联的测试文件" };
    }
  }

  // 4. Common accidental inclusions
  if (file.endsWith(".log") || file.includes(".DS_Store") || file.includes("thumbs.db")) {
    return {
      file,
      status: "unrelated",
      reason: "临时/系统文件，不应提交",
    };
  }

  // 5. Default: suspicious
  return {
    file,
    status: "suspicious",
    reason: overlap.length === 1
      ? `仅与计划关键词「${overlap[0]}」部分匹配`
      : "未在计划中找到关联",
  };
}

// ---- Helpers ----

async function getStagedOrUnstagedFiles(workingDir: string): Promise<string[]> {
  try {
    // Get staged + unstaged files
    const staged = await gitExec(["diff", "--cached", "--name-only"], workingDir).catch(() => "");
    const unstaged = await gitExec(["diff", "--name-only"], workingDir).catch(() => "");
    const untracked = await gitExec(
      ["ls-files", "--others", "--exclude-standard"],
      workingDir
    ).catch(() => "");

    return [
      ...staged.split("\n").filter(Boolean),
      ...unstaged.split("\n").filter(Boolean),
      ...untracked.split("\n").filter(Boolean),
    ].filter((f, i, arr) => arr.indexOf(f) === i);
  } catch {
    return [];
  }
}

function matchesFile(actualFile: string, planFile: string): boolean {
  // Direct match or prefix match (plan says "src/auth/" and file is "src/auth/login.ts")
  return (
    actualFile.startsWith(planFile) ||
    planFile.startsWith(actualFile) ||
    actualFile.includes(planFile) ||
    planFile.includes(actualFile)
  );
}

function extractKeywords(text: string): string[] {
  const cleaned = text
    .replace(/[.,!?;:'"()\[\]{}，。！？；：、""''（）【】《》\n\r\t]/g, " ")
    .toLowerCase()
    .trim();

  const words = cleaned.split(/\s+/).filter((w) => w.length > 2);
  const commonWords = new Set(["the", "and", "for", "the", "are", "with", "that"]);

  return words.filter((w) => !commonWords.has(w));
}

function generateCommitMessage(plan: PlanDoc, files: string[]): string {
  const scope = plan.title.slice(0, 50);
  const fileCount = files.length;
  return `${scope} (${fileCount} files)`;
}
