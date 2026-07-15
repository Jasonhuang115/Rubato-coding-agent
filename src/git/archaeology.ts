// Git Archaeology — natural language code history queries
// "这行判断条件为什么加？" → trace through commits → explain in plain language

import { gitExec } from "./advisor.js";

export interface LineHistory {
  line: string;
  lineNumber: number;
  file: string;
  /** Each commit that touched this line */
  changes: Array<{
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    message: string;
    diff: string;
    /** PR/Issue references found in the commit message */
    references: string[];
  }>;
}

export interface HistorySummary {
  file: string;
  query: string;
  lineHistory: LineHistory[];
  narrative: string;
}

/** Trace the history of a specific line or range in a file */
export async function traceLineHistory(
  workingDir: string,
  file: string,
  lineNumber?: number,
  maxCommits = 5
): Promise<LineHistory | null> {
  try {
    const range = lineNumber
      ? `${lineNumber},${lineNumber}`
      : `1,`;

    // Use git log -L to trace line history
    const logOutput = await gitExec(
      [
        "log",
        `-${maxCommits}`,
        "--format=%H|%h|%an|%ai|%s",
        "-L",
        `${range}:${file}`,
      ],
      workingDir
    );

    const changes = parseHistoryLog(logOutput);

    if (changes.length === 0) return null;

    // Get the current content of the line
    const currentLine = lineNumber
      ? await getCurrentLine(workingDir, file, lineNumber)
      : "";

    return {
      line: currentLine,
      lineNumber: lineNumber ?? 0,
      file,
      changes,
    };
  } catch {
    return null;
  }
}

/** Search commits by keyword */
export async function searchCommits(
  workingDir: string,
  keyword: string,
  maxCommits = 10
): Promise<Array<{ hash: string; shortHash: string; author: string; date: string; message: string }>> {
  try {
    const output = await gitExec(
      ["log", `-${maxCommits}`, "--grep", keyword, "--format=%H|%h|%an|%ai|%s", "-i"],
      workingDir
    );

    return output.split("\n").filter(Boolean).map((line) => {
      const [hash, shortHash, author, ...rest] = line.split("|");
      const date = rest.slice(0, 2).join(" "); // date might have spaces
      const message = rest.slice(2).join("|");
      return { hash, shortHash, author, date, message };
    });
  } catch {
    return [];
  }
}

/** Build a natural-language summary of why some code exists */
export async function narrateHistory(
  workingDir: string,
  file: string,
  lineNumber?: number
): Promise<HistorySummary | null> {
  const lineHistory = await traceLineHistory(workingDir, file, lineNumber);
  if (!lineHistory || lineHistory.changes.length === 0) {
    return {
      file,
      query: lineNumber ? `line ${lineNumber}` : file,
      lineHistory: lineHistory ? [lineHistory] : [],
      narrative: `没有找到相关的修改历史。这个文件/行可能是在初始提交中添加的。`,
    };
  }

  const narrative = buildNarrative(lineHistory);

  return {
    file,
    query: lineNumber ? `line ${lineNumber}` : file,
    lineHistory: [lineHistory],
    narrative,
  };
}

// ---- Internal ----

function parseHistoryLog(
  logOutput: string
): LineHistory["changes"] {
  const changes: LineHistory["changes"] = [];
  const blocks = logOutput.split(/(?=^[0-9a-f]{40}\|)/m);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const headerLine = lines[0];

    if (!headerLine?.match(/^[0-9a-f]{40}\|/)) continue;

    const [hash, shortHash, author, ...rest] = headerLine.split("|");
    const message = rest.slice(rest.length >= 2 ? 2 : 0).join("|") || "";
    const date = rest.length >= 2 ? rest.slice(0, 2).join(" ") : "";

    // Extract PR/Issue references
    const references = extractReferences(message);
    // Also check the rest of the block for references in the diff
    const blockText = lines.slice(1).join("\n");
    references.push(...extractReferences(blockText));

    // Get the diff snippet (lines starting with @@ or +/-)
    const diffLines = lines
      .slice(1)
      .filter(
        (l) =>
          l.startsWith("@@") ||
          l.startsWith("+") ||
          l.startsWith("-") ||
          l.startsWith("diff")
      )
      .slice(0, 20);

    changes.push({
      hash,
      shortHash,
      author,
      date,
      message,
      diff: diffLines.join("\n"),
      references: [...new Set(references)],
    });
  }

  return changes;
}

function extractReferences(text: string): string[] {
  const refs: string[] = [];

  // GitHub references
  const githubRefs = text.match(/(?:#\d+|GH-\d+|github\.com\/[^\s]+\/(?:issues|pull)\/\d+)/gi);
  if (githubRefs) refs.push(...githubRefs);

  // JIRA-style references
  const jiraRefs = text.match(/[A-Z]{2,}-\d+/g);
  if (jiraRefs) refs.push(...jiraRefs);

  return refs;
}

async function getCurrentLine(
  workingDir: string,
  file: string,
  lineNumber: number
): Promise<string> {
  try {
    const content = await gitExec(["show", `HEAD:${file}`], workingDir);
    const lines = content.split("\n");
    return lines[lineNumber - 1] ?? "";
  } catch {
    return "";
  }
}

function buildNarrative(history: LineHistory): string {
  const { changes } = history;

  const parts: string[] = [
    history.line
      ? `这行代码 \`${history.line.trim().slice(0, 80)}\` 经过 ${changes.length} 次修改：`
      : `这个文件经过 ${changes.length} 次关键修改：`,
    "",
  ];

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const refStr = c.references.length > 0 ? ` (关联：${c.references.join(", ")})` : "";

    if (i === 0) {
      parts.push(`**最新修改** — ${c.author}，${c.date.slice(0, 10)}`);
      parts.push(`  commit \`${c.shortHash}\`：${c.message}${refStr}`);
    } else if (i === changes.length - 1) {
      parts.push(`**最早可追溯修改** — ${c.author}，${c.date.slice(0, 10)}`);
      parts.push(`  commit \`${c.shortHash}\`：${c.message}${refStr}`);
    } else {
      parts.push(`**中间修改** — ${c.author}，${c.date.slice(0, 10)}`);
      parts.push(`  commit \`${c.shortHash}\`：${c.message}${refStr}`);
    }

    if (c.diff) {
      const diffPreview = c.diff
        .split("\n")
        .filter((l) => l.startsWith("+") || l.startsWith("-"))
        .slice(0, 5)
        .join("\n");
      if (diffPreview) {
        parts.push(`  \`\`\`diff\n${diffPreview}\n  \`\`\``);
      }
    }
  }

  return parts.join("\n");
}
