// Context compression — MicroCompact + Snip for managing context window

import type { Message } from "../core-types.js";

// ---- MicroCompact: condense individual messages ----

export interface CompactSummary {
  type: "summary";
  originalCount: number;
  summary: string;
}

/**
 * MicroCompact replaces old message blocks with short summaries.
 * Ensures tool_use/tool_result pairs stay together to avoid API 400 errors.
 */
export function microCompact(
  messages: Message[],
  targetCount: number
): Message[] {
  if (messages.length <= targetCount) return messages;

  // Find a safe cut point: never split a tool_use/tool_result pair
  let keepFrom = messages.length - targetCount + 1;
  if (keepFrom <= 0) keepFrom = 1;

  while (keepFrom < messages.length) {
    const firstKept = messages[keepFrom];
    // If first kept is a tool_result, its tool_use is in the old batch — move forward
    if (!isToolResult(firstKept)) break;
    keepFrom++;
  }

  if (keepFrom >= messages.length - 1) {
    keepFrom = Math.max(1, messages.length - 5);
  }

  const toSummarize = messages.slice(0, keepFrom);
  const toKeep = messages.slice(keepFrom);

  const summary = summarizeMessages(toSummarize);
  return [summary, ...toKeep];
}

function isToolResult(msg: Message): boolean {
  if (typeof msg.content === "string") return false;
  return msg.content.some((b) => b.type === "tool_result");
}

function summarizeMessages(messages: Message[]): Message {
  const parts: string[] = [];
  parts.push(`[Earlier conversation — ${messages.length} messages compressed]`);

  // Extract user questions
  const userQuestions: string[] = [];
  const fileRefs = new Set<string>();
  const toolNames = new Set<string>();
  const errors: string[] = [];
  const keyFacts: string[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      if (msg.role === "user" && msg.content.length > 10 && msg.content.length < 300) {
        userQuestions.push(msg.content.slice(0, 200));
      }
      const matches = msg.content.match(/\/[\w./-]+/g);
      if (matches) matches.forEach((m) => fileRefs.add(m));
    } else {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolNames.add(block.name);
          const fp = block.input.file_path as string;
          if (fp) fileRefs.add(fp);
          const pattern = block.input.pattern as string;
          if (pattern) fileRefs.add(pattern);
        }
        if (block.type === "tool_result" && block.is_error) {
          const errPreview = (block.content || "").slice(0, 80);
          if (errPreview) errors.push(errPreview);
        }
        if (block.type === "text" && block.text.length > 20) {
          const text = block.text;
          // Extract first substantive sentence (language-agnostic)
          const firstSentence = text.match(/^(.{30,200})[.。!\n]/);
          if (firstSentence) {
            keyFacts.push(firstSentence[1].trim().slice(0, 150));
          }
          // Also catch explicit keyword-prefixed findings (Chinese)
          const cnFindings = text.match(/(?:关键|发现|问题|结论|总结|注意|核心)[：:]\s*(.+?)(?:\n|$)/g);
          if (cnFindings) {
            cnFindings.forEach((f) => {
              const trimmed = f.trim().slice(0, 150);
              if (!keyFacts.includes(trimmed)) keyFacts.push(trimmed);
            });
          }
          // Catch English observation patterns
          const enFindings = text.match(/(?:Key (?:finding|insight|observation)|Found|Noted|Important|Critical|Note)[：:]\s*(.+?)(?:\n|$)/gi);
          if (enFindings) {
            enFindings.forEach((f) => {
              const trimmed = f.trim().slice(0, 150);
              if (!keyFacts.includes(trimmed)) keyFacts.push(trimmed);
            });
          }
        }
      }
    }
  }

  if (userQuestions.length > 0) {
    parts.push(`\nUser requests: ${userQuestions.slice(-5).join(" | ")}`);
  }
  if (fileRefs.size > 0) {
    const files = Array.from(fileRefs).filter((f) => !f.includes("*") && f.length < 120);
    if (files.length > 0) {
      parts.push(`Files examined: ${files.slice(0, 15).join(", ")}${files.length > 15 ? ` ...+${files.length - 15}` : ""}`);
    }
  }
  if (toolNames.size > 0) {
    parts.push(`Tools used: ${Array.from(toolNames).join(", ")}`);
  }
  if (keyFacts.length > 0) {
    parts.push(`Key findings:\n${keyFacts.slice(0, 8).map((f) => `  - ${f}`).join("\n")}`);
  }
  if (errors.length > 0) {
    parts.push(`Errors encountered: ${errors.slice(0, 4).join("; ")}`);
  }

  // If we got almost nothing, keep a minimal breadcrumb
  if (parts.length <= 1) {
    parts.push(`(Messages were mostly tool calls with no extractable text)`);
  }

  parts.push(`\n[End of compressed context — continue from here]`);

  return { role: "user", content: parts.join("\n") };
}

// ---- Snip: truncate large content blocks ----

export interface SnipOptions {
  maxToolResultLength: number;
  maxLinesPerRead: number;
}

export const DEFAULT_SNIP_OPTIONS: SnipOptions = {
  maxToolResultLength: 50_000,
  maxLinesPerRead: 2_000,
};

/**
 * Snip truncates large tool results to prevent context overflow.
 * Keeps the head and tail of the content with a truncation marker.
 */
export function snipContent(
  content: string,
  maxLength: number = DEFAULT_SNIP_OPTIONS.maxToolResultLength
): string {
  if (content.length <= maxLength) return content;

  const headSize = Math.floor(maxLength * 0.6);
  const tailSize = Math.floor(maxLength * 0.3);

  const head = content.substring(0, headSize);
  const tail = content.substring(content.length - tailSize);
  const skipped = content.length - headSize - tailSize;

  return `${head}\n\n[${skipped.toLocaleString()} bytes truncated...]\n\n${tail}`;
}

/**
 * Snip lines from Read tool output to keep context manageable.
 */
export function snipLines(
  lines: string[],
  maxLines: number = DEFAULT_SNIP_OPTIONS.maxLinesPerRead
): string {
  if (lines.length <= maxLines) return lines.join("\n");

  const headLines = Math.floor(maxLines * 0.6);
  const tailLines = Math.floor(maxLines * 0.3);
  const skipped = lines.length - headLines - tailLines;

  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(-tailLines).join("\n");

  return `${head}\n\n... [${skipped} lines truncated] ...\n\n${tail}`;
}

// Compact via subagent when message count is small enough that we still
// have context budget to spawn a summarizer. For heavy sessions, microCompact
// (summarizeMessages above) remains the fast path.
