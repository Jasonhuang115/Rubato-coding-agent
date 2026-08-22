// Layered compaction helpers: keep last N user turns, offload/clear tool
// results, and shrink kept turns down to a floor of 1.

import type { AgentConfig, Message, ModelProvider, ToolResultBlock } from "../shared/core-types.js";
import { processStream } from "../runtime/step-executor.js";
import { SILENT_RENDERER } from "./transcript.js";
import {
  compactCutFrom,
  compactViaModel,
  heuristicSummaryMessage,
  isCompactionSummary,
  isPureToolResult,
  microCompact,
  PASS1_KEEP_TURNS,
  SHRINK_FLOOR_TURNS,
  userTurnStartIndices,
} from "./compression.js";
import {
  extractOffloadPath,
  OFFLOAD_THRESHOLD,
  offloadIfLarge,
  offloadToolResultContent,
} from "./tool-result-offload.js";
import { clearedToolResultPlaceholder, isClearedToolResult } from "./micro-compact.js";

const PASS2_MAX_TOKENS = 2_048;

export interface ToolResultEntry {
  toolUseId: string;
  toolName: string;
  chars: number;
  preview: string;
  alreadyOffloaded: boolean;
  path?: string;
}

export type ToolResultAction = "offload" | "clear" | "keep";

export function offloadHeavyToolResults(messages: Message[], dir: string): Message[] {
  return mapToolResults(messages, (block, toolName) => {
    const next = offloadIfLarge(block.content ?? "", toolName, undefined, dir);
    if (next === block.content) return block;
    return { ...block, content: next };
  });
}

export function collectToolResultEntries(messages: Message[]): ToolResultEntry[] {
  const names = toolNameById(messages);
  const entries: ToolResultEntry[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      const content = block.content ?? "";
      if (isClearedToolResult(content)) continue;
      const path = extractOffloadPath(content);
      entries.push({
        toolUseId: block.tool_use_id,
        toolName: names.get(block.tool_use_id) ?? "unknown",
        chars: content.length,
        preview: content.slice(0, 160).replace(/\s+/g, " "),
        alreadyOffloaded: Boolean(path),
        path,
      });
    }
  }
  return entries;
}

export function heuristicToolResultActions(entries: ToolResultEntry[]): Map<string, ToolResultAction> {
  const actions = new Map<string, ToolResultAction>();
  const ranked = [...entries].sort((a, b) => b.chars - a.chars);
  for (const entry of ranked) {
    if (entry.alreadyOffloaded) {
      actions.set(entry.toolUseId, "keep");
      continue;
    }
    actions.set(entry.toolUseId, entry.chars >= OFFLOAD_THRESHOLD / 4 ? "offload" : "clear");
  }
  return actions;
}

export function applyToolResultActions(
  messages: Message[],
  actions: Map<string, ToolResultAction>,
  dir: string,
): Message[] {
  const names = toolNameById(messages);
  return mapToolResults(messages, (block, toolName) => {
    const action = actions.get(block.tool_use_id);
    if (!action || action === "keep") return block;
    const content = block.content ?? "";
    if (action === "offload") {
      if (extractOffloadPath(content)) return block;
      return {
        ...block,
        content: offloadToolResultContent(content, names.get(block.tool_use_id) ?? toolName, dir),
      };
    }
    const path = extractOffloadPath(content);
    return { ...block, content: clearedToolResultPlaceholder(path) };
  });
}

export async function pickToolResultActionsViaModel(
  entries: ToolResultEntry[],
  config: AgentConfig,
  provider: ModelProvider,
  abortSignal?: AbortSignal,
): Promise<Map<string, ToolResultAction>> {
  const actionable = entries.filter((e) => !e.alreadyOffloaded);
  if (actionable.length === 0) return heuristicToolResultActions(entries);

  const catalog = actionable.map((e) => ({
    id: e.toolUseId,
    tool: e.toolName,
    chars: e.chars,
    preview: e.preview,
  }));
  const stream = await processStream(
    provider,
    {
      model: config.model.model,
      system: [
        "You pick how to shrink recent tool results so a coding agent can keep working.",
        "Return JSON only: {\"decisions\":[{\"id\":\"...\",\"action\":\"offload\"|\"clear\"}]}",
        "offload = keep a path so the original can be Read later. clear = drop the body.",
        "Do not call tools. Prefer offload for results that might still be needed.",
      ].join(" "),
      messages: [{
        role: "user",
        content: `Decide for each tool result:\n${JSON.stringify(catalog, null, 2)}`,
      }],
      tools: [],
      maxTokens: PASS2_MAX_TOKENS,
      signal: abortSignal ?? new AbortController().signal,
    },
    SILENT_RENDERER,
  );
  if (stream.toolUses.length > 0) {
    throw new Error("Compaction picker called tools");
  }
  const parsed = parseActionJson(stream.text, actionable);
  if (!parsed) throw new Error("Compaction picker returned unusable JSON");
  const actions = heuristicToolResultActions(entries);
  for (const [id, action] of parsed) actions.set(id, action);
  return actions;
}

function parseActionJson(
  text: string,
  entries: ToolResultEntry[],
): Map<string, ToolResultAction> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const body = JSON.parse(match[0]) as { decisions?: Array<{ id?: string; action?: string }> };
    if (!Array.isArray(body.decisions)) return null;
    const known = new Set(entries.map((e) => e.toolUseId));
    const actions = new Map<string, ToolResultAction>();
    for (const row of body.decisions) {
      if (!row.id || !known.has(row.id)) continue;
      if (row.action === "offload" || row.action === "clear" || row.action === "keep") {
        actions.set(row.id, row.action);
      }
    }
    return actions.size > 0 ? actions : null;
  } catch {
    return null;
  }
}

export async function summarizeOlderTurns(
  messages: Message[],
  keepTurns: number,
  config: AgentConfig,
  provider: ModelProvider,
  abortSignal?: AbortSignal,
): Promise<{ messages: Message[]; usedModel: boolean; modelFailed: boolean }> {
  const keepFrom = compactCutFrom(messages, keepTurns);
  if (keepFrom <= 0) {
    return { messages, usedModel: false, modelFailed: false };
  }
  try {
    return {
      messages: await compactViaModel(messages, config, provider, keepTurns, abortSignal),
      usedModel: true,
      modelFailed: false,
    };
  } catch {
    return {
      messages: microCompact(messages, keepTurns),
      usedModel: true,
      modelFailed: true,
    };
  }
}

export function countKeptUserTurns(messages: Message[]): number {
  return userTurnStartIndices(messages).length;
}

export function shrinkOldestKeptTurn(messages: Message[]): Message[] {
  const starts = userTurnStartIndices(messages);
  if (starts.length <= SHRINK_FLOOR_TURNS) return messages;

  const dropFrom = starts[0]!;
  const dropTo = starts[1] ?? messages.length;
  const dropped = messages.slice(dropFrom, dropTo);
  const remainder = [...messages.slice(0, dropFrom), ...messages.slice(dropTo)];
  const appendix = droppedTurnAppendix(dropped);
  const summaryIdx = remainder.findIndex((m) => isCompactionSummary(m));
  if (summaryIdx >= 0) {
    const summary = remainder[summaryIdx]!;
    const next = [...remainder];
    next[summaryIdx] = appendToTextMessage(summary, appendix);
    return next;
  }
  return [heuristicSummaryMessage(dropped), ...remainder];
}

function droppedTurnAppendix(dropped: Message[]): string {
  const quotes: string[] = [];
  for (const msg of dropped) {
    if (msg.role !== "user" || isPureToolResult(msg)) continue;
    const text = typeof msg.content === "string"
      ? msg.content
      : msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const trimmed = text.trim();
    if (trimmed) quotes.push(trimmed.slice(0, 400));
  }
  const conclusions: string[] = [];
  for (const msg of dropped) {
    if (msg.role !== "assistant") continue;
    const text = typeof msg.content === "string"
      ? msg.content
      : msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const trimmed = text.trim();
    if (trimmed) conclusions.push(trimmed.slice(0, 200));
  }
  return [
    "",
    "Recently dropped from live history:",
    quotes.length > 0 ? `User: ${quotes.join(" | ")}` : "",
    conclusions.length > 0 ? `Assistant: ${conclusions.join(" | ")}` : "",
  ].filter(Boolean).join("\n");
}

function appendToTextMessage(msg: Message, appendix: string): Message {
  if (typeof msg.content === "string") {
    return { ...msg, content: `${msg.content}\n${appendix}` };
  }
  const copied = msg.content.map((block) =>
    block.type === "text" ? { ...block, text: `${block.text}\n${appendix}` } : block,
  );
  const hasText = copied.some((b) => b.type === "text");
  if (!hasText) {
    return { ...msg, content: [{ type: "text", text: appendix }, ...copied] };
  }
  return { ...msg, content: copied };
}

export function extractSummaryText(messages: Message[]): string {
  const summary = messages.find((m) => isCompactionSummary(m));
  if (!summary) {
    const first = messages.find((m) => m.role === "user" && !isPureToolResult(m));
    if (!first) return "";
    return typeof first.content === "string"
      ? first.content.slice(0, 2000)
      : first.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").slice(0, 2000);
  }
  return typeof summary.content === "string"
    ? summary.content
    : summary.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function toolNameById(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") names.set(block.id, block.name);
    }
  }
  return names;
}

function mapToolResults(
  messages: Message[],
  map: (block: ToolResultBlock, toolName: string) => ToolResultBlock,
): Message[] {
  const names = toolNameById(messages);
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    let touched = false;
    const content = msg.content.map((block) => {
      if (block.type !== "tool_result") return block;
      const next = map(block, names.get(block.tool_use_id) ?? "unknown");
      if (next !== block) touched = true;
      return next;
    });
    return touched ? { ...msg, content } : msg;
  });
}

export { PASS1_KEEP_TURNS, SHRINK_FLOOR_TURNS };
