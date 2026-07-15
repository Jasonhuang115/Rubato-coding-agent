// Pre-flight Check — runs before git push to warn about potential issues
// Checks: remote ahead/behind, other branches touching same files, test status

import { gitExec, getCurrentBranch } from "./advisor.js";

export interface PreflightResult {
  /** Is it safe to push? */
  safe: boolean;
  /** Warnings grouped by severity */
  warnings: Array<{ level: "info" | "warning" | "error"; message: string }>;
  /** Suggested commands to run before pushing */
  recommendations: string[];
}

export async function runPreflight(workingDir: string): Promise<PreflightResult | null> {
  const branch = await getCurrentBranch(workingDir).catch(() => null);
  if (!branch) return null;

  const warnings: PreflightResult["warnings"] = [];
  const recommendations: string[] = [];

  // 1. Check if main/master has new commits (need rebase)
  try {
    const defaultBranch = await getDefaultBranch(workingDir);
    await gitExec(["fetch", "origin", defaultBranch], workingDir);

    const behindMain = await gitExec(
      ["rev-list", "--count", `${branch}..origin/${defaultBranch}`],
      workingDir
    ).then(Number).catch(() => 0);

    if (behindMain > 0) {
      warnings.push({
        level: "warning",
        message: `\`${defaultBranch}\` 在你上次同步后有 ${behindMain} 个新提交，你的分支可能需要 rebase`,
      });
      recommendations.push(`git fetch origin ${defaultBranch} && git rebase origin/${defaultBranch}`);
    }
  } catch {
    // No remote or no default branch — skip
  }

  // 2. Check for uncommitted changes
  try {
    const status = await gitExec(["status", "--porcelain"], workingDir);
    if (status) {
      const fileCount = status.split("\n").filter(Boolean).length;
      warnings.push({
        level: "warning",
        message: `有 ${fileCount} 个文件未提交，push 不会包含它们`,
      });
      recommendations.push("先 git add + git commit，或者 git stash");
    }
  } catch {
    // skip
  }

  // 3. Look for other local branches that touch the same files
  try {
    const currentFiles = await getModifiedFiles(workingDir);

    // Get other local branches
    const allBranches = await gitExec(["branch", "--format=%(refname:short)"], workingDir);
    const otherBranches = allBranches
      .split("\n")
      .filter(Boolean)
      .filter((b) => b !== branch && !b.startsWith("origin/"));

    for (const otherBranch of otherBranches.slice(0, 5)) {
      try {
        const otherFiles = await getBranchModifiedFiles(workingDir, otherBranch);
        const overlap = currentFiles.filter((f) => otherFiles.includes(f));

        if (overlap.length > 0) {
          warnings.push({
            level: "warning",
            message: `⚠️ 分支 \`${otherBranch}\` 也修改了 ${overlap.length} 个相同文件（${overlap.slice(0, 3).join(", ")}），合并时可能冲突`,
          });
          recommendations.push(`和 \`${otherBranch}\` 的作者确认改动范围`);
        }
      } catch {
        // skip this branch
      }
    }
  } catch {
    // skip
  }

  return {
    safe: warnings.filter((w) => w.level === "error").length === 0,
    warnings,
    recommendations: [...new Set(recommendations)],
  };
}

// ---- Helpers ----

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

async function getModifiedFiles(cwd: string): Promise<string[]> {
  try {
    const diff = await gitExec(["diff", "--name-only", "HEAD"], cwd);
    return diff.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function getBranchModifiedFiles(
  cwd: string,
  branch: string
): Promise<string[]> {
  try {
    // Files that differ between this branch and main
    const defaultBranch = await getDefaultBranch(cwd);
    const diff = await gitExec(
      ["diff", "--name-only", `${branch}`, `origin/${defaultBranch}`],
      cwd
    );
    return diff.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
