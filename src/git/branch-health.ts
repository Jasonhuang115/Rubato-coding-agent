// Branch Health Check — summarizes branch status at session start
// Shows which branches are stale, ahead/behind, and need attention

import { gitExec } from "./advisor.js";

export interface BranchHealth {
  branch: string;
  lastCommit: string;
  lastCommitDate: string;
  aheadOfMain: number;
  behindMain: number;
  status: "healthy" | "stale" | "needs_sync" | "ahead_only" | "unknown";
  recommendation: string;
}

export interface BranchHealthSummary {
  currentBranch: string;
  defaultBranch: string;
  branches: BranchHealth[];
  overallStatus: string;
}

export async function getBranchHealth(
  workingDir: string
): Promise<BranchHealthSummary | null> {
  try {
    const defaultBranch = await getDefaultBranch(workingDir);
    const currentBranch = await gitExec(["branch", "--show-current"], workingDir);

    // Get all local branches
    const branchList = await gitExec(
      ["branch", "--format=%(refname:short)|%(committerdate:short)|%(subject)"],
      workingDir
    );

    const branches: BranchHealth[] = [];

    for (const line of branchList.split("\n").filter(Boolean)) {
      const [name, date, subject] = line.split("|");
      if (name === defaultBranch) continue; // skip default branch

      const aheadBehind = await getAheadBehind(workingDir, name, defaultBranch);

      const daysSinceCommit = date
        ? Math.floor(
            (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24)
          )
        : 999;

      const { status, recommendation } = classifyBranch(
        aheadBehind.ahead,
        aheadBehind.behind,
        daysSinceCommit,
        name === currentBranch
      );

      branches.push({
        branch: name,
        lastCommit: subject ?? "",
        lastCommitDate: date ?? "",
        aheadOfMain: aheadBehind.ahead,
        behindMain: aheadBehind.behind,
        status,
        recommendation,
      });
    }

    // Sort: current first, then stale, then needs_sync
    const order = { healthy: 0, ahead_only: 1, stale: 2, needs_sync: 3, unknown: 4 };
    branches.sort((a, b) => {
      if (a.branch === currentBranch) return -1;
      if (b.branch === currentBranch) return 1;
      return order[a.status] - order[b.status];
    });

    return {
      currentBranch,
      defaultBranch,
      branches,
      overallStatus: summarizeOverall(branches),
    };
  } catch {
    return null;
  }
}

// ---- Helpers ----

async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const result = await gitExec(["remote", "show", "origin"], cwd);
    const match = result.match(/HEAD branch:\s*(.+)/);
    return match?.[1] ?? "main";
  } catch {
    return "main";
  }
}

async function getAheadBehind(
  cwd: string,
  branch: string,
  base: string
): Promise<{ ahead: number; behind: number }> {
  try {
    // First fetch to get latest
    await gitExec(["fetch", "origin", base], cwd);
    const result = await gitExec(
      ["rev-list", "--left-right", "--count", `${branch}...origin/${base}`],
      cwd
    );
    const [ahead, behind] = result.split("\t").map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

function classifyBranch(
  ahead: number,
  behind: number,
  daysSinceCommit: number,
  isCurrent: boolean
): { status: BranchHealth["status"]; recommendation: string } {
  if (behind > 5 && ahead === 0) {
    return {
      status: "needs_sync",
      recommendation: isCurrent
        ? "建议先 pull/rebase 最新代码"
        : `落后 main ${behind} 个提交，建议 rebase 后再开发`,
    };
  }

  if (daysSinceCommit > 14) {
    return {
      status: "stale",
      recommendation: isCurrent
        ? `⚠️ ${daysSinceCommit} 天未更新，确认这个分支还需要吗？`
        : `过期 ${daysSinceCommit} 天，如果不活跃可以删除`,
    };
  }

  if (behind > 0 && ahead > 0) {
    return {
      status: "needs_sync",
      recommendation: `领先 ${ahead} 但落后 ${behind}，建议 rebase`,
    };
  }

  if (ahead > 0 && behind === 0) {
    return {
      status: "ahead_only",
      recommendation: isCurrent
        ? "✅ 可以 push"
        : `领先 main ${ahead} 个提交，可考虑合并`,
    };
  }

  return {
    status: "healthy",
    recommendation: "✅ 状态良好",
  };
}

function summarizeOverall(branches: BranchHealth[]): string {
  const stale = branches.filter((b) => b.status === "stale").length;
  const needsSync = branches.filter((b) => b.status === "needs_sync").length;

  if (stale > 0 || needsSync > 0) {
    const parts = [];
    if (needsSync > 0) parts.push(`${needsSync} 个需要同步`);
    if (stale > 0) parts.push(`${stale} 个过期`);
    return `⚠️ ${parts.join("，")}`;
  }

  return "✅ 所有分支状态良好";
}
