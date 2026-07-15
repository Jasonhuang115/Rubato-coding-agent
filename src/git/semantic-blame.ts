// Semantic Blame — explains WHY a line exists, not just who wrote it
// Combines git log, commit messages, and memory graph for full context

import { gitExec } from "./advisor.js";
import { narrateHistory } from "./archaeology.js";
import type { MnemosyneStore } from "../memory/store.js";

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
  /** Related bugs/fixes from memory graph */
  relatedMemories: string[];
  /** Full story combining everything */
  story: string;
}

/** Full semantic blame: git history + memory graph = complete story */
export async function semanticBlame(
  workingDir: string,
  file: string,
  lineNumber: number,
  memoryStore?: MnemosyneStore
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

    // 4. Search memory graph for related bugs/fixes
    const relatedMemories: string[] = [];
    if (memoryStore) {
      try {
        const keyword = `${file} ${content.trim().slice(0, 50)}`;
        const memories = memoryStore.searchWithRelevance(keyword, 3);
        for (const { entity } of memories) {
          relatedMemories.push(`[${entity.type}] ${entity.name}: ${entity.content.slice(0, 100)}`);
        }
      } catch {
        // Memory store not available — skip
      }
    }

    // 5. Weave it all into a story
    const story = buildStory(
      file,
      lineNumber,
      content.trim(),
      author,
      date,
      commitHash,
      commitMsg,
      historyNarrative,
      relatedMemories
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
      relatedMemories,
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
  history: string,
  memories: string[]
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

  if (memories.length > 0) {
    parts.push(`**💡 记忆关联**：`);
    for (const m of memories) {
      parts.push(`  - ${m}`);
    }
    parts.push("");
  }

  parts.push(`---`);
  parts.push(
    `💡 这个分析结合了 git log、commit message、以及 Mnemosyne 记忆图谱。` +
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
