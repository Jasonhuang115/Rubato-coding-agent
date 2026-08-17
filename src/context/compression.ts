// Context compression — LLM summary + heuristic MicroCompact fallback

import type { AgentConfig, Message, ModelProvider } from "../shared/core-types.js";
import { processStream } from "../runtime/step-executor.js";
import { SILENT_RENDERER, serializeMessages } from "./transcript.js";

const MAX_COMPACT_TOKENS = 8_192;

const COMPACT_SYSTEM_PROMPT = [
  "You are compressing a coding-agent conversation to save context-window space.",
  "This is NOT durable memory extraction. Do not write notes, call tools, or invent facts.",
  "The summary you produce will REPLACE the discarded messages. Later turns will only see your summary plus the recent messages that were kept.",
  "",
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Tool calls will be rejected and the compression will fail.",
  "Wrap the final structured summary in <summary>...</summary>. You may think first, but only the <summary> block is kept.",
].join("\n");

const COMPACT_USER_INSTRUCTIONS = [
  "Create a detailed summary of the conversation below, paying close attention to the user's explicit requests and the assistant's previous actions.",
  "Capture technical details, code patterns, and architectural decisions needed to continue development without losing context.",
  "",
  "Your <summary> MUST include these sections:",
  "",
  "1. Primary Request and Intent: Capture the user's explicit requests and intents in detail.",
  "2. Key Technical Concepts and Decisions: Important technologies, patterns, and decisions, including why they were made.",
  "3. Files and Code Sections: Files examined, modified, or created. For each, why it mattered, what changed, and key snippets when they are needed to continue.",
  "4. Errors and Fixes: Errors encountered and how they were fixed. Include user feedback about mistakes.",
  "5. User Corrections and Explicit Feedback: Verbatim quotes where the user corrected the assistant or said to do something differently.",
  "6. Pending Tasks: Work the user explicitly asked for that is not finished.",
  "7. Current Work: Precisely what was being done immediately before this summary, with file names and snippets where applicable.",
  "8. Next Step: Only if it directly continues the most recent explicit user request. Quote the conversation to show where you left off. If the last task concluded, do not invent a next step.",
  "",
  "Be precise and thorough. Do not omit user corrections.",
].join("\n");

const COMPACT_CONTINUATION = [
  "This session is being continued from a previous conversation that ran out of context.",
  "The summary below covers the compacted portion.",
].join(" ");

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

export async function compactViaModel(
  messages: Message[],
  config: AgentConfig,
  provider: ModelProvider,
  keepRecent: number,
  abortSignal?: AbortSignal,
): Promise<Message[]> {
  const keepFrom = compactCutFrom(messages, keepRecent);
  if (keepFrom <= 0) return messages;

  const toSummarize = messages.slice(0, keepFrom);
  const toKeep = messages.slice(keepFrom);
  const summary = await summarizeViaModel(toSummarize, config, provider, abortSignal);
  return [
    { role: "user", content: `${COMPACT_CONTINUATION}\n\n${summary}` },
    ...toKeep,
  ];
}

async function summarizeViaModel(
  toSummarize: Message[],
  config: AgentConfig,
  provider: ModelProvider,
  abortSignal?: AbortSignal,
): Promise<string> {
  const stream = await processStream(
    provider,
    {
      model: config.model.model,
      system: COMPACT_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          COMPACT_USER_INSTRUCTIONS,
          "",
          serializeMessages(toSummarize),
        ].join("\n"),
      }],
      tools: [],
      maxTokens: MAX_COMPACT_TOKENS,
      signal: abortSignal ?? new AbortController().signal,
    },
    SILENT_RENDERER,
  );

  if (stream.toolUses.length > 0) {
    throw new Error("Compaction model called tools");
  }
  const text = stream.text.trim();
  if (!text) {
    throw new Error("Compaction model returned empty summary");
  }
  return parseCompactSummary(text);
}

function parseCompactSummary(text: string): string {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (match?.[1]?.trim()) return match[1].trim();
  return text;
}
