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
  AgentConfig,
  AgentContext,
  Message,
  StreamRenderer,
  ToolDefinition,
  ConfirmDecision,
  CompleteTaskInput,
  SubagentRuntimeContext,
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
import {
  executeTurn,
  UserInterruptError,
  CircuitBreakerError,
  MaxRetriesError,
  StreamFailedError,
} from "../runtime/step-executor.js";
import { processSubagentRegistry } from "./subagents/registry.js";
import type { TaskInboxEvent } from "./subagents/conversation-inbox.js";
import { RootDelegationGate } from "./delegation-gate.js";

// ---- Configuration ----

const DEFAULT_MAX_TURNS = 100;

// ---- Agent events ----

export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      id: string;
      name: string;
      result: string;
      isError: boolean;
      security?: { verdict: string; risk: string; reason: string };
    }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "warning"; message: string }
  | { type: "turn_start"; turn: number }
  | { type: "turn_end"; turn: number; usage?: { input: number; output: number } }
  | { type: "done"; reason: string }
  | { type: "compacting"; reason: string }
  | { type: "waiting_for_input" }
  | { type: "completion_retry"; attempt: number }
  | { type: "task_completion"; completion: CompleteTaskInput };

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
  getNextUserMessage?: (signal?: AbortSignal) => Promise<string | null>;
  forceCompaction?: boolean;
  skipCompaction?: boolean;
  onConfirmTool?: (toolName: string, input: Record<string, unknown>) => Promise<ConfirmDecision>;
  sessionManager?: SessionManager;
  resumeSummary?: string;
  depth?: number;
  maxTurns?: number;
  roleSystemPrompt?: string;
  contextProfile?: "root" | "subagent" | "compact";
  abortSignal?: AbortSignal;
  taskRuntime?: SubagentRuntimeContext;
  /** Extra model turns reserved solely for submitting CompleteTask. */
  completionRetryTurns?: number;
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
  const isRootProfile = (options.contextProfile ?? "root") === "root";
  const rootRuntime = isRootProfile
    ? processSubagentRegistry.getOrCreate(sessionId, workingDir, config)
    : undefined;
  rootRuntime?.trace.append({
    type: "root_session_started",
    sessionId,
    agentId: sessionId,
    prompt,
  });

  // Security + Tool runtime
  const securityRuntime = new SecurityRuntime(config.permissions);
  const permissionManager = securityRuntime.policyEngine;
  const toolRuntime = new ToolRuntime({
    securityRuntime,
    workingDir,
    onConfirmTool: options.onConfirmTool,
    tools,
  });

  const readGuard = new ReadGuard();

  // Session storage
  const projectHash = options.sessionManager?.getProjectHash();
  const sessionStore = new SessionStore(sessionId, projectHash);
  const persistConversation = (options.contextProfile ?? "root") === "root";
  if (persistConversation) {
    sessionStore.init();
    sessionStore.writeMessage({ role: "user", content: prompt });
  }

  let sessionMeta = createSessionMeta(
    sessionId,
    `${config.model.provider}/${config.model.model}`,
    undefined,
    { firstMessage: prompt.slice(0, 200) },
  );

  // Plan manager
  const planManager = new PlanManager(workingDir);
  const delegationGate = isRootProfile
    ? new RootDelegationGate(prompt)
    : undefined;

  // Agent context
  const ctx: AgentContext = {
    workingDir,
    sessionId,
    readGuard,
    permissionManager,
    config,
    planManager,
    depth: options.depth ?? 0,
    taskRuntime: options.taskRuntime,
    abortSignal: options.abortSignal,
    onConfirmTool: options.onConfirmTool,
    delegationGate,
  };

  // ---- Build system prompt via ContextAssembler ----
  const { systemPrompt, systemTokens } = await assembleContext({
    workingDir,
    prompt,
    ctx,
    tools,
    providerName: config.model.provider,
    resumeSummary: options.resumeSummary,
    roleSystemPrompt: options.roleSystemPrompt,
    contextProfile: options.contextProfile,
  });

  // ---- Initialize messages ----
  const messages: Message[] = [
    { role: "user", content: prompt },
  ];

  // ---- Compaction tracking ----
  let consecutiveCompactionFailures = 0;
  let skipAutoCompact = options.skipCompaction ?? false;

  // ---- Main turn loop ----
  const configuredMaxTurns = options.maxTurns ??
    (options.contextProfile === "subagent" ? Number.POSITIVE_INFINITY : DEFAULT_MAX_TURNS);
  const completionRetryTurns = options.taskRuntime
    ? Math.max(0, options.completionRetryTurns ?? 1)
    : 0;
  const maxTurns = Number.isFinite(configuredMaxTurns)
    ? configuredMaxTurns + completionRetryTurns
    : configuredMaxTurns;
  let doneReason: string | null = null;
  let hadAssistantResponse = false;
  let forcingCompletion = false;
  let completionRetryCount = 0;

  for (let turn = 0; turn < maxTurns && !doneReason; turn++) {
    if (options.abortSignal?.aborted) {
      doneReason = "cancelled";
      break;
    }
    options.taskRuntime?.onActivity?.(`model turn ${turn + 1}`);
    // Dynamic provider switching
    if (provider.name !== config.model.provider) {
      provider = createProvider(config.model);
      yield { type: "warning", message: `Switched to ${config.model.provider}/${config.model.model}` };
    }

    yield { type: "turn_start", turn: turn + 1 };
    rootRuntime?.trace.append({
      type: "root_turn_started",
      sessionId,
      agentId: sessionId,
      turn: turn + 1,
    });

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
      if (persistConversation) {
        sessionStore.writeCompaction({ turn, messageCount: messages.length });
      }
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
    const preTurnMessageCount = messages.length;
    try {
      const turnTools = forcingCompletion
        ? tools.filter((tool) => tool.name === "CompleteTask")
        : tools;
      turnResult = yield* executeTurn({
        provider,
        model: config.model.model,
        systemPrompt,
        messages,
        tools: turnTools,
        renderer,
        workingDir,
        ctx,
        toolRuntime,
        planManager,
        onConfirmTool: options.onConfirmTool,
        maxRetries: config.model.maxRetries,
        abortSignal: options.abortSignal,
        onToolTrace: rootRuntime
          ? (event) => {
              rootRuntime.trace.append({
                type: event.phase === "started" ? "tool_started" : "tool_completed",
                sessionId,
                agentId: sessionId,
                scope: "root",
                toolId: event.id,
                tool: event.name,
                input: event.input,
                output: event.output,
                isError: event.isError,
                security: event.security,
                error: event.error,
                startedAt: event.startedAt,
                durationMs: event.durationMs,
              });
            }
          : undefined,
      });
    } catch (err) {
      if (err instanceof UserInterruptError) {
        rootRuntime?.trace.append({
          type: "root_turn_failed",
          sessionId,
          agentId: sessionId,
          turn: turn + 1,
          reason: "user_interrupt",
        });
        yield { type: "warning", message: "Interrupted (Ctrl+C)" };
        doneReason = "user_interrupt";
        break;
      }
      if (err instanceof CircuitBreakerError) {
        rootRuntime?.trace.append({
          type: "root_turn_failed",
          sessionId,
          agentId: sessionId,
          turn: turn + 1,
          reason: "circuit_breaker",
        });
        doneReason = "circuit_breaker";
        break;
      }
      if (err instanceof MaxRetriesError) {
        rootRuntime?.trace.append({
          type: "root_turn_failed",
          sessionId,
          agentId: sessionId,
          turn: turn + 1,
          reason: "max_retries",
        });
        doneReason = "max_retries";
        break;
      }
      if (err instanceof StreamFailedError) {
        rootRuntime?.trace.append({
          type: "root_turn_failed",
          sessionId,
          agentId: sessionId,
          turn: turn + 1,
          reason: "stream_failed",
          error: err.message,
        });
        doneReason = "stream_failed";
        break;
      }
      // Unknown error
      yield { type: "error", message: String(err), retryable: false };
      rootRuntime?.trace.append({
        type: "root_turn_failed",
        sessionId,
        agentId: sessionId,
        turn: turn + 1,
        reason: "stream_failed",
        error: String(err),
      });
      doneReason = "stream_failed";
      break;
    }

    const {
      toolUses,
      usage,
      stopReason,
      toolDenied,
      taskCompletion,
      toolExecutions,
    } = turnResult;
    rootRuntime?.trace.append({
      type: "root_turn_completed",
      sessionId,
      agentId: sessionId,
      turn: turn + 1,
      modelOutput: turnResult.assistantBlocks.map((block) => block.text).join(""),
      stopReason,
      usage,
      toolExecutions: toolExecutions.map((execution) => ({
        id: execution.id,
        name: execution.name,
        isError: execution.isError,
      })),
    });
    if (persistConversation) {
      persistTurnMessages(sessionStore, messages.slice(preTurnMessageCount));
    }

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

    if (taskCompletion) {
      yield { type: "task_completion", completion: taskCompletion.completion };
      doneReason = "task_completion";
      break;
    }

    if (
      options.taskRuntime &&
      !options.taskRuntime.completionSubmitted &&
      !forcingCompletion &&
      Number.isFinite(configuredMaxTurns) &&
      turn + 1 >= configuredMaxTurns &&
      completionRetryCount < completionRetryTurns
    ) {
      completionRetryCount++;
      forcingCompletion = true;
      messages.push({
        role: "user",
        content: buildForcedCompletionMessage(options.taskRuntime),
      });
      yield { type: "completion_retry", attempt: completionRetryCount };
      continue;
    }

    if (forcingCompletion) {
      // A forced turn is deliberately bounded. If it did not successfully
      // submit CompleteTask, TaskRunner will recover a readable partial from
      // all observable text and tool activity.
      doneReason = "missing_task_completion";
      break;
    }

    // ---- End turn? ----
    if (stopReason === "end_turn" || toolUses.length === 0) {
      if (
        options.taskRuntime &&
        !options.taskRuntime.completionSubmitted &&
        completionRetryCount < completionRetryTurns
      ) {
        completionRetryCount++;
        forcingCompletion = true;
        messages.push({
          role: "user",
          content: buildForcedCompletionMessage(options.taskRuntime),
        });
        yield { type: "completion_retry", attempt: completionRetryCount };
        continue;
      }
      const runtime = options.contextProfile === "subagent"
        ? undefined
        : processSubagentRegistry.get(sessionId);
      const completedTasks = runtime?.inbox.drain() ?? [];
      if (completedTasks.length > 0) {
        runtime?.trace.append({
          type: "parent_wake",
          sessionId,
          taskIds: completedTasks.flatMap((event) => event.taskIds),
        });
        if (persistConversation) {
          sessionStore.writeToolEvent({
            type: "task_notification",
            taskIds: completedTasks.flatMap((event) => event.taskIds),
          });
        }
        messages.push({
          role: "user",
          content: formatInboxEvents(completedTasks),
        });
        continue;
      }
      if (options.getNextUserMessage) {
        yield { type: "waiting_for_input" };
        let nextMessage: string | null;
        if (runtime?.hasPendingAdvisory()) {
          const waitController = new AbortController();
          const next = await Promise.race([
            options.getNextUserMessage(waitController.signal)
              .then((message) => ({ kind: "user" as const, message })),
            runtime.inbox.wait(waitController.signal)
              .then((event) => ({ kind: "inbox" as const, event })),
          ]);
          waitController.abort();
          if (next.kind === "inbox") {
            runtime.trace.append({
              type: "parent_wake",
              sessionId,
              taskIds: next.event.taskIds,
            });
            if (persistConversation) {
              sessionStore.writeToolEvent({
                type: "task_notification",
                taskIds: next.event.taskIds,
              });
            }
            messages.push({ role: "user", content: formatInboxEvents([next.event]) });
            continue;
          }
          nextMessage = next.message;
        } else {
          nextMessage = await options.getNextUserMessage();
        }
        if (!nextMessage || !nextMessage.trim()) {
          doneReason = "user_exit";
          break;
        }
        const deviationWarning = planManager.onUserMessage(nextMessage.trim());
        delegationGate?.observeUserMessage(nextMessage.trim());
        if (deviationWarning) {
          yield { type: "warning", message: deviationWarning };
        }
        const notifications = runtime?.inbox.drain() ?? [];
        if (notifications.length > 0) {
          runtime?.trace.append({
            type: "task_notification_before_user_message",
            sessionId,
            taskIds: notifications.flatMap((event) => event.taskIds),
          });
          if (persistConversation) {
            sessionStore.writeToolEvent({
              type: "task_notification",
              taskIds: notifications.flatMap((event) => event.taskIds),
            });
          }
          messages.push({ role: "user", content: formatInboxEvents(notifications) });
        }
        messages.push({ role: "user", content: nextMessage.trim() });
        if (persistConversation) {
          sessionStore.writeMessage({ role: "user", content: nextMessage.trim() });
        }
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
        delegationGate?.observeUserMessage(nextMessage.trim());
        if (deviationWarning) {
          yield { type: "warning", message: deviationWarning };
        }
        messages.push({ role: "user", content: nextMessage.trim() });
        if (persistConversation) {
          sessionStore.writeMessage({ role: "user", content: nextMessage.trim() });
        }
        sessionMeta.messageCount = (sessionMeta.messageCount ?? 0) + 1;
        continue;
      }
      doneReason = "tool_denied";
      break;
    }

    // Preserve maxTurns as the research-turn budget. A finite limit gets one
    // reserved completion-only turn rather than losing all accumulated work.
    if (
      options.taskRuntime &&
      !options.taskRuntime.completionSubmitted &&
      Number.isFinite(configuredMaxTurns) &&
      turn + 1 >= configuredMaxTurns &&
      completionRetryCount < completionRetryTurns
    ) {
      completionRetryCount++;
      forcingCompletion = true;
      messages.push({
        role: "user",
        content: buildForcedCompletionMessage(options.taskRuntime),
      });
      yield { type: "completion_retry", attempt: completionRetryCount };
    }
  }

  if (!doneReason) {
    doneReason = "max_turns";
  }

  // Managed subagents have their own trace/artifact lifecycle. They must not
  // write root conversation state, project memory, or run root Git hooks.
  if ((options.contextProfile ?? "root") !== "root") {
    yield { type: "done", reason: doneReason };
    return;
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

  rootRuntime?.trace.append({
    type: "root_session_ended",
    sessionId,
    agentId: sessionId,
    reason: doneReason,
    usage: { totalTokens: sessionMeta.totalTokens },
  });
  yield { type: "done", reason: doneReason };
}

function formatInboxEvents(events: TaskInboxEvent[]): string {
  return [
    "[Runtime notification: advisory subagent results are now available.]",
    ...events.flatMap((event) => event.results.map((result) => [
      `Task completed: ${result.summary}`,
      `Task ID: ${result.taskId}`,
      `Status: ${result.status}`,
      `Report: ${result.reportPath}`,
      `Result: ${result.resultPath}`,
      `Coverage: ${result.coveragePath}`,
      ...(result.workspace
        ? [
            `Worktree: ${result.workspace.path}`,
            `Branch: ${result.workspace.branch}`,
            `Base commit: ${result.workspace.baseCommit}`,
            `Head commit: ${result.workspace.headCommit}`,
            `Commits: ${result.workspace.commits.join(", ") || "(none)"}`,
            `Changed files: ${result.workspace.filesChanged.join(", ") || "(none)"}`,
            `Dirty: ${result.workspace.dirty}`,
            `Patch: ${result.workspace.patchPath}`,
          ]
        : []),
      "Read the report if needed, then supplement or revise the earlier response.",
    ].join("\n"))),
  ].join("\n\n");
}

function buildForcedCompletionMessage(runtime: SubagentRuntimeContext): string {
  const coverage = runtime.coverage?.snapshot();
  const coverageLine = coverage
    ? [
        `Observable coverage: discovered=${coverage.discovered}`,
        `inspected=${coverage.inspected}`,
        `excluded=${coverage.excluded}`,
        `failed=${coverage.failed}`,
        `discovery_complete=${coverage.discovery_complete}`,
      ].join(", ")
    : "Observable coverage is unavailable.";
  return [
    "[Runtime completion required]",
    "You ended without successfully submitting CompleteTask.",
    "Do not perform more investigation. Use the evidence already present in this conversation.",
    "Now call CompleteTask exactly once with a self-contained, readable Markdown report.",
    "If evidence or exhaustive coverage is incomplete, use status=partial and state the precise gaps; never claim full coverage.",
    coverageLine,
  ].join("\n");
}

function persistTurnMessages(store: SessionStore, messages: Message[]): void {
  for (const message of messages) {
    if (message.role === "assistant") {
      store.writeMessage(message);
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "tool_result") {
          store.writeToolEvent(block);
        }
      }
    }
  }
}
