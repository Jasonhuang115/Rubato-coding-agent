// Git Advisor — intercepts git-related user intent, explains before executing
// "信息型 + 顾问型，不是自动执行型" — 所有 Git 写操作必须用户确认
// Reuses gitExec pattern from context/git-status.ts

import { spawn } from "child_process";

// ---- Types ----

export interface GitState {
  branch: string;
  isRepo: boolean;
  status: string;
  aheadOfRemote: number;
  behindRemote: number;
  changedFiles: string[];
  recentCommits: Array<{ hash: string; message: string }>;
  remoteBranchExists: boolean;
}

export interface AdvisoryResult {
  /** The operation the user wants to perform */
  operation: string;
  /** Current repository state */
  state: GitState;
  /** Human-friendly explanation of what will happen */
  explanation: string;
  /** Risk level */
  risk: "low" | "medium" | "high" | "destructive";
  /** Suggested alternatives or next steps */
  options: string[];
  /** The actual git command that would run (shown for transparency) */
  proposedCommand: string;
}

// ---- Git state detection ----

export async function getGitState(workingDir: string): Promise<GitState | null> {
  if (!(await isGitRepo(workingDir))) return null;

  const branch = await gitExec(["branch", "--show-current"], workingDir).catch(() => "unknown");
  const status = await gitExec(["status", "--short"], workingDir).catch(() => "");
  const log = await gitExec(["log", "-5", "--format=%h|%s"], workingDir).catch(() => "");

  const aheadBehind = await getAheadBehind(workingDir, branch);
  const remoteExists = await remoteBranchExists(workingDir, branch);

  const changedFiles = status
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).trim());

  const recentCommits = log
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, ...msg] = l.split("|");
      return { hash, message: msg.join("|") };
    });

  return {
    branch,
    isRepo: true,
    status: status || "(clean)",
    aheadOfRemote: aheadBehind.ahead,
    behindRemote: aheadBehind.behind,
    changedFiles,
    recentCommits,
    remoteBranchExists: remoteExists,
  };
}

// ---- Advisory checks — one per git operation ----

export function adviseCommit(state: GitState, message?: string): AdvisoryResult {
  const stagedFiles = state.changedFiles.filter((f) => f.startsWith("M ") || f.startsWith("A "));
  const unstagedFiles = state.changedFiles.filter((f) => f.startsWith(" M") || f.startsWith("??"));

  const explanation = [
    `📋 **准备提交**`,
    ``,
    `当前分支：\`${state.branch}\``,
    ``,
    stagedFiles.length > 0
      ? `已暂存文件：\n${stagedFiles.map((f) => `  - ${f}`).join("\n")}`
      : `没有已暂存的文件。`,
    ``,
    unstagedFiles.length > 0
      ? `⚠️ 还有 ${unstagedFiles.length} 个文件未暂存：\n${unstagedFiles.map((f) => `  - ${f}`).join("\n")}`
      : ``,
    ``,
    `💡 这意味着：`,
    `- git commit 会创建一个新的提交记录，包含所有已暂存的变更`,
    `- 这个提交只在你本地，不会影响其他人`,
    `- 提交信息会出现在 git log 中，建议写清楚「做了什么」和「为什么」`,
  ].filter(Boolean).join("\n");

  return {
    operation: "commit",
    state,
    explanation,
    risk: "low",
    options: [
      "先看看具体改动内容 /diff",
      "添加所有文件后提交",
      "只提交部分文件（暂存 → 提交）",
      message ? `直接提交："${message}"` : "告诉我提交信息",
    ],
    proposedCommand: message
      ? `git commit -m "${message}"`
      : `git commit`,
  };
}

export function advisePush(state: GitState): AdvisoryResult {
  let risk: AdvisoryResult["risk"] = "low";
  const warnings: string[] = [];

  if (state.behindRemote > 0) {
    risk = "high";
    warnings.push(`⚠️ 远程分支领先本地 ${state.behindRemote} 个提交，push 会被拒绝。需要先 pull。`);
  }
  if (state.aheadOfRemote > 5) {
    risk = "medium";
    warnings.push(`⚠️ 你将一次性推送 ${state.aheadOfRemote} 个提交。`);
  }

  const explanation = [
    `📋 **准备推送**`,
    ``,
    `分支：\`${state.branch}\` → \`origin/${state.branch}\``,
    `本地领先远程：${state.aheadOfRemote} 个提交`,
    `远程领先本地：${state.behindRemote} 个提交`,
    ``,
    ...warnings,
    ``,
    `💡 这意味着：`,
    `- git push 会将你本地的提交上传到远程仓库`,
    `- 推送后团队其他成员就能看到和拉取你的代码`,
    `- ${state.remoteBranchExists ? "远程分支已存在，会追加你的提交" : "这会创建一个新的远程分支"}`,
  ].join("\n");

  return {
    operation: "push",
    state,
    explanation,
    risk,
    options: [
      "先看看要推送的提交内容 /diff",
      "先运行测试确保没问题",
      "先 fetch 检查远程是否有冲突",
      "直接 push",
    ],
    proposedCommand: `git push origin ${state.branch}`,
  };
}

export function advisePull(state: GitState): AdvisoryResult {
  const hasLocalChanges = state.changedFiles.length > 0;

  const explanation = [
    `📋 **准备拉取**`,
    ``,
    `分支：\`${state.branch}\``,
    `本地有 ${state.changedFiles.length} 个未提交的文件`,
    ``,
    hasLocalChanges
      ? `⚠️ 你有未提交的改动。如果远程更新了相同的文件，Git 会阻止 pull。`
      : `✅ 工作区干净，可以直接 pull。`,
    ``,
    `💡 这意味着：`,
    `- git pull 从远程下载最新代码并合并到你的分支`,
    `- 如果有冲突，需要手动解决`,
    `- pull = fetch + merge，如果你更想 rebase，用 \`git pull --rebase\``,
  ].join("\n");

  return {
    operation: "pull",
    state,
    explanation,
    risk: hasLocalChanges ? "medium" : "low",
    options: [
      "先 stash 本地改动再 pull",
      "先 commit 本地改动再 pull",
      "直接 pull（Git 会处理）",
      "用 rebase 方式 pull",
    ],
    proposedCommand: `git pull origin ${state.branch}`,
  };
}

export function adviseMerge(state: GitState, targetBranch: string): AdvisoryResult {
  const explanation = [
    `📋 **准备合并**`,
    ``,
    `从 \`${state.branch}\` → \`${targetBranch}\``,
    ``,
    `💡 这意味着：`,
    `- 会将 \`${state.branch}\` 的所有提交合并到 \`${targetBranch}\``,
    `- 如果两个分支都改了相同文件，会产生合并冲突`,
    `- 合并后会创建一个 merge commit（除非用 fast-forward）`,
    ``,
    `建议：`,
    `- 先确认 \`${targetBranch}\` 是最新的`,
    `- 考虑先 rebase 再 merge（保持历史整洁）`,
    `- 确认测试通过后再 merge`,
  ].join("\n");

  return {
    operation: "merge",
    state,
    explanation,
    risk: "medium",
    options: [
      `先看看 ${state.branch} 比 ${targetBranch} 多了什么 /diff`,
      `直接在 GitHub 上创建 PR`,
      `先 rebase 再 merge`,
      "确认 merge",
    ],
    proposedCommand: `git checkout ${targetBranch} && git merge ${state.branch}`,
  };
}

// ---- Destructive operation warnings ----

export function adviseDestructive(
  command: string,
  state: GitState
): AdvisoryResult {
  const explanation = [
    `🚨 **危险操作警告**`,
    ``,
    `你即将执行：\`${command}\``,
    ``,
    `当前分支：\`${state.branch}\``,
    `未提交的文件：${state.changedFiles.length} 个`,
    ``,
    `⚠️ 这个操作不可逆！可能导致：`,
    `- 丢失未推送的提交`,
    `- 丢失未提交的文件改动`,
    `- 历史记录改变（如果涉及 force）`,
    ``,
    `建议先备份当前状态：`,
    `  git branch backup-${state.branch}-$(date +%Y%m%d)`,
  ].join("\n");

  return {
    operation: command,
    state,
    explanation,
    risk: "destructive",
    options: [
      "取消操作",
      "先创建备份分支",
      "先 push 到远程",
      "确认执行（我了解风险）",
    ],
    proposedCommand: command,
  };
}

// ---- Utility: explain a git concept in plain language ----

export function explainConcept(
  concept: string,
  state: GitState
): string {
  const templates: Record<string, string> = {
    rebase: [
      `**git rebase** — 变基`,
      ``,
      `想象你在写一篇文章，你从第二章开始写了 3 段。同时原作者修改了第一章。`,
      `rebase 就是：把你写的 3 段"搬"到修改后的第一章后面，看起来像你从一开始就在新版本上写。`,
      ``,
      `你的情况：`,
      `- 你在 \`${state.branch}\` 上有 ${state.aheadOfRemote} 个提交`,
      `- 如果 main 有新提交，rebase 会让你的提交排在最新位置`,
      `- 结果：一条直线历史，没有分叉`,
      ``,
      `vs merge：会产生一个"合并提交"，历史会有分叉再合并的形状。`,
      `💡 建议：个人分支用 rebase 保持历史整洁；团队共享分支用 merge。`,
    ].join("\n"),

    "stash": [
      `**git stash** — 暂存工作区`,
      ``,
      `你正在写代码，突然需要切分支修 bug，但不想提交当前的半成品。`,
      `stash 就像是把你当前所有的改动"保存到抽屉里"，工作区变干净。`,
      `修完 bug 后，\`git stash pop\` 从抽屉里拿出来继续写。`,
      ``,
      `你的情况：`,
      `- 当前 \`${state.branch}\` 上有 ${state.changedFiles.length} 个文件被修改`,
      `- \`git stash\` → 所有改动暂存 → 工作区干净`,
      `- \`git stash pop\` → 恢复刚才的改动`,
    ].join("\n"),

    "reset": [
      `**git reset** — 重置到某个历史状态`,
      ``,
      `\`git reset --soft\` → 撤销提交但保留改动（像没 commit 过）`,
      `\`git reset --mixed\`（默认）→ 撤销提交 + 取消暂存，保留文件改动`,
      `\`git reset --hard\` → ⚠️ 全部丢弃！不可恢复！`,
      ``,
      `你的情况：`,
      `- 最近提交：${state.recentCommits.slice(0, 3).map((c) => `\`${c.hash}\` ${c.message}`).join("\n  ")}`,
      `- 💡 90% 的情况用 \`--soft\` 就够了`,
    ].join("\n"),
  };

  return (
    templates[concept.toLowerCase()] ??
    `抱歉，我没有 \`${concept}\` 的预置解释。你想了解它的什么方面？`
  );
}

// ---- Git exec helpers (reused across all git/*.ts) ----

export function gitExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args[0]} exited with ${code}`));
    });

    child.on("error", reject);
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await gitExec(["rev-parse", "--git-dir"], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    return await gitExec(["branch", "--show-current"], cwd);
  } catch {
    return "unknown";
  }
}

// ---- Internal helpers ----

async function getAheadBehind(
  cwd: string,
  branch: string
): Promise<{ ahead: number; behind: number }> {
  try {
    const result = await gitExec(
      ["rev-list", "--left-right", "--count", `${branch}...origin/${branch}`],
      cwd
    );
    const [ahead, behind] = result.split("\t").map(Number);
    return { ahead: ahead || 0, behind: behind || 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

async function remoteBranchExists(
  cwd: string,
  branch: string
): Promise<boolean> {
  try {
    await gitExec(["rev-parse", `origin/${branch}`], cwd);
    return true;
  } catch {
    return false;
  }
}
