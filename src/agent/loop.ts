// Agent core loop — async generator driving the conversation

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import type {
  ModelProvider,
  AgentConfig,
  AgentContext,
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  StreamEvent,
  StreamRenderer,
  ToolDefinition,
  ConfirmDecision,
} from "../core-types.js";
import { createProvider } from "../model/router.js";
import { getAllTools, dispatch, getReadTools, getWriteTools } from "../tools/registry.js";
import { ContextChain } from "../context/sources.js";
import { ClaudeMdSource } from "../context/claude-md.js";
import { MemoryMdSource } from "../context/memory-md.js";
import { GitStatusSource } from "../context/git-status.js";
import { SoulSource } from "../context/soul.js";
import { MnemosyneSource } from "../context/mnemosyne-source.js";
import { buildSystemPrompt } from "../context/system-prompt.js";
import { microCompact, compactViaSubagent } from "../context/compression.js";
import { microCompactBeforeRequest } from "../context/micro-compact.js";
import { PolicyEngine } from "../permissions/policy.js";
import { ReadGuard } from "./read-guard.js";
import { SessionStore } from "../session/storage.js";
import { createSessionMeta, finalizeSessionMeta } from "../session/meta.js";
import type { SessionManager } from "../session/manager.js";
import { PlanManager } from "../plan/manager.js";
import type { PlanDoc } from "../plan/tree.js";
import { sessionStartRecall } from "../journal/recall.js";
import { persistKnowledge } from "../journal/extractor.js";
import { sessionStartHook, sessionEndHook, prePushHook, preCommitHook, conflictCheckHook } from "../git/hooks.js";

// ---- Configuration constants ----

const DEFAULT_MAX_TURNS = 100;
const DEFAULT_MAX_TOKENS = 16_384;
const OFFLOAD_THRESHOLD = 30_000; // >30KB → disk offload (matching Claude Code); below stays inline
const AUTOCOMPACT_BUFFER = 20_000; // reserve for output tokens + system prompt overhead
const COMPACT_KEEP_RECENT = 120;   // messages to retain after compaction
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_WINDOW_MS = 60_000;
const MAX_COMPACTION_FAILURES = 3; // consecutive failures before disabling auto-compaction

// ---- Agent events ----

export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: string; isError: boolean }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "warning"; message: string }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number; usage?: { input: number; output: number } }
  | { type: "done"; reason: string }
  | { type: "compacting"; reason: string }
  | { type: "waiting_for_input" };

// ---- Main loop ----

export interface AgentLoopOptions {
  config: AgentConfig;
  workingDir: string;
  prompt: string;
  renderer: StreamRenderer;
  sessionId?: string;
  /** Custom tool set. If not provided, uses all registered tools.
   *  Subagents use this to get scoped tools (without AgentTool). */
  tools?: ToolDefinition[];
  /** If set, the agent enters interactive mode: when it finishes a turn,
   *  it calls this callback to get the next user message instead of exiting.
   *  Return empty string or null to end the session. */
  getNextUserMessage?: () => Promise<string | null>;
  /** Set to true to force compaction on next turn (for /compact command) */
  forceCompaction?: boolean;
  /** Set to true to skip auto-compaction (recursion guard for compact subagent) */
  skipCompaction?: boolean;
  /** Interactive confirmation callback. Called when a tool in "confirm" mode
   *  is about to execute. If not provided, confirm-mode tools are auto-approved
   *  with a warning (current behavior). */
  onConfirmTool?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<ConfirmDecision>;
  /** Session manager for project-scoped session lifecycle (main sessions only) */
  sessionManager?: SessionManager;
  /** If provided, inject this summary as previous session context */
  resumeSummary?: string;
}

// ---- Abort mechanism (exposed for Ctrl+C interrupt) ----

let currentAbortController: AbortController | null = null;

/** Abort the currently in-flight model request. Safe to call from signal handlers. */
export function abortCurrentRequest(): void {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null; // signal that this was a user interrupt
  }
}

export async function* agentLoop(
  options: AgentLoopOptions
): AsyncGenerator<AgentEvent> {
  const { config, workingDir, prompt, renderer } = options;

  // ---- Setup ----
  const sessionId = options.sessionId ?? randomUUID();
  let provider = createProvider(config.model);
  const tools = options.tools ?? getAllTools();
  const permissionManager = new PolicyEngine(config.permissions);
  const readGuard = new ReadGuard();

  // Use project-scoped storage when sessionManager is available
  const projectHash = options.sessionManager?.getProjectHash();
  const sessionStore = new SessionStore(sessionId, projectHash);

  sessionStore.init();

  let sessionMeta = createSessionMeta(
    sessionId,
    `${config.model.provider}/${config.model.model}`,
    undefined,
    { firstMessage: prompt.slice(0, 200) },
  );

  // ---- Plan Manager ----
  const planManager = new PlanManager(workingDir);

  // Build context chain
  const contextChain = new ContextChain();
  contextChain.register(new SoulSource());
  contextChain.register(new ClaudeMdSource());
  contextChain.register(new MemoryMdSource());
  contextChain.register(new MnemosyneSource());
  contextChain.register(new GitStatusSource());

  // Agent context passed to every tool
  const ctx: AgentContext = {
    workingDir,
    sessionId,
    readGuard,
    permissionManager,
    config,
    planManager,
  };

  // ---- Build messages ----

  const contextBlocks = await contextChain.fetchAll(prompt, ctx);
  const contextText = contextBlocks.map((b) => b.content).join("\n\n");

  // Journal recall: inject relevant past knowledge
  const journalRecall = sessionStartRecall(workingDir);

  // Git branch health at session start
  const gitHealth = await sessionStartHook(workingDir).catch(() => null);

  // Check for ongoing merge conflicts
  const conflictWarning = await conflictCheckHook(workingDir).catch(() => null);

  const systemPrompt = buildSystemPrompt(ctx, tools) +
    (contextText ? `\n\n## Project Context\n${contextText}` : "") +
    (journalRecall ? `\n\n${journalRecall}` : "") +
    (gitHealth ? `\n\n${gitHealth}` : "") +
    (conflictWarning ? `\n\n${conflictWarning}` : "") +
    (options.resumeSummary ? `\n\n## Previous Session Context\nThe following is a summary of a previous session in this project. Use this context to understand what was previously discussed:\n\n${options.resumeSummary}` : "");

  // System prompt tokens — counted once since it's sent on every API call
  const systemTokens = roughTokenEstimate(systemPrompt);

  const messages: Message[] = [
    { role: "user", content: prompt },
  ];

  // ---- Error tracking ----
  let consecutiveErrors = 0;
  let consecutiveCompactionFailures = 0;
  const errorTimestamps: number[] = [];

  // ---- Main turn loop ----
  for (let turn = 0; turn < DEFAULT_MAX_TURNS; turn++) {
    // Support dynamic model/provider switching via /model command
    if (provider.name !== config.model.provider) {
      provider = createProvider(config.model);
      yield { type: "warning", message: `Switched to ${config.model.provider}/${config.model.model}` };
    }

    yield { type: "turn_start", turn: turn + 1 };

    // Compaction check: token-based with dynamic threshold per model.
    // System prompt tokens are included since they're sent on every API call.
    // Skip if recursion guard is set (compact subagent should not compact).
    if (!options.skipCompaction) {
      const approxTokens = estimateMessageTokens(messages) + systemTokens;
      const threshold = getAutoCompactThreshold(config.model.model);
      const forceCompact = options.forceCompaction;
      if (forceCompact || approxTokens > threshold) {
        if (forceCompact) options.forceCompaction = false; // reset
        const reason = forceCompact
          ? "User requested compaction"
          : `~${Math.round(approxTokens / 1000)}K / ${Math.round(threshold / 1000)}K tokens (${config.model.model})`;
        yield { type: "compacting", reason };

        try {
          const compacted = await compactViaSubagent(messages, ctx, config, COMPACT_KEEP_RECENT);
          messages.length = 0;
          messages.push(...compacted);

          // Post-compact restoration: inject recently accessed files so the
          // model doesn't need to re-Read them after compaction.
          const snapshot = readGuard.serialize();
          const recentFiles = Object.entries(snapshot.files)
            .sort(([, a], [, b]) => b.timestamp - a.timestamp)
            .slice(0, 3)
            .map(([fp]) => fp);
          if (recentFiles.length > 0) {
            messages.push({
              role: "user",
              content: `[Recently accessed files after compaction: ${recentFiles.join(", ")}. You may want to re-read these if you need their current content.]`,
            });
          }

          consecutiveCompactionFailures = 0;
          sessionStore.writeCompaction({ turn, messageCount: messages.length });
        } catch {
          // Compaction circuit breaker: track consecutive failures
          consecutiveCompactionFailures++;
          if (consecutiveCompactionFailures >= MAX_COMPACTION_FAILURES) {
            yield {
              type: "warning",
              message: `Compaction failed ${consecutiveCompactionFailures} times — disabling auto-compaction for this session.`,
            };
            options.skipCompaction = true;
          } else {
            yield {
              type: "warning",
              message: `Compaction failed (${consecutiveCompactionFailures}/${MAX_COMPACTION_FAILURES}) — falling back to string-based microCompact.`,
            };
            const compacted = microCompact(messages, COMPACT_KEEP_RECENT);
            messages.length = 0;
            messages.push(...compacted);
            sessionStore.writeCompaction({ turn, messageCount: messages.length });
          }
        }
      }
    }

    // Micro-compact: clear stale tool results before the API request.
    // Lightweight, no LLM cost — only fires when the gap since last
    // assistant message exceeds the cache-TTL threshold.
    {
      const mcResult = microCompactBeforeRequest(messages);
      if (mcResult.cleared > 0) {
        messages.length = 0;
        messages.push(...mcResult.messages);
        yield { type: "warning", message: `Micro-compact: cleared ${mcResult.cleared} stale tool result(s)` };
      }
    }

    // ---- Call model with retry ----
    let streamResult: StreamResult | null = null;
    let retryCount = 0;

    while (retryCount <= RETRY_MAX_ATTEMPTS) {
      // Check circuit breaker
      if (isCircuitBreakerOpen(errorTimestamps)) {
        yield {
          type: "error",
          message: "Circuit breaker open — too many errors. Please check your API connection and try again.",
          retryable: false,
        };
        yield { type: "done", reason: "circuit_breaker" };
        return;
      }

      const abortController = new AbortController();
      currentAbortController = abortController;
      const timeout = setTimeout(() => abortController.abort(), 120_000); // 2 min timeout

      try {
        streamResult = await processStream(
          provider,
          {
            model: config.model.model,
            system: systemPrompt,
            messages,
            tools,
            maxTokens: DEFAULT_MAX_TOKENS,
            signal: abortController.signal,
          },
          renderer
        );

        clearTimeout(timeout);
        currentAbortController = null;

        // Reset error counters on success
        consecutiveErrors = 0;
        break;
      } catch (err: unknown) {
        clearTimeout(timeout);
        const wasUserAbort = currentAbortController === null; // cleared by external abortCurrentRequest()
        currentAbortController = null;

        // User pressed Ctrl+C — don't retry, return to REPL
        if (wasUserAbort || (err instanceof Error && err.name === "AbortError" && retryCount === 0)) {
          yield { type: "warning", message: "Interrupted (Ctrl+C)" };
          yield { type: "done", reason: "user_interrupt" };
          return;
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
          yield {
            type: "warning",
            message: `Retrying in ${delay}ms...`,
          };
          await sleep(delay);
        } else {
          yield {
            type: "error",
            message: `Max retries exceeded. ${message}`,
            retryable: false,
          };
          yield { type: "done", reason: "max_retries" };
          return;
        }
      }
    }

    if (!streamResult) {
      yield { type: "done", reason: "stream_failed" };
      return;
    }

    // ---- Process results ----
    const { text, toolUses, usage, stopReason } = streamResult;

    // Add assistant message
    const assistantBlocks: ContentBlock[] = [];
    if (text) {
      assistantBlocks.push({ type: "text", text });
    }
    for (const tu of toolUses) {
      assistantBlocks.push({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
        input: tu.input,
      });
    }
    messages.push({ role: "assistant", content: assistantBlocks });

    sessionStore.writeMessage({ role: "assistant", blocks: assistantBlocks });
    sessionMeta.messageCount = (sessionMeta.messageCount ?? 0) + 1;
    if (usage) {
      sessionMeta.totalTokens += usage.input + usage.output;
    }

    yield {
      type: "turn_end",
      turn: turn + 1,
      usage: usage ? { input: usage.input, output: usage.output } : undefined,
    };

    // ---- End turn? ----
    if (stopReason === "end_turn" || toolUses.length === 0) {
      // Interactive mode: wait for more user input
      if (options.getNextUserMessage) {
        yield { type: "waiting_for_input" };
        const nextMessage = await options.getNextUserMessage();
        if (!nextMessage || !nextMessage.trim()) {
          yield { type: "done", reason: "user_exit" };
          break;
        }
        // Grill Me: check deviation
        const deviationWarning = planManager.onUserMessage(nextMessage.trim());
        if (deviationWarning) {
          yield { type: "warning", message: deviationWarning };
        }

        messages.push({ role: "user", content: nextMessage.trim() });
        sessionStore.writeMessage({ role: "user", content: nextMessage.trim() });
        sessionMeta.messageCount = (sessionMeta.messageCount ?? 0) + 1;
        // Don't renderUserMessage — readline already echoes user input
        continue;
      }
      // Non-interactive mode: exit after first turn
      yield { type: "done", reason: stopReason };
      break;
    }

    // ---- Execute tool calls ----
    const readCalls: ToolUseBlock[] = [];
    const writeCalls: ToolUseBlock[] = [];
    let toolDenied = false;

    for (const tu of toolUses) {
      const tool = tools.find((t) => t.name === tu.name);
      if (tool?.type === "read" && tool.isConcurrencySafe) {
        // Check if this tool needs confirmation — confirm-mode tools
        // must NOT run in parallel (readline can only handle one question at a time)
        const perm = permissionManager.check(tu.name, tu.input);
        if (!perm.allowed && perm.mode === "confirm" && options.onConfirmTool) {
          writeCalls.push(tu); // serialize confirm-mode tools
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
          const result = await executeToolCall(tu, permissionManager, ctx, renderer, options.onConfirmTool);
          sessionStore.writeToolEvent({
            tool: tu.name,
            input: tu.input,
            result: result.content,
            isError: result.isError,
          });
          return { toolUse: tu, result };
        })
      );

      // Yield events after all reads complete (can't yield inside async callbacks)
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
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: offloadIfLarge(result.content, toolUse.name),
              is_error: result.isError,
            },
          ],
        });
      }
    }

    // Execute write tools serially (with deviation check)
    for (const tu of writeCalls) {
      const toolWarning = planManager.onToolCall(tu.name, tu.input);
      if (toolWarning) {
        yield { type: "warning", message: toolWarning };
      }

      // Git hooks: pre-push / pre-commit checks
      if (tu.name === "Bash") {
        const cmd = (tu.input.command as string) ?? "";
        if (/\bgit\s+push\b/.test(cmd)) {
          const pushHook = await prePushHook(workingDir).catch(() => null);
          if (pushHook) {
            for (const w of pushHook.warnings) yield { type: "warning", message: w };
            for (const s of pushHook.suggestions) yield { type: "warning", message: `💡 ${s}` };
          }
        }
        if (/\bgit\s+commit\b/.test(cmd)) {
          const commitHook = await preCommitHook(workingDir, planManager.getActivePlan() as PlanDoc | null).catch(() => null);
          if (commitHook) {
            for (const w of commitHook.warnings) yield { type: "warning", message: w };
            for (const s of commitHook.suggestions) yield { type: "warning", message: `💡 ${s}` };
          }
        }
      }

      const result = await executeToolCall(tu, permissionManager, ctx, renderer, options.onConfirmTool);
      if (result.denied) toolDenied = true;
      yield {
        type: "tool_result",
        id: tu.id,
        name: tu.name,
        result: result.content,
        isError: result.isError ?? false,
      };
      sessionStore.writeToolEvent({
        tool: tu.name,
        input: tu.input,
        result: result.content,
        isError: result.isError,
      });

      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: tu.id,
            content: offloadIfLarge(result.content, tu.name),
            is_error: result.isError,
          },
        ],
      });
    }

    // ---- Stop turn if user explicitly denied any tool ----
    if (toolDenied) {
      yield { type: "warning", message: "Tool denied — stopping for your input." };
      if (options.getNextUserMessage) {
        yield { type: "waiting_for_input" };
        const nextMessage = await options.getNextUserMessage();
        if (!nextMessage || !nextMessage.trim()) {
          yield { type: "done", reason: "user_exit" };
          break;
        }
        const deviationWarning = planManager.onUserMessage(nextMessage.trim());
        if (deviationWarning) {
          yield { type: "warning", message: deviationWarning };
        }
        messages.push({ role: "user", content: nextMessage.trim() });
        sessionStore.writeMessage({ role: "user", content: nextMessage.trim() });
        sessionMeta.messageCount = (sessionMeta.messageCount ?? 0) + 1;
        // Don't renderUserMessage — readline already echoes user input
        continue;
      }
      // Non-interactive mode: stop immediately
      yield { type: "done", reason: "tool_denied" };
      break;
    }
  }

  // ---- Finalize ----
  // Git workflow learning at session end
  try {
    const gitEnd = await sessionEndHook(workingDir).catch(() => null);
    if (gitEnd && gitEnd.advice.length > 0) {
      for (const a of gitEnd.advice.slice(0, 3)) {
        yield { type: "warning", message: `📐 ${a}` };
      }
    }
  } catch {
    // Best-effort
  }

  // Extract knowledge into Mnemosyne (not old Journal)
  try {
    const extracted = persistKnowledge(messages, sessionId, workingDir);
    if (extracted.saved > 0) {
      yield { type: "warning", message: `🧠 从本次对话中提取了 ${extracted.saved} 条知识到 Mnemosyne 记忆图谱。` };
    }
  } catch {
    // Best-effort
  }

  // Trigger Consolidator if conditions are met
  try {
    const { shouldConsolidate, consolidateMemories } = await import("../memory/consolidator.js");
    if (shouldConsolidate()) {
      const result = await consolidateMemories();
      if (result.merged > 0 || result.abstracted > 0 || result.deleted > 0) {
        yield { type: "warning", message: `🧹 Mnemosyne 后台整理完成：合并 ${result.merged} | 抽象 ${result.abstracted} | 清理 ${result.deleted} | 降级 ${result.deprecated}` };
      }
    }
  } catch {
    // Best-effort
  }

  sessionMeta = finalizeSessionMeta(sessionMeta);

  if (options.sessionManager) {
    // Use SessionManager for project-scoped finalization
    sessionStore.writeMeta(sessionMeta);
    sessionStore.close();
    options.sessionManager.updateSession(sessionId, {
      messageCount: sessionMeta.messageCount ?? 0,
      tokenCount: sessionMeta.totalTokens,
      status: "ended",
      summary: sessionMeta.summary,
    });
  } else {
    sessionStore.writeMeta(sessionMeta);
    sessionStore.close();
  }

  yield { type: "done", reason: "max_turns" };
}

// ---- Stream processing ----

interface StreamResult {
  text: string;
  toolUses: ToolUseBlock[];
  usage: { input: number; output: number };
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

async function processStream(
  provider: ModelProvider,
  params: {
    model: string;
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
    maxTokens: number;
    signal: AbortSignal;
  },
  renderer: StreamRenderer
): Promise<StreamResult> {
  let text = "";
  const toolUses: ToolUseBlock[] = [];
  const toolAccumulators = new Map<
    string,
    { id: string; name: string; partialJson: string }
  >();
  let usage = { input: 0, output: 0 };
  let stopReason: StreamResult["stopReason"] = "end_turn";

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
        toolAccumulators.set(event.id, {
          id: event.id,
          name: event.name,
          partialJson: "",
        });
        break;

      case "tool_use_delta":
        {
          const acc = toolAccumulators.get(event.id);
          if (acc) {
            acc.partialJson += event.partialJson;
          }
        }
        break;

      case "tool_use_end":
        {
          const acc = toolAccumulators.get(event.id);
          if (acc) {
            toolUses.push({
              type: "tool_use",
              id: event.id,
              name: acc.name,
              input: event.input,
            });
            renderer.renderToolUse(acc.name, event.input);
            toolAccumulators.delete(event.id);
          }
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

  // Flush any pending output
  renderer.flush();

  return { text, toolUses, usage, stopReason };
}

// ---- Tool execution ----

async function executeToolCall(
  toolUse: ToolUseBlock,
  permissionManager: PolicyEngine,
  ctx: AgentContext,
  renderer: StreamRenderer,
  onConfirmTool?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<ConfirmDecision>,
): Promise<{ content: string; isError: boolean; denied: boolean }> {
  // Check permission
  const perm = permissionManager.check(toolUse.name, toolUse.input);

  if (!perm.allowed) {
    if (perm.mode === "manual") {
      return { content: `Permission denied: ${perm.reason}`, isError: true, denied: false };
    }

    // "confirm" mode — ask user interactively if callback is provided
    if (onConfirmTool) {
      const decision = await onConfirmTool(toolUse.name, toolUse.input);
      switch (decision) {
        case "allow_once":
          break; // proceed
        case "allow_always":
          permissionManager.allowTool(toolUse.name);
          break; // proceed + remember
        case "deny_once":
          return { content: `User denied: ${toolUse.name}`, isError: true, denied: true };
        case "deny_always":
          permissionManager.denyTool(toolUse.name);
          return { content: `User denied (all future ${toolUse.name} blocked this session)`, isError: true, denied: true };
      }
    } else {
      // No callback: auto-approve with warning (subagents, one-shot, etc.)
      renderer.renderWarning(`Auto-approved: ${toolUse.name} (confirm mode not interactive yet)`);
    }
  }

  // Dispatch to tool handler
  const result = await dispatch(toolUse.name, toolUse.input, ctx);
  return { content: result.content, isError: result.isError ?? false, denied: false };
}

// ---- Circuit breaker ----

function isCircuitBreakerOpen(errorTimestamps: number[]): boolean {
  const now = Date.now();
  // Remove old entries
  while (
    errorTimestamps.length > 0 &&
    errorTimestamps[0] < now - CIRCUIT_BREAKER_WINDOW_MS
  ) {
    errorTimestamps.shift();
  }
  return errorTimestamps.length >= CIRCUIT_BREAKER_THRESHOLD;
}

// ---- Utilities ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Offload large tool results to disk (Claude Code pattern: >30KB → file).
 *  Model gets the file path + a preview — it can Read to see the full output.
 *  Below threshold, content passes through unchanged. */
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

// ---- Token estimation (CJK-aware) ----

/**
 * Rough token count for a single string. CJK characters (~1.5 tokens/char)
 * and ASCII (~0.25 tokens/char ≈ 4 chars/token) are counted separately.
 * Mirrors Claude Code's roughTokenCountEstimation pattern.
 */
function roughTokenEstimate(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK Unified Ideographs + Ext-A, CJK punctuation, fullwidth forms
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Ext-A
      (code >= 0x3000 && code <= 0x303f) ||   // CJK punctuation
      (code >= 0xff00 && code <= 0xffef)      // Fullwidth forms
    ) {
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return tokens;
}

/**
 * Estimate tokens for a message array, counting each content block by type.
 * Pads by 4/3 to be conservative (matching Claude Code's estimateMessageTokens).
 */
function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += roughTokenEstimate(msg.content);
      continue;
    }
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          total += roughTokenEstimate(block.text);
          break;
        case "tool_result":
          total += roughTokenEstimate(block.content ?? "");
          break;
        case "tool_use":
          total += roughTokenEstimate(block.name + JSON.stringify(block.input));
          break;
      }
    }
  }
  return Math.ceil(total * (4 / 3));
}

// ---- Dynamic compaction threshold ----

/** Known context window sizes per model. Default 128K for unknown models. */
function getEffectiveContextWindow(model: string): number {
  const CONTEXT_WINDOWS: Record<string, number> = {
    "deepseek-chat": 1_000_000,
    "deepseek-reasoner": 1_000_000,
    "deepseek-v4-pro": 1_000_000,
    "claude-sonnet-4-20250514": 200_000,
    "claude-opus-4-20250514": 200_000,
    "gpt-4o": 128_000,
    "gpt-4-turbo": 128_000,
  };
  return CONTEXT_WINDOWS[model] ?? 128_000;
}

/** Dynamic threshold = context window - max output - safety buffer */
function getAutoCompactThreshold(model: string): number {
  return getEffectiveContextWindow(model) - AUTOCOMPACT_BUFFER;
}
