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
 * In Phase 1, this is a simple rule-based summarizer.
 * In Phase 2, this will use a cheap model for smarter summarization.
 */
export function microCompact(
  messages: Message[],
  targetCount: number
): Message[] {
  if (messages.length <= targetCount) return messages;

  // Keep the most recent messages intact
  const keepFrom = messages.length - targetCount + 1;
  const toSummarize = messages.slice(0, keepFrom);
  const toKeep = messages.slice(keepFrom);

  const summary = summarizeMessages(toSummarize);
  return [summary, ...toKeep];
}

function summarizeMessages(messages: Message[]): Message {
  const userMsgs = messages.filter((m) => m.role === "user").length;
  const assistantMsgs = messages.filter((m) => m.role === "assistant").length;
  const toolCalls = messages.filter((m) => {
    if (typeof m.content === "string") return false;
    return m.content.some((b) => b.type === "tool_use");
  }).length;

  // Extract key information from messages
  let summaryText = `[Context summary: ${messages.length} earlier messages `;
  summaryText += `(${userMsgs} user, ${assistantMsgs} assistant, ${toolCalls} tool calls).`;

  // Extract file paths and tool names for context
  const fileRefs = new Set<string>();
  const toolNames = new Set<string>();

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      // Try to find file paths
      const matches = msg.content.match(/\/[\w./-]+/g);
      if (matches) matches.forEach((m) => fileRefs.add(m));
    } else {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolNames.add(block.name);
          const filePath = block.input.file_path as string;
          if (filePath) fileRefs.add(filePath);
        }
        if (block.type === "tool_result" && block.is_error) {
          summaryText += ` Had errors.`;
        }
      }
    }
  }

  if (fileRefs.size > 0) {
    summaryText += ` Files: ${Array.from(fileRefs).slice(0, 10).join(", ")}.`;
  }
  if (toolNames.size > 0) {
    summaryText += ` Tools used: ${Array.from(toolNames).join(", ")}.`;
  }

  summaryText += `]`;

  return {
    role: "user",
    content: summaryText,
  };
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

// ---- Extension point: Phase 2 smart compression ----

export interface SmartCompressor {
  compress(messages: Message[], targetTokens: number, model: string): Promise<Message[]>;
}

// Phase 1: no-op (uses MicroCompact above)
// Phase 2: injects LLM-powered compressor through this extension point
export const compressors: SmartCompressor[] = [];
