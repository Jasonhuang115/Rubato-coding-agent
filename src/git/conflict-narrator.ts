// Conflict Narrator — tells the story of both sides of a merge conflict
// "你的分支做了什么" vs "目标分支做了什么" vs "为什么冲突" + suggestions

import { gitExec } from "./advisor.js";

export interface ConflictNarrative {
  /** The file with conflicts */
  file: string;
  /** Story from your branch's perspective */
  yourSide: BranchStory;
  /** Story from the target branch's perspective */
  theirSide: BranchStory;
  /** Why the conflict happened */
  rootCause: string;
  /** Resolution suggestions */
  suggestions: ConflictSuggestion[];
  /** Full markdown narrative */
  narrative: string;
}

export interface BranchStory {
  branch: string;
  changes: string[];
  keyCommits: Array<{ hash: string; message: string; date: string }>;
  summary: string;
}

export interface ConflictSuggestion {
  label: string;
  description: string;
  /** "keep_yours", "keep_theirs", "merge_both" */
  strategy: string;
}

/** Generate a full conflict narrative */
export async function narrateConflict(
  workingDir: string,
  file: string,
  yourBranch: string,
  theirBranch: string
): Promise<ConflictNarrative | null> {
  try {
    // Get both sides' stories
    const yourSide = await buildBranchStory(workingDir, file, yourBranch, theirBranch);
    const theirSide = await buildBranchStory(workingDir, file, theirBranch, yourBranch);

    // Determine root cause
    const rootCause = analyzeRootCause(yourSide, theirSide, file);

    // Generate suggestions
    const suggestions = generateSuggestions(yourSide, theirSide, file);

    const narrative = buildNarrative(file, yourSide, theirSide, rootCause, suggestions);

    return {
      file,
      yourSide,
      theirSide,
      rootCause,
      suggestions,
      narrative,
    };
  } catch {
    return null;
  }
}

/** Quick check: are there any conflicts in the working tree? */
export async function hasConflicts(workingDir: string): Promise<boolean> {
  try {
    const status = await gitExec(
      ["status", "--porcelain"],
      workingDir
    );
    return status.includes("UU ") || status.includes("AA ") || status.includes("DD ");
  } catch {
    return false;
  }
}

/** List conflicted files */
export async function listConflictedFiles(workingDir: string): Promise<string[]> {
  try {
    const diff = await gitExec(
      ["diff", "--name-only", "--diff-filter=U"],
      workingDir
    );
    return diff.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ---- Internal ----

async function buildBranchStory(
  workingDir: string,
  file: string,
  branch: string,
  baseBranch: string
): Promise<BranchStory> {
  // Get commits that modified this file on the branch (not on base)
  const log = await gitExec(
    [
      "log",
      `${baseBranch}..${branch}`,
      "--format=%h|%s|%ai",
      "--",
      file,
    ],
    workingDir
  ).catch(() => "");

  const keyCommits = log
    .split("\n")
    .filter(Boolean)
    .slice(0, 5)
    .map((line) => {
      const [hash, ...rest] = line.split("|");
      const date = rest.slice(-1)[0] ?? "";
      const message = rest.slice(0, -1).join("|");
      return { hash, message, date: date.slice(0, 10) };
    });

  // Get the actual diff to understand what changed
  const diff = await gitExec(
    ["diff", `${baseBranch}...${branch}`, "--", file],
    workingDir
  ).catch(() => "");

  const changes = summarizeDiff(diff);

  let summary: string;
  if (keyCommits.length === 0) {
    summary = `\`${branch}\` 分支没有直接修改 \`${file}\`。冲突可能是由合并策略或文件重命名引起的。`;
  } else if (keyCommits.length === 1) {
    summary = `\`${branch}\` 分支在 ${keyCommits[0].date} 修改了 ${file}（${keyCommits[0].message}）。`;
  } else {
    summary = `\`${branch}\` 分支在 ${keyCommits.length} 个提交中修改了 ${file}，最新的是 ${keyCommits[0].date} 的「${keyCommits[0].message}」。`;
  }

  return {
    branch,
    changes,
    keyCommits,
    summary,
  };
}

function summarizeDiff(diff: string): string[] {
  const changes: string[] = [];
  const lines = diff.split("\n");

  let addedFunc = "";
  let removedFunc = "";

  for (const line of lines) {
    // Detect function/class additions
    const addMatch = line.match(/^\+\s*(?:function|class|const|let|var|interface|type|export)\s+(\w+)/);
    if (addMatch) {
      addedFunc = addMatch[1];
      changes.push(`新增：${addedFunc}`);
    }

    const delMatch = line.match(/^-\s*(?:function|class|const|let|var|interface|type|export)\s+(\w+)/);
    if (delMatch) {
      removedFunc = delMatch[1];
      changes.push(`删除：${removedFunc}`);
    }

    // Rename detection
    if (addedFunc && removedFunc && addedFunc !== removedFunc) {
      changes.push(`重命名：${removedFunc} → ${addedFunc}`);
    }
  }

  // Fallback: count lines
  if (changes.length === 0) {
    const additions = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const deletions = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    if (additions + deletions > 0) {
      changes.push(`${additions} 行增加，${deletions} 行删除`);
    }
  }

  return changes;
}

function analyzeRootCause(
  your: BranchStory,
  theirs: BranchStory,
  file: string
): string {
  // Both touched the same function/area
  const yourFuncs = extractFunctions(your.changes);
  const theirFuncs = extractFunctions(theirs.changes);
  const overlap = yourFuncs.filter((f) => theirFuncs.includes(f));

  if (overlap.length > 0) {
    return `两个分支都修改了 \`${overlap[0]}\`（以及相关的代码逻辑），导致同一段代码有两个不同版本。`;
  }

  if (your.keyCommits.length === 0 && theirs.keyCommits.length > 0) {
    return `\`${theirs.branch}\` 对 \`${file}\` 进行了重构或大幅修改，\`${your.branch}\` 引用的旧版本代码已不存在。`;
  }

  if (theirs.keyCommits.length === 0 && your.keyCommits.length > 0) {
    return `\`${your.branch}\` 对 \`${file}\` 进行了重构或大幅修改，\`${theirs.branch}\` 引用的旧版本代码已不存在。`;
  }

  return `两个分支在相近的时间修改了 \`${file}\` 的相邻区域，Git 无法自动判断应该保留哪个版本。`;
}

function extractFunctions(changes: string[]): string[] {
  const funcs: string[] = [];
  for (const c of changes) {
    const match = c.match(/[新增|删除|重命名]：(.+)/);
    if (match) funcs.push(match[1]);
  }
  return funcs;
}

function generateSuggestions(
  your: BranchStory,
  theirs: BranchStory,
  file: string
): ConflictSuggestion[] {
  const suggestions: ConflictSuggestion[] = [
    {
      label: "保留我的版本",
      description: `使用 \`${your.branch}\` 的改动，丢弃 \`${theirs.branch}\` 的改动。`,
      strategy: "keep_yours",
    },
    {
      label: "使用对方的版本",
      description: `使用 \`${theirs.branch}\` 的改动，丢弃 \`${your.branch}\` 的改动。`,
      strategy: "keep_theirs",
    },
  ];

  // If both sides add different things, suggest merging
  if (your.changes.length > 0 && theirs.changes.length > 0) {
    const yourAdds = your.changes.filter((c) => c.startsWith("新增"));
    const theirAdds = theirs.changes.filter((c) => c.startsWith("新增"));

    if (yourAdds.length > 0 && theirAdds.length > 0) {
      suggestions.push({
        label: "合并两者的改动",
        description: `保留双方新增的功能：${yourAdds.join("、")}（来自 ${your.branch}）+ ${theirAdds.join("、")}（来自 ${theirs.branch}）。`,
        strategy: "merge_both",
      });
    }
  }

  return suggestions;
}

function buildNarrative(
  file: string,
  your: BranchStory,
  theirs: BranchStory,
  rootCause: string,
  suggestions: ConflictSuggestion[]
): string {
  const lines = [
    `## ⚠️ Merge 冲突：\`${file}\``,
    ``,
    `### 你这边（\`${your.branch}\`）`,
    your.summary,
    ``,
    ...your.keyCommits.map(
      (c) => `  - \`${c.hash}\` ${c.message}（${c.date}）`
    ),
    ``,
    `### 对方（\`${theirs.branch}\`）`,
    theirs.summary,
    ``,
    ...theirs.keyCommits.map(
      (c) => `  - \`${c.hash}\` ${c.message}（${c.date}）`
    ),
    ``,
    `### 为什么冲突`,
    rootCause,
    ``,
    `### 解决建议`,
    ...suggestions.map((s, i) => `**(${i + 1}) ${s.label}**：${s.description}`),
    ``,
    `---`,
    `💡 选择后运行 \`git add ${file}\` 标记为已解决。`,
  ];

  return lines.join("\n");
}
