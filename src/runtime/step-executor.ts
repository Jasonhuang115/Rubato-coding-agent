// StepExecutor — single-turn "model call → tool dispatch" cycle
// Extracted from loop.ts to keep the agent loop focused on orchestration.
//
// Responsibilities:
//   - processStream: stream model response → text + tool_use blocks
//   - executeTurn: one complete turn (model call + tool execution)
//   - Retry logic with exponential backoff
//   - Circuit breaker for error rate limiting

import type {
  ModelProvider,
  AgentContext,
  Message,
  ToolUseBlock,
  StreamRenderer,
  ConfirmDecision,
  ToolDefinition,
  BudgetManager,
} from "../shared/core-types.js";
import type { AgentEvent } from "../agent/loop.js";
import { dispatch } from "../tools/registry.js";
import { ToolRuntime } from "./tool-runtime.js";
import type { ToolRuntimeResult } from "./tool-runtime.js";
import { PlanManager } from "../agent/planner/manager.js";
import type { PlanDoc } from "../agent/planner/tree.js";
import { prePushHook, preCommitHook } from "../tools/git/hooks.js";

// ---- Configuration ----

const DEFAULT_MAX_TOKENS = 16_384;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_WINDOW_MS = 60_000;
const OFFLOAD_THRESHOLD = 30_000;

// ---- Types ----

export interface StreamResult {
  text: string;
  toolUses: ToolUseBlock[];
  usage: { input: number; output: number };
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

export interface TurnResult {
  /** The assistant message blocks (text + tool_uses). */
  assistantBlocks: { type: "text"; text: string }[];
  /** Tool uses extracted from the model response. */
  toolUses: ToolUseBlock[];
  /** Token usage for this turn. */
  usage: { input: number; output: number };
  /** Why the model stopped. */
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  /** Whether any tool was denied by the user. */
  toolDenied: boolean;
}

export interface TurnOptions {
  provider: ModelProvider;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  renderer: StreamRenderer;
  workingDir: string;
  ctx: AgentContext;
  toolRuntime: ToolRuntime;
  planManager: PlanManager;
  onConfirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision>;
}

// ---- Error tracking (module-level for circuit breaker) ----

let currentAbortController: AbortController | null = null;

export function getAbortController(): AbortController | null {
  return currentAbortController;
}

export function setAbortController(ac: AbortController | null): void {
  currentAbortController = ac;
}

// ---- Stream processing ----

export async function processStream(
  provider: ModelProvider,
  params: {
    model: string;
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
    maxTokens: number;
    signal: AbortSignal;
  },
  renderer: StreamRenderer,
): Promise<StreamResult> {
  let text = "";
  const toolUses: ToolUseBlock[] = [];
  let usage = { input: 0, output: 0 };
  let stopReason: StreamResult["stopReason"] = "end_turn";

  const toolNames = new Map<string, string>();

  for await (const event of provider.chat(params)) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        renderer.renderAssistantMessage(event.text);
        break;

      case "thinking_delta":
        renderer.renderThinking(event.text);
        break;

      case "tool_use_start":
        toolNames.set(event.id, event.name);
        break;

      case "tool_use_delta":
        break;

      case "tool_use_end":
        {
          const name = toolNames.get(event.id) ?? "unknown";
          toolUses.push({
            type: "tool_use",
            id: event.id,
            name,
            input: event.input,
          });
          renderer.renderToolUse(name, event.input);
        }
        break;

      case "content_block_stop":
        break;

      case "message_stop":
        usage = { input: event.usage.inputTokens, output: event.usage.outputTokens };
        stopReason = event.stopReason as StreamResult["stopReason"];
        break;

      case "error":
        throw new Error(event.message);
    }
  }

  renderer.flush();
  return { text, toolUses, usage, stopReason };
}

// ---- Full turn execution ----

/**
 * Execute one complete turn: model call → collect results → execute tools.
 * Yields AgentEvents for each phase (streaming, tool execution, results).
 */
export async function* executeTurn(
  options: TurnOptions,
): AsyncGenerator<AgentEvent, TurnResult> {
  const {
    provider, model, systemPrompt, messages, tools,
    renderer, workingDir, ctx, toolRuntime, planManager, onConfirmTool,
  } = options;

  // ---- Call model with retry ----
  let streamResult: StreamResult | null = null;
  let retryCount = 0;

  while (retryCount <= RETRY_MAX_ATTEMPTS) {
    if (isCircuitBreakerOpen(errorTimestamps)) {
      yield {
        type: "error",
        message: "Circuit breaker open — too many errors. Please check your API connection and try again.",
        retryable: false,
      };
      // Return empty turn — caller handles circuit breaker
      throw new CircuitBreakerError("Circuit breaker open");
    }

    const abortController = new AbortController();
    currentAbortController = abortController;
    const timeout = setTimeout(() => abortController.abort(), 120_000);

    try {
      streamResult = await processStream(
        provider,
        { model, system: systemPrompt, messages, tools, maxTokens: DEFAULT_MAX_TOKENS, signal: abortController.signal },
        renderer,
      );

      clearTimeout(timeout);
      currentAbortController = null;
      consecutiveErrors = 0;
      break;
    } catch (err: unknown) {
      clearTimeout(timeout);
      const wasUserAbort = currentAbortController === null;
      currentAbortController = null;

      if (wasUserAbort || (err instanceof Error && err.name === "AbortError" && retryCount === 0)) {
        throw new UserInterruptError("Interrupted (Ctrl+C)");
      }

      retryCount++;
      const message = err instanceof Error ? err.message : String(err);
      const retryable = retryCount < RETRY_MAX_ATTEMPTS;

      consecutiveErrors++;
      errorTimestamps.push(Date.now());

      yield {
        type: "error",
        message: `Stream error (attempt ${retryCount}/${RETRY_MAX_ATTEMPTS}): ${message}`,
        retryable,
      };

      if (retryable) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retryCount - 1);
        yield { type: "warning", message: `Retrying in ${delay}ms...` };
        await sleep(delay);
      } else {
        throw new MaxRetriesError(`Max retries exceeded. ${message}`);
      }
    }
  }

  if (!streamResult) {
    throw new Error("Stream failed — no result after retries");
  }

  const { text, toolUses, usage, stopReason } = streamResult;

  // Add assistant message to conversation
  const assistantBlocks: import("../shared/core-types.js").ContentBlock[] = [];
  if (text) {
    assistantBlocks.push({ type: "text", text });
  }
  for (const tu of toolUses) {
    assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
  }
  messages.push({ role: "assistant", content: assistantBlocks });

  // The interactive renderer already streamed this text to the terminal, but
  // non-interactive consumers (notably subagents) need it on the event channel.
  if (text) {
    yield { type: "text", text };
  }

  // ---- Execute tool calls ----
  const readCalls: ToolUseBlock[] = [];
  const writeCalls: ToolUseBlock[] = [];
  let toolDenied = false;

  for (const tu of toolUses) {
    const tool = tools.find((t) => t.name === tu.name);
    if (tool?.type === "read" && tool.isConcurrencySafe) {
      // Check if confirm-mode — serialize confirm tools
      const perm = ctx.permissionManager.check(tu.name, tu.input);
      if (!perm.allowed && "mode" in perm && perm.mode === "confirm" && onConfirmTool) {
        writeCalls.push(tu);
      } else {
        readCalls.push(tu);
      }
    } else {
      writeCalls.push(tu);
    }
  }

  // Execute read tools in parallel
  if (readCalls.length > 0) {
    const readResults = await Promise.all(
      readCalls.map(async (tu) => {
        const result = await executeToolCall(tu, ctx, renderer, onConfirmTool, toolRuntime);
        return { toolUse: tu, result };
      }),
    );

    for (const { toolUse, result } of readResults) {
      if (result.denied) toolDenied = true;
      yield {
        type: "tool_result",
        id: toolUse.id,
        name: toolUse.name,
        result: result.content,
        isError: result.isError ?? false,
      };
    }

    for (const { toolUse, result } of readResults) {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: offloadIfLarge(result.content, toolUse.name),
          is_error: result.isError,
        }],
      });
    }
  }

  // Execute write tools serially (with git hook + deviation checks)
  for (const tu of writeCalls) {
    const toolWarning = planManager.onToolCall(tu.name, tu.input);
    if (toolWarning) {
      yield { type: "warning", message: toolWarning };
    }

    // Git hooks
    if (tu.name === "Bash") {
      const cmd = (tu.input.command as string) ?? "";
      const cdMatch = cmd.match(/\bcd\s+(\S+?)\s*&&/);
      const repoDir = cdMatch ? cdMatch[1].replace(/['"]/g, "") : workingDir;

      if (/\bgit\s+push\b/.test(cmd)) {
        try {
          const pushHook = await prePushHook(repoDir);
          if (pushHook) {
            for (const w of pushHook.warnings) yield { type: "warning", message: w };
            for (const s of pushHook.suggestions) yield { type: "warning", message: `💡 ${s}` };
          }
        } catch { /* best-effort */ }
      }
      if (/\bgit\s+commit\b/.test(cmd)) {
        try {
          const commitHook = await preCommitHook(repoDir, planManager.getActivePlan() as PlanDoc | null);
          if (commitHook) {
            for (const w of commitHook.warnings) yield { type: "warning", message: w };
            for (const s of commitHook.suggestions) yield { type: "warning", message: `💡 ${s}` };
          }
        } catch { /* best-effort */ }
      }
    }

    const result = await executeToolCall(tu, ctx, renderer, onConfirmTool, toolRuntime);
    if (result.denied) toolDenied = true;
    yield {
      type: "tool_result",
      id: tu.id,
      name: tu.name,
      result: result.content,
      isError: result.isError ?? false,
    };

    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: tu.id,
        content: offloadIfLarge(result.content, tu.name),
        is_error: result.isError,
      }],
    });
  }

  return {
    assistantBlocks: text ? [{ type: "text", text }] : [],
    toolUses,
    usage,
    stopReason,
    toolDenied,
  };
}

// ---- Tool execution ----

async function executeToolCall(
  toolUse: ToolUseBlock,
  ctx: AgentContext,
  renderer: StreamRenderer,
  _onConfirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision>,
  toolRuntime?: ToolRuntime,
): Promise<{ content: string; isError: boolean; denied: boolean }> {
  const result: ToolRuntimeResult = toolRuntime
    ? await toolRuntime.execute(toolUse.name, toolUse.input, ctx)
    : await dispatch(toolUse.name, toolUse.input, ctx).then(r => ({
      content: r.content, isError: r.isError ?? false, denied: false,
    }));

  if (result.security?.verdict === "warn") {
    renderer.renderWarning(`⚠️ ${result.security.reason} (risk: ${result.security.risk})`);
  }

  return { content: result.content, isError: result.isError, denied: result.denied };
}

// ---- Circuit breaker ----

let consecutiveErrors = 0;
const errorTimestamps: number[] = [];

function isCircuitBreakerOpen(ts: number[]): boolean {
  const now = Date.now();
  while (ts.length > 0 && ts[0] < now - CIRCUIT_BREAKER_WINDOW_MS) {
    ts.shift();
  }
  return ts.length >= CIRCUIT_BREAKER_THRESHOLD;
}

// ---- Offload large results ----

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

function offloadIfLarge(content: string, toolName: string): string {
  if (content.length <= OFFLOAD_THRESHOLD) return content;

  const dir = "/tmp/rubato-tool-results";
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${toolName}-${randomUUID().slice(0, 8)}.txt`);
  fs.writeFileSync(filePath, content, "utf-8");

  const previewLen = 800;
  const preview = content.slice(0, previewLen);
  return [
    `[Full output (${(content.length / 1024).toFixed(1)}KB) offloaded to ${filePath}]`,
    ``,
    `Preview:`,
    preview,
    content.length > previewLen ? `\n... [use Read ${filePath} to see the full ${(content.length / 1024).toFixed(0)}KB output]` : ``,
  ].join("\n");
}

// ---- Utilities ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Custom errors ----

export class CircuitBreakerError extends Error {
  constructor(message: string) { super(message); this.name = "CircuitBreakerError"; }
}
export class UserInterruptError extends Error {
  constructor(message: string) { super(message); this.name = "UserInterruptError"; }
}
export class MaxRetriesError extends Error {
  constructor(message: string) { super(message); this.name = "MaxRetriesError"; }
}
