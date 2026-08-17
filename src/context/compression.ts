// Context compression — MicroCompact + Snip for managing context window

import type { Message } from "../shared/core-types.js";

// ---- MicroCompact: condense individual messages ----

/**
 * MicroCompact replaces old message blocks with short summaries.
 * Ensures tool_use/tool_result pairs stay together to avoid API 400 errors.
 */
export function compactCutFrom(messages: Message[], targetCount: number): number {
  if (messages.length <= targetCount) return 0;

  let keepFrom = messages.length - targetCount + 1;
  if (keepFrom <= 0) keepFrom = 1;

  while (keepFrom < messages.length) {
    const firstKept = messages[keepFrom];
    if (!isToolResult(firstKept)) break;
    keepFrom++;
  }

  if (keepFrom >= messages.length - 1) {
    keepFrom = Math.max(1, messages.length - 5);
  }

  return keepFrom;
}

export function messagesToDiscard(messages: Message[], targetCount: number): Message[] {
  const keepFrom = compactCutFrom(messages, targetCount);
  return keepFrom > 0 ? messages.slice(0, keepFrom) : [];
}

export function microCompact(
  messages: Message[],
  targetCount: number
): Message[] {
  const keepFrom = compactCutFrom(messages, targetCount);
  if (keepFrom <= 0) return messages;

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

import type { AgentContext, AgentConfig } from "../shared/core-types.js";
export async function compactViaSubagent(
  messages: Message[],
  _ctx: AgentContext,
  _config: AgentConfig,
  keepRecent: number,
): Promise<Message[]> {
  return microCompact(messages, keepRecent);
}
