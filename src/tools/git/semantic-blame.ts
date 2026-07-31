// Semantic Blame — explains WHY a line exists, not just who wrote it.
// The explanation is derived from repository evidence only: blame, log and
// file history. Personal memory is intentionally not a dependency of this tool.

import { gitExec } from "./advisor.js";
import { narrateHistory } from "./archaeology.js";

export interface SemanticBlameResult {
  file: string;
  lineNumber: number;
  lineContent: string;
  /** Who last modified it */
  author: string;
  /** When */
  date: string;
  /** Commit that introduced it */
  commitHash: string;
  commitMessage: string;
  /** Full history narrative */
  historyNarrative: string;
  /** Full story combining everything */
  story: string;
}

/** Full semantic blame from verifiable Git history. */
export async function semanticBlame(
  workingDir: string,
  file: string,
  lineNumber: number
): Promise<SemanticBlameResult | null> {
  try {
    // 1. Get git blame info
    const blameOutput = await gitExec(
      ["blame", "-L", `${lineNumber},${lineNumber}`, "--date=short", "-s", file],
      workingDir
    );

    const blameParts = blameOutput.match(
      /^([0-9a-f]+)\s+\(?([^)]+)\)?\s*(.+)/
    );
    if (!blameParts) return null;

    const [, commitHash, authorDate, content] = blameParts;
    const [author, date] = authorDate.trim().split(/\s+/);

    // 2. Get commit details
    const commitMsg = await gitExec(
      ["log", "-1", "--format=%s", commitHash],
      workingDir
    ).catch(() => "unknown");

    // 3. Get full history narrative
    const history = await narrateHistory(workingDir, file, lineNumber);
    const historyNarrative = history?.narrative ?? "";

    // 4. Weave the repository evidence into a story.
    const story = buildStory(
      file,
      lineNumber,
      content.trim(),
      author,
      date,
      commitHash,
      commitMsg,
      historyNarrative
    );

    return {
      file,
      lineNumber,
      lineContent: content.trim(),
      author,
      date,
      commitHash,
      commitMessage: commitMsg,
      historyNarrative,
      story,
    };
  } catch {
    return null;
  }
}

function buildStory(
  file: string,
  lineNumber: number,
  lineContent: string,
  author: string,
  date: string,
  hash: string,
  message: string,
  history: string
): string {
  const parts = [
    `这行代码 \`${lineContent.slice(0, 80)}\`（${file}:${lineNumber}）`,
    `由 **${author}** 在 ${date} 添加（commit \`${hash.slice(0, 7)}\`）。`,
    ``,
    `**提交信息**：${message}`,
    ``,
  ];

  if (history) {
    parts.push(`**修改历程**：`);
    parts.push(history);
    parts.push("");
  }

  parts.push(`---`);
  parts.push(
    `💡 这个分析结合了 git blame、git log 和文件修改历史。` +
    `如果你需要更详细的上下文（如当时的讨论、PR review 意见），可以告诉我。`
  );

  return parts.join("\n");
}

// ---- Lightweight: blame with context (no memory graph needed) ----

export async function quickBlame(
  workingDir: string,
  file: string,
  lineNumber: number
): Promise<string | null> {
  try {
    const blameOutput = await gitExec(
      ["blame", "-L", `${lineNumber},${lineNumber}`, "--date=relative", file],
      workingDir
    );

    const match = blameOutput.match(
      /^([0-9a-f]+)\s+\(([^)]+)\)\s+(.+)/
    );
    if (!match) return null;

    const [, hash, authorDate, content] = match;
    const pretty = authorDate.trim().replace(/\s{2,}/g, " ").trim();

    // Get commit message in one shot
    const msg = await gitExec(
      ["log", "-1", "--format=%s", hash],
      workingDir
    ).catch(() => "unknown");

    return (
      `\`${content.trim().slice(0, 80)}\`\n` +
      `→ ${pretty} — commit \`${hash.slice(0, 7)}\`：${msg}`
    );
  } catch {
    return null;
  }
}
