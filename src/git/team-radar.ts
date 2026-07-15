// Team Radar — "小心，张三也在改同一个文件"
// Detects potential merge conflicts by analyzing remote branches
// Pure local analysis, no external services needed

import { gitExec } from "./advisor.js";

export interface CollisionWarning {
  /** The file that has overlapping edits */
  file: string;
  /** Other branch that touches it */
  branch: string;
  /** Author of the other branch */
  author: string;
  /** When they last committed */
  lastCommit: string;
  /** How many lines they changed */
  changeSize: number;
  /** Risk level */
  risk: "low" | "medium" | "high";
  /** Human-readable explanation */
  explanation: string;
}

export interface TeamRadarResult {
  /** Current branch */
  currentBranch: string;
  /** Files you changed */
  yourFiles: string[];
  /** Potential collisions found */
  collisions: CollisionWarning[];
  /** Summary for display */
  summary: string;
}

/** Scan remote branches for potential conflicts with your changes */
export async function scanTeamRadar(
  workingDir: string
): Promise<TeamRadarResult | null> {
  try {
    const currentBranch = await gitExec(
      ["branch", "--show-current"],
      workingDir
    );

    // Fetch all remotes to get latest
    await gitExec(["fetch", "--all"], workingDir).catch(() => {});

    // Get your changed files
    const yourFiles = await getModifiedFiles(workingDir);

    // Get all remote branches (excluding yours)
    const remoteBranches = await getRemoteBranches(workingDir, currentBranch);

    const collisions: CollisionWarning[] = [];

    for (const remoteBranch of remoteBranches.slice(0, 20)) {
      try {
        // Get files modified on the remote branch vs its base
        const remoteFiles = await getBranchFiles(workingDir, remoteBranch);

        const overlap = yourFiles.filter((f) =>
          remoteFiles.some((rf) => rf === f || isSameModule(f, rf))
        );

        if (overlap.length > 0) {
          const author = await getAuthor(workingDir, remoteBranch);
          const lastCommit = await getLastCommitDate(workingDir, remoteBranch);
          const changeSize = await getChangeSize(workingDir, remoteBranch, overlap);

          const risk = assessCollisionRisk(overlap.length, changeSize, lastCommit);

          collisions.push({
            file: overlap[0], // most significant overlap
            branch: remoteBranch,
            author,
            lastCommit,
            changeSize,
            risk,
            explanation: buildCollisionExplanation(
              overlap,
              remoteBranch,
              author,
              lastCommit,
              risk
            ),
          });
        }
      } catch {
        // Skip branches we can't analyze
      }
    }

    // Sort by risk
    collisions.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.risk] - order[b.risk];
    });

    return {
      currentBranch,
      yourFiles,
      collisions,
      summary: summarizeCollisions(collisions),
    };
  } catch {
    return null;
  }
}

// ---- File hotspot analysis ----

export interface FileHotspot {
  file: string;
  recentAuthors: string[];
  commitCount: number;
  lastModified: string;
  risk: "low" | "medium" | "high";
}

/** Identify files that have been modified frequently by multiple people */
export async function getFileHotspots(
  workingDir: string,
  daysBack = 7
): Promise<FileHotspot[]> {
  try {
    const since = new Date(
      Date.now() - daysBack * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10);

    const log = await gitExec(
      ["log", "--since", since, "--format=%an|%ai", "--name-only"],
      workingDir
    );

    const fileAuthors = new Map<string, { authors: Set<string>; count: number; lastDate: string }>();

    let currentAuthor = "";
    let currentDate = "";

    for (const line of log.split("\n")) {
      const authorMatch = line.match(/^([^|]+)\|(.+)/);
      if (authorMatch) {
        currentAuthor = authorMatch[1].trim();
        currentDate = authorMatch[2].trim();
        continue;
      }

      const file = line.trim();
      if (!file) continue;

      const entry = fileAuthors.get(file) ?? {
        authors: new Set<string>(),
        count: 0,
        lastDate: currentDate,
      };
      entry.authors.add(currentAuthor);
      entry.count++;
      fileAuthors.set(file, entry);
    }

    const hotspots: FileHotspot[] = [];
    for (const [file, data] of fileAuthors) {
      if (data.authors.size >= 2) {
        hotspots.push({
          file,
          recentAuthors: Array.from(data.authors),
          commitCount: data.count,
          lastModified: data.lastDate,
          risk:
            data.authors.size >= 4
              ? "high"
              : data.authors.size >= 3
              ? "medium"
              : "low",
        });
      }
    }

    hotspots.sort((a, b) => b.commitCount - a.commitCount);
    return hotspots.slice(0, 10);
  } catch {
    return [];
  }
}

// ---- Helpers ----

async function getModifiedFiles(cwd: string): Promise<string[]> {
  try {
    const diff = await gitExec(
      ["diff", "--name-only", "HEAD"],
      cwd
    );
    const staged = await gitExec(
      ["diff", "--cached", "--name-only"],
      cwd
    ).catch(() => "");
    return [...new Set([...diff.split("\n"), ...staged.split("\n")].filter(Boolean))];
  } catch {
    return [];
  }
}

async function getRemoteBranches(
  cwd: string,
  excludeBranch: string
): Promise<string[]> {
  const output = await gitExec(
    ["branch", "-r", "--format=%(refname:short)"],
    cwd
  );
  return output
    .split("\n")
    .filter(Boolean)
    .filter((b) => !b.includes(excludeBranch) && !b.endsWith("/HEAD"))
    .filter((b) => b.startsWith("origin/"));
}

async function getBranchFiles(
  cwd: string,
  branch: string
): Promise<string[]> {
  const defaultBranch = await getDefaultBranch(cwd);
  const diff = await gitExec(
    ["diff", "--name-only", `origin/${defaultBranch}`, branch],
    cwd
  );
  return diff.split("\n").filter(Boolean);
}

async function getAuthor(cwd: string, branch: string): Promise<string> {
  try {
    return await gitExec(
      ["log", "-1", "--format=%an", branch],
      cwd
    );
  } catch {
    return "unknown";
  }
}

async function getLastCommitDate(cwd: string, branch: string): Promise<string> {
  try {
    return await gitExec(
      ["log", "-1", "--format=%ar", branch],
      cwd
    );
  } catch {
    return "unknown";
  }
}

async function getChangeSize(
  cwd: string,
  branch: string,
  files: string[]
): Promise<number> {
  try {
    const defaultBranch = await getDefaultBranch(cwd);
    let total = 0;
    for (const file of files.slice(0, 5)) {
      const stat = await gitExec(
        ["diff", "--shortstat", `origin/${defaultBranch}`, branch, "--", file],
        cwd
      ).catch(() => "");
      const match = stat.match(/(\d+) change/);
      if (match) total += Number(match[1]);
    }
    return total;
  } catch {
    return 0;
  }
}

async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const result = await gitExec(
      ["remote", "show", "origin"],
      cwd
    );
    const match = result.match(/HEAD branch:\s*(.+)/);
    return match?.[1] ?? "main";
  } catch {
    return "main";
  }
}

function isSameModule(a: string, b: string): boolean {
  // Same directory = same module
  const dirA = a.split("/").slice(0, -1).join("/");
  const dirB = b.split("/").slice(0, -1).join("/");
  return dirA === dirB;
}

function assessCollisionRisk(
  overlapCount: number,
  changeSize: number,
  lastCommit: string
): CollisionWarning["risk"] {
  const hoursMatch = lastCommit.match(/(\d+)\s+hour/);
  const minutesMatch = lastCommit.match(/(\d+)\s+minute/);
  const daysMatch = lastCommit.match(/(\d+)\s+day/);

  const isRecent = hoursMatch !== null || minutesMatch !== null || (daysMatch && Number(daysMatch[1]) <= 1);

  if (overlapCount >= 3 && changeSize > 200 && isRecent) return "high";
  if (overlapCount >= 2 || (changeSize > 100 && isRecent)) return "medium";
  return "low";
}

function buildCollisionExplanation(
  overlap: string[],
  branch: string,
  author: string,
  lastCommit: string,
  risk: string
): string {
  const fileList = overlap.slice(0, 3).join("、");

  if (risk === "high") {
    return (
      `🚨 \`${branch}\`（${author}，${lastCommit} 提交）也修改了 ${fileList}。` +
      `重叠度较高，建议 push 前先和 ${author} 沟通，或者先 rebase 到最新。`
    );
  }

  if (risk === "medium") {
    return (
      `⚠️ \`${branch}\`（${author}，${lastCommit} 提交）修改了 ${fileList}。` +
      `建议 push 后通知 ${author}，他可能需要处理冲突。`
    );
  }

  return (
    `💡 \`${branch}\`（${author}）也动了 ${fileList}，重叠度较低，但建议留意。`
  );
}

function summarizeCollisions(collisions: CollisionWarning[]): string {
  if (collisions.length === 0) {
    return "✅ 未发现冲突风险。";
  }

  const high = collisions.filter((c) => c.risk === "high");
  const medium = collisions.filter((c) => c.risk === "medium");

  if (high.length > 0) {
    const authors = [...new Set(high.map((c) => c.author))];
    return (
      `🚨 ${high.length} 个高风险冲突！` +
      `涉及 ${authors.join("、")}，建议 push 前先沟通。`
    );
  }

  if (medium.length > 0) {
    return `⚠️ ${medium.length} 个中等风险冲突，建议留意。`;
  }

  return `💡 ${collisions.length} 个低风险重叠，一般不需要特殊处理。`;
}
