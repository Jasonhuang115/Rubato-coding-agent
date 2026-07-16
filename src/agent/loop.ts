// Agent core loop — async generator driving the conversation

import { randomUUID } from "crypto";
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
import { microCompact } from "../context/compression.js";
import { PolicyEngine } from "../permissions/policy.js";
import { ReadGuard } from "./read-guard.js";
import { SessionStore } from "../session/storage.js";
import { createSessionMeta, finalizeSessionMeta } from "../session/meta.js";
import { PlanManager } from "../plan/manager.js";
import { sessionStartRecall } from "../journal/recall.js";
import { persistKnowledge } from "../journal/extractor.js";

// ---- Configuration constants ----

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MAX_TOKENS = 16_384;
const COMPACT_THRESHOLD_MESSAGES = 30;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_WINDOW_MS = 60_000;

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
}

export async function* agentLoop(
  options: AgentLoopOptions
): AsyncGenerator<AgentEvent> {
  const { config, workingDir, prompt, renderer } = options;

  // ---- Setup ----
  const sessionId = options.sessionId ?? randomUUID();
  const provider = createProvider(config.model);
  const tools = options.tools ?? getAllTools();
  const permissionManager = new PolicyEngine(config.permissions);
  const readGuard = new ReadGuard();
  const sessionStore = new SessionStore(sessionId);

  sessionStore.init();

  let sessionMeta = createSessionMeta(
    sessionId,
    `${config.model.provider}/${config.model.model}`,
    undefined
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

  const systemPrompt = buildSystemPrompt(ctx, tools) +
    (contextText ? `\n\n## Project Context\n${contextText}` : "") +
    (journalRecall ? `\n\n${journalRecall}` : "");

  const messages: Message[] = [
    { role: "user", content: prompt },
  ];

  // ---- Error tracking ----
  let consecutiveErrors = 0;
  const errorTimestamps: number[] = [];

  // ---- Main turn loop ----
  for (let turn = 0; turn < DEFAULT_MAX_TURNS; turn++) {
    yield { type: "turn_start", turn: turn + 1 };

    // Compress if too many messages
    if (messages.length > COMPACT_THRESHOLD_MESSAGES) {
      yield { type: "compacting", reason: `Message count ${messages.length} > ${COMPACT_THRESHOLD_MESSAGES}` };
      const compacted = microCompact(messages, Math.floor(COMPACT_THRESHOLD_MESSAGES * 0.7));
      messages.length = 0;
      messages.push(...compacted);
      sessionStore.writeCompaction({ turn, messageCount: messages.length });
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

        // Reset error counters on success
        consecutiveErrors = 0;
        break;
      } catch (err: unknown) {
        clearTimeout(timeout);
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
        renderer.renderUserMessage(nextMessage.trim());
        continue;
      }
      // Non-interactive mode: exit after first turn
      yield { type: "done", reason: stopReason };
      break;
    }

    // ---- Execute tool calls ----
    const readCalls: ToolUseBlock[] = [];
    const writeCalls: ToolUseBlock[] = [];

    for (const tu of toolUses) {
      const tool = tools.find((t) => t.name === tu.name);
      if (tool?.type === "read" && tool.isConcurrencySafe) {
        readCalls.push(tu);
      } else {
        writeCalls.push(tu);
      }
    }

    // Execute read tools in parallel
    if (readCalls.length > 0) {
      const readResults = await Promise.all(
        readCalls.map(async (tu) => {
          const result = await executeToolCall(tu, permissionManager, ctx, renderer);
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
              content: result.content,
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
      const result = await executeToolCall(tu, permissionManager, ctx, renderer);
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
            content: result.content,
            is_error: result.isError,
          },
        ],
      });
    }
  }

  // ---- Finalize ----
  // Extract knowledge from this session into the journal (background, don't block)
  try {
    const extracted = persistKnowledge(messages, sessionId, workingDir);
    if (extracted.saved > 0) {
      yield { type: "warning", message: `📓 从本次对话中提取了 ${extracted.saved} 条知识到 Personal Tech Journal。` };
    }
  } catch {
    // Journal extraction is best-effort
  }

  sessionMeta = finalizeSessionMeta(sessionMeta);
  sessionStore.writeMeta(sessionMeta);
  sessionStore.close();

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
  renderer: StreamRenderer
): Promise<{ content: string; isError: boolean }> {
  // Check permission
  const perm = permissionManager.check(toolUse.name, toolUse.input);

  if (!perm.allowed) {
    if (perm.mode === "manual") {
      return { content: `Permission denied: ${perm.reason}`, isError: true };
    }
    // "confirm" mode — in Phase 1 with pure ANSI, we auto-approve and log
    // Phase 2 (Ink TUI) adds interactive confirmation dialogs
    renderer.renderWarning(`Auto-approved: ${toolUse.name} (confirm mode not interactive yet)`);
  }

  // Dispatch to tool handler
  const result = await dispatch(toolUse.name, toolUse.input, ctx);
  return { content: result.content, isError: result.isError ?? false };
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
