// Agent core loop — async generator driving the conversation.
// Refactored to delegate to Runtime modules:
//   - ContextAssembler (context building)
//   - CompactionController (context window management)
//   - StepExecutor (model call + tool dispatch)
//   - ToolRuntime (security enforcement)
//
// The loop itself now focuses on orchestration: setup, turn iteration, finalize.

import { randomUUID } from "crypto";
import type {
  ModelProvider,
  AgentConfig,
  AgentContext,
  Message,
  StreamRenderer,
  ToolDefinition,
  ConfirmDecision,
  BudgetManager,
} from "../shared/core-types.js";
import { createProvider } from "../model/router.js";
import { getAllTools } from "../tools/registry.js";
import { SecurityRuntime } from "../security/runtime.js";
import { ToolRuntime } from "../runtime/tool-runtime.js";
import { ReadGuard } from "./read-guard.js";
import { SessionStore } from "../runtime/session/storage.js";
import { createSessionMeta, finalizeSessionMeta } from "../runtime/session/meta.js";
import type { SessionManager } from "../runtime/session/manager.js";
import { PlanManager } from "../agent/planner/manager.js";
import { persistKnowledge } from "../memory/journal/extractor.js";
import { getMnemosyneStore } from "../memory/store.js";
import { hasAssistantResponse, recordAttributedMemoryReferences } from "../memory/attribution.js";
import { sessionEndHook } from "../tools/git/hooks.js";
import { assembleContext } from "../runtime/context-assembler.js";
import { checkAndCompact, runMicroCompact } from "../runtime/compaction-controller.js";
import { executeTurn, UserInterruptError, CircuitBreakerError, MaxRetriesError } from "../runtime/step-executor.js";
import { getRequiredDelegation } from "./delegation-policy.js";

// ---- Configuration ----

const DEFAULT_MAX_TURNS = 100;

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

// ---- Abort mechanism (delegates to StepExecutor) ----

import { getAbortController, setAbortController } from "../runtime/step-executor.js";

export function abortCurrentRequest(): void {
  const ac = getAbortController();
  if (ac) {
    ac.abort();
    setAbortController(null);
  }
}

// ---- Options ----

export interface AgentLoopOptions {
  config: AgentConfig;
  workingDir: string;
  prompt: string;
  renderer: StreamRenderer;
  sessionId?: string;
  tools?: ToolDefinition[];
  getNextUserMessage?: () => Promise<string | null>;
  forceCompaction?: boolean;
  skipCompaction?: boolean;
  onConfirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision>;
  sessionManager?: SessionManager;
  resumeSummary?: string;
  depth?: number;
  budgetManager?: BudgetManager;
  maxTurns?: number;
}

// ---- Main loop ----

export async function* agentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent> {
  const { config, workingDir, prompt, renderer } = options;

  // ---- Setup ----
  const sessionId = options.sessionId ?? randomUUID();
  let provider = createProvider(config.model);
  const tools = options.tools ?? getAllTools();

  // Security + Tool runtime
  const securityRuntime = new SecurityRuntime(config.permissions);
  const permissionManager = securityRuntime.policyEngine;
  const toolRuntime = new ToolRuntime({
    securityRuntime,
    workingDir,
    onConfirmTool: options.onConfirmTool,
  });

  const readGuard = new ReadGuard();

  // Session storage
  const projectHash = options.sessionManager?.getProjectHash();
  const sessionStore = new SessionStore(sessionId, projectHash);
  sessionStore.init();

  let sessionMeta = createSessionMeta(
    sessionId,
    `${config.model.provider}/${config.model.model}`,
    undefined,
    { firstMessage: prompt.slice(0, 200) },
  );

  // Plan manager
  const planManager = new PlanManager(workingDir);

  // Agent context
  const ctx: AgentContext = {
    workingDir,
    sessionId,
    readGuard,
    permissionManager,
    config,
    planManager,
    depth: options.depth ?? 0,
    budgetManager: options.budgetManager,
  };

  // ---- Build system prompt via ContextAssembler ----
  const { systemPrompt, systemTokens } = await assembleContext({
    workingDir,
    prompt,
    ctx,
    tools,
    providerName: config.model.provider,
    resumeSummary: options.resumeSummary,
  });

  // ---- Initialize messages ----
  const messages: Message[] = [
    { role: "user", content: prompt },
  ];

  // Broad project exploration is a deterministic delegation boundary. Relying
  // on model tool choice made identical requests delegate inconsistently.
  const requiredDelegation = getRequiredDelegation(prompt, options.depth ?? 0, tools);
  if (requiredDelegation) {
    const toolUseId = `auto-delegate-${randomUUID()}`;
    const toolInput = {
      description: requiredDelegation.description,
      prompt: requiredDelegation.prompt,
      subagent_type: requiredDelegation.subagentType,
    };

    renderer.renderToolUse("Agent", toolInput);
    yield { type: "tool_call", id: toolUseId, name: "Agent", input: toolInput };

    const delegated = await toolRuntime.execute("Agent", toolInput, ctx);
    yield {
      type: "tool_result",
      id: toolUseId,
      name: "Agent",
      result: delegated.content,
      isError: delegated.isError,
    };

    messages[0] = {
      role: "user",
      content: [
        prompt,
        "",
        "[Runtime-provided Explore subagent result]",
        delegated.content,
        "",
        "Use this delegated report to answer the original request. Read its full-report path only if the preview is insufficient. Do not repeat the exploration yourself.",
      ].join("\n"),
    };
  }

  // ---- Compaction tracking ----
  let consecutiveCompactionFailures = 0;
  let skipAutoCompact = options.skipCompaction ?? false;

  // ---- Main turn loop ----
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  let doneReason: string | null = null;
  let hadAssistantResponse = false;

  for (let turn = 0; turn < maxTurns && !doneReason; turn++) {
    // Dynamic provider switching
    if (provider.name !== config.model.provider) {
      provider = createProvider(config.model);
      yield { type: "warning", message: `Switched to ${config.model.provider}/${config.model.model}` };
    }

    yield { type: "turn_start", turn: turn + 1 };

    // ---- Compaction ----
    const compactResult = await checkAndCompact({
      messages,
      systemTokens,
      model: config.model.model,
      forceCompact: options.forceCompaction,
      skipCompaction: skipAutoCompact,
      ctx,
      config,
      readGuard,
      consecutiveFailures: consecutiveCompactionFailures,
    });

    if (options.forceCompaction) options.forceCompaction = false;

    if (compactResult.compacted) {
      yield { type: "compacting", reason: compactResult.reason ?? "Auto-compaction" };
      messages.length = 0;
      messages.push(...compactResult.messages);
      sessionStore.writeCompaction({ turn, messageCount: messages.length });
    }

    if (compactResult.disableAutoCompact) {
      yield { type: "warning", message: compactResult.reason ?? "Auto-compaction disabled" };
      skipAutoCompact = true;
    }

    // Track compaction failures
    if (compactResult.compacted && compactResult.reason?.includes("failed")) {
      consecutiveCompactionFailures++;
    } else if (compactResult.compacted) {
      consecutiveCompactionFailures = 0;
    }

    // ---- Micro-compact ----
    const mcResult = runMicroCompact(messages);
    if (mcResult.cleared) {
      messages.length = 0;
      messages.push(...mcResult.messages);
      yield { type: "warning", message: `Micro-compact: cleared ${mcResult.count} stale tool result(s)` };
    }

    // ---- Execute turn via StepExecutor ----
    let turnResult;
    try {
      turnResult = yield* executeTurn({
        provider,
        model: config.model.model,
        systemPrompt,
        messages,
        tools,
        renderer,
        workingDir,
        ctx,
        toolRuntime,
        planManager,
        onConfirmTool: options.onConfirmTool,
      });
    } catch (err) {
      if (err instanceof UserInterruptError) {
        yield { type: "warning", message: "Interrupted (Ctrl+C)" };
        doneReason = "user_interrupt";
        break;
      }
      if (err instanceof CircuitBreakerError) {
        doneReason = "circuit_breaker";
        break;
      }
      if (err instanceof MaxRetriesError) {
        doneReason = "max_retries";
        break;
      }
      // Unknown error
      yield { type: "error", message: String(err), retryable: false };
      doneReason = "stream_failed";
      break;
    }

    const { toolUses, usage, stopReason, toolDenied } = turnResult;

    if (hasAssistantResponse(messages)) {
      hadAssistantResponse = true;
      try {
        recordAttributedMemoryReferences(messages, sessionId, getMnemosyneStore());
      } catch { /* best-effort */ }
    }

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
      if (options.getNextUserMessage) {
        yield { type: "waiting_for_input" };
        const nextMessage = await options.getNextUserMessage();
        if (!nextMessage || !nextMessage.trim()) {
          doneReason = "user_exit";
          break;
        }
        const deviationWarning = planManager.onUserMessage(nextMessage.trim());
        if (deviationWarning) {
          yield { type: "warning", message: deviationWarning };
        }
        messages.push({ role: "user", content: nextMessage.trim() });
        sessionStore.writeMessage({ role: "user", content: nextMessage.trim() });
        sessionMeta.messageCount = (sessionMeta.messageCount ?? 0) + 1;
        continue;
      }
      doneReason = stopReason;
      break;
    }

    // ---- Tool denied → interactive wait ----
    if (toolDenied) {
      yield { type: "warning", message: "Tool denied — stopping for your input." };
      if (options.getNextUserMessage) {
        yield { type: "waiting_for_input" };
        const nextMessage = await options.getNextUserMessage();
        if (!nextMessage || !nextMessage.trim()) {
          doneReason = "user_exit";
          break;
        }
        const deviationWarning = planManager.onUserMessage(nextMessage.trim());
        if (deviationWarning) {
          yield { type: "warning", message: deviationWarning };
        }
        messages.push({ role: "user", content: nextMessage.trim() });
        sessionStore.writeMessage({ role: "user", content: nextMessage.trim() });
        sessionMeta.messageCount = (sessionMeta.messageCount ?? 0) + 1;
        continue;
      }
      doneReason = "tool_denied";
      break;
    }
  }

  if (!doneReason) {
    doneReason = "max_turns";
  }

  // ---- Finalize ----
  try {
    const gitEnd = await sessionEndHook(workingDir).catch(() => null);
    if (gitEnd && gitEnd.advice.length > 0) {
      for (const a of gitEnd.advice.slice(0, 3)) {
        yield { type: "warning", message: `📐 ${a}` };
      }
    }
  } catch { /* best-effort */ }

  // Knowledge extraction
  try {
    const extracted = persistKnowledge(messages, sessionId, workingDir);
    if (extracted.saved > 0) {
      yield { type: "warning", message: `🧠 从本次对话中提取了 ${extracted.saved} 条知识到 Mnemosyne 记忆图谱。` };
    }
  } catch { /* best-effort */ }

  // Self-evolving RAG feedback
  try {
    const store = getMnemosyneStore();
    if (hadAssistantResponse || hasAssistantResponse(messages)) {
      recordAttributedMemoryReferences(messages, sessionId, store);
      store.markIgnoredForSession(sessionId);
    }
    store.autoTuneStrategyWeights();
  } catch { /* best-effort */ }

  // Lazy consolidation
  try {
    const store = getMnemosyneStore();
    const pendingConsolidations = store.getPendingConsolidations();
    if (pendingConsolidations.length > 0) {
      yield { type: "warning", message: `🧠 记忆系统检测到 ${pendingConsolidations.length} 组相似记忆等待合并，将在后台处理...` };
      const { consolidateMemories, parseConsolidationJson } = await import("../memory/consolidator.js");
      const result = await consolidateMemories({
        summarizer: async (cluster) => {
          const memories = cluster.entities.map((entity) => ({
            id: entity.id,
            name: entity.name,
            type: entity.type,
            confidence: entity.confidence,
            status: entity.status,
            content: entity.content.slice(0, 700),
          }));
          const prompt = [
            "Consolidate these related long-term memories for a personal coding agent.",
            "Return only one JSON object with these fields:",
            `{"action":"create_principle|merge|keep_separate","name":"short stable key","type":"concept|config|error|api|deploy|dependency|test|note|file|function|class","summary":"stable reusable memory","scope":"when to use it","confidence":0.0,"validity":"when to review or invalidate","conflicts":["optional conflict notes"]}`,
            "Prefer keep_separate when the memories are merely keyword-similar but do not support one reusable fact, preference, or project convention.",
            "",
            `Subject: ${cluster.subject}`,
            `Cohesion: ${cluster.cohesion.toFixed(3)}`,
            `Memories: ${JSON.stringify(memories)}`,
          ].join("\n");

          let raw = "";
          for await (const event of provider.chat({
            model: config.model.model,
            system: "You are Mnemosyne's memory consolidator. Produce compact, conservative JSON. Do not call tools.",
            messages: [{ role: "user", content: prompt }],
            tools: [],
            maxTokens: 700,
          })) {
            if (event.type === "text_delta") raw += event.text;
            if (event.type === "error") return null;
          }
          return parseConsolidationJson(raw, cluster.entities[0]?.type ?? "concept");
        },
      });
      if (result.merged > 0 || result.abstracted > 0) {
        yield { type: "warning", message: `🧹 Mnemosyne 合并完成：合并 ${result.merged} | 抽象 ${result.abstracted} | 清理 ${result.deleted}` };
      }
    }
  } catch { /* best-effort */ }

  sessionMeta = finalizeSessionMeta(sessionMeta);

  if (options.sessionManager) {
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

  yield { type: "done", reason: doneReason };
}
