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
  AgentControl,
} from "../shared/core-types.js";
import type { AgentEvent } from "../agent/loop.js";
import { dispatch } from "../tools/registry.js";
import { ToolRuntime } from "./tool-runtime.js";
import type { ToolRuntimeResult } from "./tool-runtime.js";
import { prePushHook } from "../tools/git/hooks.js";

// ---- Configuration ----

const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_MAX_RETRIES = 3;
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
  control?: AgentControl;
  toolExecutions: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result: string;
    isError: boolean;
    security?: ToolRuntimeResult["security"];
  }>;
}

export interface ToolTraceEvent {
  phase: "started" | "completed";
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  security?: ToolRuntimeResult["security"];
  startedAt: number;
  durationMs?: number;
  error?: string;
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
  onConfirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision>;
  /** Number of stream retries after the initial attempt. */
  maxRetries?: number;
  abortSignal?: AbortSignal;
  onToolTrace?: (event: ToolTraceEvent) => void;
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
  onActivity?: (activity: string, toolName?: string) => void,
  onTextDelta?: (text: string) => void,
): Promise<StreamResult> {
  let text = "";
  const toolUses: ToolUseBlock[] = [];
  let usage = { input: 0, output: 0 };
  let stopReason: StreamResult["stopReason"] = "end_turn";

  const toolNames = new Map<string, string>();

  for await (const event of provider.chat(params)) {
    onActivity?.("model streaming");
    switch (event.type) {
      case "text_delta":
        text += event.text;
        onTextDelta?.(event.text);
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
          if (name !== "SubmitPlan") renderer.renderToolUse(name, event.input);
        }
        break;

      case "content_block_stop":
        break;

      case "message_stop":
        usage = { input: event.usage.inputTokens, output: event.usage.outputTokens };
        stopReason = event.stopReason as StreamResult["stopReason"];
        break;

      case "error":
        throw new ProviderStreamError(event.message, event.retryable);
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
    renderer, workingDir, ctx, toolRuntime, onConfirmTool,
  } = options;

  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);

  // ---- Call model with retry ----
  let streamResult: StreamResult | null = null;
  let retryCount = 0;

  while (retryCount <= maxRetries) {
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
    const onParentAbort = () => abortController.abort(options.abortSignal?.reason);
    options.abortSignal?.addEventListener("abort", onParentAbort, { once: true });
    if (options.abortSignal?.aborted) abortController.abort(options.abortSignal.reason);
    const exposeAsCurrentRequest = !options.abortSignal;
    if (exposeAsCurrentRequest) currentAbortController = abortController;
    const timeout = setTimeout(() => abortController.abort(), 120_000);

    try {
      streamResult = await processStream(
        provider,
        { model, system: systemPrompt, messages, tools, maxTokens: DEFAULT_MAX_TOKENS, signal: abortController.signal },
        renderer,
        ctx.taskRuntime?.onActivity,
        ctx.taskRuntime?.onTextDelta,
      );

      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", onParentAbort);
      if (exposeAsCurrentRequest) currentAbortController = null;
      consecutiveErrors = 0;
      break;
    } catch (err: unknown) {
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", onParentAbort);
      const wasUserAbort = exposeAsCurrentRequest && currentAbortController === null;
      if (exposeAsCurrentRequest) currentAbortController = null;

      if (wasUserAbort || (err instanceof Error && err.name === "AbortError" && retryCount === 0)) {
        throw new UserInterruptError("Interrupted (Ctrl+C)");
      }

      retryCount++;
      const message = err instanceof Error ? err.message : String(err);
      const providerAllowsRetry =
        !(err instanceof ProviderStreamError) || err.retryable;
      const retryable = providerAllowsRetry && retryCount <= maxRetries;

      consecutiveErrors++;
      errorTimestamps.push(Date.now());

      yield {
        type: "error",
        message: providerAllowsRetry
          ? `Stream error (retry ${retryCount}/${maxRetries}): ${message}`
          : `Stream error (not retryable): ${message}`,
        retryable,
      };

      if (retryable) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retryCount - 1);
        yield { type: "warning", message: `Retrying in ${delay}ms...` };
        await sleep(delay);
      } else if (providerAllowsRetry) {
        throw new MaxRetriesError(`Max retries exceeded. ${message}`);
      } else {
        throw new StreamFailedError(message);
      }
    }
  }

  if (!streamResult) {
    throw new Error("Stream failed — no result after retries");
  }

  const { text, toolUses, usage, stopReason } = streamResult;
  ctx.taskRuntime?.onTextFlush?.();

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
  let control: AgentControl | undefined;
  const toolExecutions: TurnResult["toolExecutions"] = [];
  const completionIndex = toolUses.findIndex((toolUse) => toolUse.name === "SubmitPlan");
  const executableToolUses = completionIndex >= 0
    ? toolUses.slice(0, completionIndex + 1)
    : toolUses;
  ctx.delegationGate?.prepareTurn(executableToolUses.map((toolUse) => ({
    name: toolUse.name,
    input: toolUse.input,
  })));

  for (const tu of executableToolUses) {
    yield { type: "tool_call", id: tu.id, name: tu.name, input: tu.input };
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
        const result = await executeToolCall(
          tu,
          ctx,
          renderer,
          onConfirmTool,
          toolRuntime,
          options.onToolTrace,
        );
        return { toolUse: tu, result };
      }),
    );

    for (const { toolUse, result } of readResults) {
      if (result.denied) toolDenied = true;
      if (result.control) control = result.control;
      toolExecutions.push({
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
        result: result.content,
        isError: result.isError,
        security: result.security,
      });
      yield {
        type: "tool_result",
        id: toolUse.id,
        name: toolUse.name,
        result: result.content,
        isError: result.isError ?? false,
        security: result.security,
      };
    }

    for (const { toolUse, result } of readResults) {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: offloadIfLarge(result.content, toolUse.name, toolUse.input),
          is_error: result.isError,
        }],
      });
    }
  }

  // Execute non-concurrent tools serially.
  for (const tu of writeCalls) {
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
    }

    const result = await executeToolCall(
      tu,
      ctx,
      renderer,
      onConfirmTool,
      toolRuntime,
      options.onToolTrace,
    );
    if (result.denied) toolDenied = true;
    if (result.control) control = result.control;
    toolExecutions.push({
      id: tu.id,
      name: tu.name,
      input: tu.input,
      result: result.content,
      isError: result.isError,
      security: result.security,
    });
    yield {
      type: "tool_result",
      id: tu.id,
      name: tu.name,
      result: result.content,
      isError: result.isError ?? false,
      security: result.security,
    };

    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: tu.id,
        content: offloadIfLarge(result.content, tu.name, tu.input),
        is_error: result.isError,
      }],
    });
    if (result.control) break;
  }

  return {
    assistantBlocks: text ? [{ type: "text", text }] : [],
    toolUses,
    usage,
    stopReason,
    toolDenied,
    control,
    toolExecutions,
  };
}

// ---- Tool execution ----

async function executeToolCall(
  toolUse: ToolUseBlock,
  ctx: AgentContext,
  renderer: StreamRenderer,
  _onConfirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision>,
  toolRuntime?: ToolRuntime,
  onToolTrace?: (event: ToolTraceEvent) => void,
): Promise<{
  content: string;
  isError: boolean;
  denied: boolean;
  control?: AgentControl;
  security?: ToolRuntimeResult["security"];
}> {
  const startedAt = Date.now();
  onToolTrace?.({
    phase: "started",
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input,
    startedAt,
  });
  ctx.taskRuntime?.onActivity?.("tool running", toolUse.name);
  let result: ToolRuntimeResult;
  try {
    result = toolRuntime
      ? await toolRuntime.execute(toolUse.name, toolUse.input, ctx)
      : await dispatch(toolUse.name, toolUse.input, ctx).then(r => ({
        content: r.content, isError: r.isError ?? false, denied: false,
      }));
  } catch (error) {
    onToolTrace?.({
      phase: "completed",
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
      isError: true,
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }

  if (result.security?.verdict === "warn") {
    renderer.renderWarning(`⚠️ ${result.security.reason} (risk: ${result.security.risk})`);
  }

  ctx.taskRuntime?.onActivity?.("tool completed", toolUse.name);
  onToolTrace?.({
    phase: "completed",
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input,
    output: result.content,
    isError: result.isError,
    security: result.security,
    startedAt,
    durationMs: Date.now() - startedAt,
  });
  return {
    content: result.content,
    isError: result.isError,
    denied: result.denied,
    control: result.control,
    security: result.security,
  };
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
import { createHash } from "crypto";

export function offloadIfLarge(
  content: string,
  toolName: string,
  toolInput?: Record<string, unknown>,
): string {
  if (content.length <= OFFLOAD_THRESHOLD) return content;

  const dir = "/tmp/rubato-tool-results";
  fs.mkdirSync(dir, { recursive: true });
  const requestedPath = toolName === "Read" && typeof toolInput?.file_path === "string"
    ? path.resolve(toolInput.file_path)
    : undefined;
  const readingExistingOffload = requestedPath !== undefined &&
    path.dirname(requestedPath) === dir;
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const filePath = readingExistingOffload
    ? requestedPath
    : path.join(dir, `${toolName}-${hash}.txt`);
  if (!readingExistingOffload && !fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, "utf-8");
  }

  const previewLen = 800;
  const preview = content.slice(0, previewLen);
  return [
    readingExistingOffload
      ? `[Large offloaded result remains at ${filePath}; no duplicate copy was created.]`
      : `[Full output (${(content.length / 1024).toFixed(1)}KB) offloaded to ${filePath}]`,
    ``,
    `Preview:`,
    preview,
    content.length > previewLen
      ? readingExistingOffload
        ? `\n... [use Grep or Read with offset/limit on ${filePath}; do not read the whole file again]`
        : `\n... [use Read with offset/limit or Grep on ${filePath} to inspect the full ${(content.length / 1024).toFixed(0)}KB output]`
      : ``,
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
export class StreamFailedError extends Error {
  constructor(message: string) { super(message); this.name = "StreamFailedError"; }
}
export class ProviderStreamError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ProviderStreamError";
  }
}
