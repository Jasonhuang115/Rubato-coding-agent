import type {
  AgentConfig,
  AgentContext,
  Message,
  ModelProvider,
  StreamRenderer,
  ToolUseBlock,
} from "../shared/core-types.js";
import { processStream } from "../runtime/step-executor.js";
import { memoryTool } from "../tools/memory.js";
import {
  MemoryStore,
  readMemoryIndex,
  readUserMemoryFile,
} from "./store.js";

const MAX_EXTRACTION_ROUNDS = 3;
const MAX_EXTRACTION_TOKENS = 4_096;
const MAX_TRANSCRIPT_CHARS = 80_000;

export interface MemoryExtractionOptions {
  discarded: Message[];
  ctx: AgentContext;
  config: AgentConfig;
  provider: ModelProvider;
  abortSignal?: AbortSignal;
}

export interface MemoryExtractionResult {
  wrote: boolean;
  warning?: string;
}

export function shouldExtractMemories(options: {
  isRoot: boolean;
  extractedThisCycle: boolean;
  memoryEnabled: boolean;
  willCompact: boolean;
}): boolean {
  return options.isRoot
    && !options.extractedThisCycle
    && options.memoryEnabled
    && options.willCompact;
}

export async function extractMemories(
  options: MemoryExtractionOptions,
): Promise<MemoryExtractionResult> {
  if (options.discarded.length === 0) return { wrote: false };
  if (!options.ctx.projectId) return { wrote: false, warning: "No project identity for memory extraction." };

  const tools = [memoryTool];
  const system = buildExtractionPrompt(options.ctx);
  const messages: Message[] = [{
    role: "user",
    content: [
      "The following conversation is about to be compacted out of short-term context.",
      "Extract durable memory if and only if it meets the write rules. Prefer revising existing notes.",
      "If nothing qualifies, reply with NO_MEMORY_UPDATES and stop.",
      "",
      serializeMessages(options.discarded, MAX_TRANSCRIPT_CHARS),
    ].join("\n"),
  }];

  let wrote = false;
  try {
    for (let round = 0; round < MAX_EXTRACTION_ROUNDS; round++) {
      const stream = await processStream(
        options.provider,
        {
          model: options.config.model.model,
          system,
          messages,
          tools,
          maxTokens: MAX_EXTRACTION_TOKENS,
          signal: options.abortSignal ?? new AbortController().signal,
        },
        SILENT_RENDERER,
      );

      const assistantContent: Message["content"] = [];
      if (stream.text.trim()) {
        assistantContent.push({ type: "text", text: stream.text });
      }
      for (const toolUse of stream.toolUses) {
        assistantContent.push(toolUse);
      }
      if (assistantContent.length > 0) {
        messages.push({ role: "assistant", content: assistantContent });
      }

      if (stream.toolUses.length === 0) return { wrote };

      const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> = [];
      for (const toolUse of stream.toolUses) {
        if (toolUse.name !== "Memory") {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Only the Memory tool is available during extraction.",
            is_error: true,
          });
          continue;
        }
        const result = await memoryTool.handler(toolUse.input, options.ctx);
        if (!result.isError && isWriteCommand(toolUse)) wrote = true;
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: result.isError,
        });
      }
      messages.push({ role: "user", content: toolResults });
    }
    return { wrote, warning: wrote ? undefined : "Memory extraction reached its tool-round limit." };
  } catch (error) {
    return {
      wrote,
      warning: `Memory extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isWriteCommand(toolUse: ToolUseBlock): boolean {
  const command = toolUse.input.command;
  return command !== "view";
}

function buildExtractionPrompt(ctx: AgentContext): string {
  const store = new MemoryStore({ projectId: ctx.projectId! });
  const projectIndex = readMemoryIndex("project", { projectId: ctx.projectId! }) ?? "[empty]";
  const userPortrait = readUserMemoryFile({ projectId: ctx.projectId! }) ?? "[empty]";
  return [
    "You extract durable memory before short-term context is compacted.",
    "This is not summarization. Do not recap the conversation. Write only durable facts.",
    "You may only call the Memory tool. Prefer str_replace or insert on existing files.",
    "old_str must be unique. Do not invent credentials.",
    "",
    "Project memory (namespace project) stores what this repository cannot explain by itself:",
    "boundaries, decisions plus why, rejected alternatives, pitfalls, and local environment facts.",
    `Project directory: ${store.root("project")}`,
    "Keep MEMORY.md as a short index. Details go in topic Markdown files.",
    "",
    "User memory (namespace user, path MEMORY.md only) stores stable cross-project preferences:",
    "working style, communication, technical likes/dislikes, collaboration habits.",
    "Example: the user forbids Git operations. Project-specific facts do not belong here.",
    `User file: ${store.root("user")}/MEMORY.md`,
    "",
    "Skip anything already in these notes, already in the code, or only useful for the rest of this session.",
    "If nothing qualifies, reply with NO_MEMORY_UPDATES.",
    "",
    "## Current project MEMORY.md",
    projectIndex,
    "",
    "## Current user MEMORY.md",
    userPortrait,
  ].join("\n");
}

function serializeMessages(messages: Message[], maxChars: number): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      chunks.push(`${message.role}: ${message.content}`);
      continue;
    }
    const parts = message.content.map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") {
        return `[${block.name} ${JSON.stringify(block.input).slice(0, 400)}]`;
      }
      return `[tool_result ${(block.content ?? "").slice(0, 400)}]`;
    });
    chunks.push(`${message.role}: ${parts.join("\n")}`);
  }
  const text = chunks.join("\n\n");
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head - 28;
  return `${text.slice(0, head)}\n\n[...truncated...]\n\n${text.slice(-tail)}`;
}

const SILENT_RENDERER: StreamRenderer = {
  renderUserMessage() {},
  renderAssistantMessage() {},
  renderThinking() {},
  renderSystemMessage() {},
  renderToolUse() {},
  renderToolResult() {},
  renderError() {},
  renderWarning() {},
  clear() {},
  flush() {},
};
