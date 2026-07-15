// Git Newbie Guide — explains git concepts using current project context
// "用当前项目实例解释，而非教科书定义"

import type { GitState } from "./advisor.js";
import { getGitState } from "./advisor.js";

export interface ConceptExplanation {
  concept: string;
  shortAnswer: string;
  /** Concrete example using the user's current state */
  withCurrentState: string;
  /** Common pitfalls */
  pitfalls: string[];
  /** When to use vs alternatives */
  whenToUse: string;
}

/** Explain a git concept with the user's current repo state as examples */
export async function explainWithContext(
  workingDir: string,
  concept: string
): Promise<ConceptExplanation | null> {
  const state = await getGitState(workingDir);
  if (!state) return null;

  const normalized = concept.toLowerCase().trim();

  switch (normalized) {
    case "rebase":
    case "变基":
      return explainRebase(state);
    case "merge":
    case "合并":
      return explainMerge(state);
    case "stash":
    case "暂存":
      return explainStash(state);
    case "reset":
    case "重置":
      return explainReset(state);
    case "cherry-pick":
    case "cherry pick":
      return { concept: "cherry-pick", shortAnswer: "将某个特定提交'摘'到当前分支。", withCurrentState: "", pitfalls: [], whenToUse: "" };
    case "squash":
      return { concept: "squash", shortAnswer: "将多个提交压缩成一个。常用于 PR 提交前整理。", withCurrentState: "", pitfalls: [], whenToUse: "" };
    case "detached head":
    case "detached_head":
      return { concept: "detached HEAD", shortAnswer: "HEAD 指向一个具体的 commit 而不是分支，在游离状态下可以查看代码但不宜开发。", withCurrentState: "", pitfalls: [], whenToUse: "" };
    default:
      return explainGeneric(concept, state);
  }
}

// ---- Concept explanations ----

function explainRebase(state: GitState): ConceptExplanation {
  return {
    concept: "rebase（变基）",
    shortAnswer: "把你分支上的提交'搬'到目标分支最新提交之后，让历史看起来像一条直线。",
    withCurrentState: [
      `**你当前的情况：**`,
      ``,
      `- 你在 \`${state.branch}\` 分支上，领先 \`main\` ${state.aheadOfRemote} 个提交`,
      `- 如果 \`main\` 有新提交，rebase 会：`,
      `  1. 暂存你的 ${state.aheadOfRemote} 个提交`,
      `  2. 把 \`${state.branch}\` 更新到 \`main\` 最新位置`,
      `  3. 把你的提交逐个"重放"上去`,
      `- 结果：一条干净的直线历史`,
      ``,
      `\`\`\`bash`,
      `git fetch origin main`,
      `git rebase origin/main  # 在 ${state.branch} 上执行`,
      `\`\`\``,
    ].join("\n"),
    pitfalls: [
      "❌ 不要在共享分支上 rebase（如 main、develop），会搞乱队友的历史",
      "❌ rebase 后需要 force push（`git push --force-with-lease`），小心操作",
      "⚠️ rebase 过程中可能多次遇到冲突，每次解决后 `git rebase --continue`",
    ],
    whenToUse: "✅ 个人开发分支用 rebase 保持历史整洁；✅ PR 提交前用 rebase 整理 commit。",
  };
}

function explainMerge(state: GitState): ConceptExplanation {
  return {
    concept: "merge（合并）",
    shortAnswer: "把一个分支的所有提交合并到另一个分支，保留完整的分支历史。",
    withCurrentState: [
      `**你当前的情况：**`,
      ``,
      `- 你在 \`${state.branch}\` 分支上`,
      `- 如果想把 \`${state.branch}\` 合并到 \`main\`：`,
      `  1. 切换到 \`main\``,
      `  2. 执行 merge，Git 会创建一个 merge commit`,
      `- merge 有两种结果：`,
      `  - **Fast-forward**：如果 main 没有新提交，直接移动指针（不会产生 merge commit）`,
      `  - **三方合并**：如果两边都有新提交，Git 会尝试自动合并，失败则报冲突`,
      ``,
      `\`\`\`bash`,
      `git checkout main`,
      `git merge ${state.branch}`,
      `\`\`\``,
    ].join("\n"),
    pitfalls: [
      "⚠️ merge 会产生分叉再合并的历史，频繁 merge 会让 git log 很难看",
      "⚠️ merge commit 本身是一个提交，如果 CI 有严格要求（如'每个 commit 都要能编译'），需要确保 merge commit 也通过",
    ],
    whenToUse: "✅ 团队共享分支用 merge；✅ 功能分支合并到主分支用 merge（通常是 PR）；❌ 个人分支整理不建议用 merge。",
  };
}

function explainStash(state: GitState): ConceptExplanation {
  const fileCount = state.changedFiles.length;

  return {
    concept: "stash（暂存）",
    shortAnswer: "把当前所有未提交的改动暂存，工作区变干净，之后可以随时拿出来。",
    withCurrentState: [
      `**你当前的情况：**`,
      ``,
      `- \`${state.branch}\` 上有 ${fileCount} 个文件被修改`,
      `- 如果你突然需要切分支修 bug：`,
      `  1. \`git stash\` → ${fileCount} 个文件的改动保存到 stash 栈`,
      `  2. 工作区变干净了 → 可以自由切分支`,
      `  3. 修完 bug 回来：\`git stash pop\` → 恢复到刚才的状态`,
      ``,
      `\`\`\`bash`,
      `git stash              # 暂存所有改动`,
      `git stash save "desc"  # 带描述的暂存`,
      `git stash list         # 查看所有 stash`,
      `git stash pop          # 恢复最近一次 stash`,
      `git stash drop         # 丢弃最近一次 stash`,
      `\`\`\``,
    ].join("\n"),
    pitfalls: [
      "⚠️ stash 是栈结构，多次 stash 后要记得 pop 的顺序",
      "⚠️ stash 只在本地，不会 push 到远程",
      "⚠️ pop 时如果有冲突，Git 会停止，需要手动解决",
    ],
    whenToUse: "✅ 临时切分支；✅ pull 前暂存未提交的改动；❌ 不建议长期依赖 stash 保存重要代码。",
  };
}

function explainReset(state: GitState): ConceptExplanation {
  const recentHashes = state.recentCommits
    .slice(0, 3)
    .map((c) => `\`${c.hash}\` ${c.message}`)
    .join("\n  ");

  return {
    concept: "reset（重置）",
    shortAnswer: "将当前分支的 HEAD 移到一个指定的提交，有三种模式：soft（保留改动）、mixed（默认，取消暂存）、hard（全部丢弃）。",
    withCurrentState: [
      `**你当前的情况：**`,
      ``,
      `- 最近 3 个提交：`,
      `  ${recentHashes}`,
      ``,
      `- 三种 reset 模式：`,
      `  | 命令 | HEAD | 暂存区 | 工作目录 | 能恢复吗？ |`,
      `  |------|------|--------|----------|-----------|`,
      `  | \`--soft\`   | 移动 | 保留 | 保留 | ✅ 再 commit 就好 |`,
      `  | \`--mixed\`  | 移动 | 清空 | 保留 | ✅ 需要重新 add |`,
      `  | \`--hard\`   | 移动 | 清空 | 清空 | ❌ 不可恢复！ |`,
      ``,
      `💡 90% 的情况用 \`--soft\` 就够了。`,
    ].join("\n"),
    pitfalls: [
      "🚨 `git reset --hard` 不可逆！执行前确认有没有未推送的提交",
      "⚠️ 如果已经 push 了，不要 reset（改用 revert）",
      "⚠️ reset 后的提交没有消失（在 reflog 里），但 hard reset 的工作区改动确实丢了",
    ],
    whenToUse: "✅ 撤销最近的提交（--soft）；✅ 取消 git add（--mixed）；❌ 不要 reset 已推送的提交。",
  };
}

function explainGeneric(
  concept: string,
  state: GitState
): ConceptExplanation {
  return {
    concept,
    shortAnswer: `${concept} 的详细信息不在预置知识库中。`,
    withCurrentState: [
      `当前分支：\`${state.branch}\``,
      `变更文件：${state.changedFiles.length} 个`,
      `最近提交：`,
      ...state.recentCommits.slice(0, 3).map((c) => `  - \`${c.hash}\` ${c.message}`),
      ``,
      `你可以在当前项目的上下文中试验 \`${concept}\``,
    ].join("\n"),
    pitfalls: ["先用 `--dry-run` 试试效果", "不确定时先创建备份分支"],
    whenToUse: "先了解基本操作再在实际项目中使用",
  };
}

// ---- Quick lookup: detect if message is a git concept question ----

export function detectConceptQuestion(message: string): string | null {
  const patterns: Array<{ regex: RegExp; concept: string }> = [
    { regex: /rebase.*merge|merge.*rebase|rebase.*区别|merge.*区别/i, concept: "rebase" },
    { regex: /什么是.*rebase|rebase.*是什么|解释.*rebase|rebase.*意思/i, concept: "rebase" },
    { regex: /什么是.*merge|merge.*是什么|merge.*意思/i, concept: "merge" },
    { regex: /什么是.*stash|stash.*是什么|stash.*怎么/i, concept: "stash" },
    { regex: /什么是.*reset|reset.*是什么|reset.*怎么/i, concept: "reset" },
    { regex: /rebase|变基/i, concept: "rebase" },
    { regex: /stash|暂存/i, concept: "stash" },
    { regex: /cherry.?pick/i, concept: "cherry-pick" },
    { regex: /squash|压缩提交/i, concept: "squash" },
    { regex: /detached.?head/i, concept: "detached_head" },
  ];

  for (const { regex, concept } of patterns) {
    if (regex.test(message)) return concept;
  }

  return null;
}
