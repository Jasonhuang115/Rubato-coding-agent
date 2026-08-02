// Context compression — MicroCompact + Snip for managing context window

import type { Message } from "../shared/core-types.js";

// ---- MicroCompact: condense individual messages ----

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

// ============================================================
// Agent-Based Compaction (Sprint 2)
// ============================================================
// Spawns a no-tool subagent to generate a structured 9-field summary.
// Uses dynamic import to avoid circular dependency: loop.ts → compression.ts → subagent.ts → loop.ts

import type { AgentContext, AgentConfig } from "../shared/core-types.js";

const COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. Your job is to read the conversation and produce a detailed, structured summary that preserves all critical information needed to continue work without losing context.

CRITICAL: Do NOT call any tools. You do not have access to Read, Write, Edit, Bash, Grep, Glob, or any other tool. Your entire response must be plain text. Tool calls will be rejected and you will fail the task.

Output format:
<analysis>
[Your detailed analysis — think through every message chronologically. This section will be stripped before the summary enters context, so use it as a drafting scratchpad.]
</analysis>

<summary>
1. Primary Request and Intent:
[All of the user's explicit requests and intents in detail]

2. Key Technical Concepts:
- [Concept 1]
- [Concept 2]
- [...]

3. Files and Code Sections:
- [File name]
  - [Why important / what changed]
  - [Code snippet if applicable]

4. Errors and fixes:
- [Error description]
  - [How you fixed it]
  - [User feedback if any]

5. Problem Solving:
[Solved problems and ongoing troubleshooting]

6. All user messages:
[List ALL user messages that are not tool results]

7. Pending Tasks:
- [Task 1]
- [...]

8. Current Work:
[Precise description of what was being worked on before compaction]

9. Optional Next Step:
[Next step with verbatim quotes from the conversation]
</summary>`;

const NO_TOOLS_TRAILER =
  "\n\nREMINDER: Respond with TEXT ONLY. Do NOT call any tools. " +
  "Your entire response must be an <analysis> block followed by a <summary> block.";

/**
 * Build the compact prompt with serialized conversation.
 * Includes the full conversation history to summarize.
 */
function buildCompactPrompt(conversationText: string): string {
  return `${COMPACT_SYSTEM_PROMPT}

=== CONVERSATION TO SUMMARIZE ===

${conversationText}

=== END CONVERSATION ===

${NO_TOOLS_TRAILER}`;
}

/**
 * Strip <analysis> scratchpad and extract <summary> content.
 * Mirrors Claude Code's formatCompactSummary.
 */
function formatCompactSummary(raw: string): string {
  let formatted = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();

  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    formatted = summaryMatch[1]!.trim();
  }

  // Clean up excessive whitespace
  formatted = formatted.replace(/\n{3,}/g, "\n\n");

  return `[Compacted conversation summary — continues below]\n\n${formatted}\n\n[Recent messages follow]`;
}

/**
 * Serialize messages into a readable text format for the compact subagent.
 * Truncates large tool results to keep the compact prompt manageable.
 */
function serializeMessages(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        lines.push(`[User]: ${msg.content.slice(0, 2000)}`);
      } else {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            const preview = (block.content ?? "").slice(0, 1500);
            const suffix = (block.content ?? "").length > 1500 ? " [...truncated]" : "";
            lines.push(`[Tool Result${block.is_error ? " ERROR" : ""}]: ${preview}${suffix}`);
          } else if (block.type === "text") {
            lines.push(`[User]: ${block.text.slice(0, 2000)}`);
          }
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        lines.push(`[Assistant]: ${msg.content.slice(0, 3000)}`);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            lines.push(`[Assistant]: ${block.text.slice(0, 3000)}`);
          } else if (block.type === "tool_use") {
            const inputPreview = JSON.stringify(block.input).slice(0, 500);
            lines.push(`[Tool Call: ${block.name}] ${inputPreview}`);
          }
        }
      }
    }
  }
  return lines.join("\n");
}

/**
 * Agent-based compaction: spawn a no-tool subagent to generate a structured
 * summary of old messages, keeping the most recent messages verbatim.
 *
 * Falls back to microCompact (string-based) if the subagent fails.
 */
export async function compactViaSubagent(
  messages: Message[],
  ctx: AgentContext,
  config: AgentConfig,
  keepRecent: number,
): Promise<Message[]> {
  if (messages.length <= keepRecent) return messages;

  const splitPoint = messages.length - keepRecent;
  const toSummarize = messages.slice(0, splitPoint);
  const toKeep = messages.slice(splitPoint);

  // Build compact prompt from old messages
  const conversationText = serializeMessages(toSummarize);
  const compactPrompt = buildCompactPrompt(conversationText);

  try {
    // Dynamic import to break circular dependency
    const { spawnSubagent } = await import("../agent/subagent.js");

    const result = await spawnSubagent(
      {
        name: "compact",
        description: "Summarize conversation to reduce context usage",
        systemPrompt: COMPACT_SYSTEM_PROMPT,
        tools: [], // No tools — text output only
        readonly: true,
        maxTurns: 1,
      },
      compactPrompt,
      ctx,
      config,
    );

    if (
      (result.status !== "completed" && result.status !== "partial") ||
      !result.output
    ) {
      // Fallback to string-based microCompact
      return microCompact(messages, keepRecent);
    }

    const formattedSummary = formatCompactSummary(result.output);

    return [
      { role: "user" as const, content: formattedSummary },
      ...toKeep,
    ];
  } catch {
    // Fallback on any error
    return microCompact(messages, keepRecent);
  }
}
