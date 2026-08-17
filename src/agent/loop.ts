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
  PlanReadyControl,
  SubagentRuntimeContext,
} from "../shared/core-types.js";
import { createProvider } from "../model/router.js";
import { getAllTools, getToolsForMode } from "../tools/registry.js";
import { SecurityRuntime } from "../security/runtime.js";
import { ToolRuntime } from "../runtime/tool-runtime.js";
import { ReadGuard } from "./read-guard.js";
import { SessionStore } from "../runtime/session/storage.js";
import { createSessionMeta, finalizeSessionMeta } from "../runtime/session/meta.js";
import type { SessionManager } from "../runtime/session/manager.js";
import { AgentModeController } from "./mode.js";
import { sessionEndHook } from "../tools/git/hooks.js";
import { assembleContext } from "../runtime/context-assembler.js";
import {
  checkAndCompact,
  compactionKeepRecent,
  runMicroCompact,
  wouldCompact,
} from "../runtime/compaction-controller.js";
import { messagesToDiscard } from "../context/compression.js";
import { extractMemories, shouldExtractMemories } from "../memory/extraction.js";
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
import { projectMemoryId } from "../shared/project-id.js";
import { AssistantDraftWriter } from "../runtime/assistant-draft.js";

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
  | { type: "plan_ready"; plan: PlanReadyControl };

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
  /** Stable logical conversation ID; defaults to the current run ID. */
  conversationId?: string;
  runTrigger?: "user_message" | "subagent_terminal" | "resume";
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
  /** Root CLI session mode; omitted contexts always use default mode. */
  modeController?: AgentModeController;
}

// ---- Main loop ----

export async function* agentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent> {
  const { config, workingDir, prompt, renderer } = options;

  // ---- Setup ----
  const sessionId = options.sessionId ?? randomUUID();
  const conversationId = options.conversationId ?? sessionId;
  let provider = createProvider(config.model);
  const registeredTools = options.tools ?? getAllTools();
  const modeController = options.modeController ?? new AgentModeController();
  let tools = options.tools ?? getToolsForMode(modeController.mode);
  const isRootProfile = (options.contextProfile ?? "root") === "root";
  const rootRuntime = isRootProfile
    ? processSubagentRegistry.getOrCreate(conversationId, workingDir, config, sessionId)
    : undefined;
  if (rootRuntime && options.runTrigger === "resume") {
    await rootRuntime.resumePersistedTasks();
  }
  rootRuntime?.trace.append({
    type: "root_session_started",
    sessionId,
    agentId: sessionId,
    prompt,
    provider: config.model.provider,
    model: config.model.model,
  });

  // Security + Tool runtime
  const securityRuntime = new SecurityRuntime(config.permissions);
  const permissionManager = securityRuntime.policyEngine;
  const toolRuntime = new ToolRuntime({
    securityRuntime,
    workingDir,
    onConfirmTool: options.onConfirmTool,
    tools: registeredTools,
  });

  const readGuard = new ReadGuard();

  // Session storage
  const projectHash = options.sessionManager?.getProjectHash() ?? projectMemoryId(workingDir);
  const sessionStore = new SessionStore(sessionId, projectHash);
  const persistConversation = (options.contextProfile ?? "root") === "root";
  const assistantDraft = persistConversation
    ? new AssistantDraftWriter(projectHash, sessionId)
    : undefined;
  let rootLeaseHeartbeat: ReturnType<typeof setInterval> | undefined;
  const recordUserMessage = (content: string): void => {
    const stored = sessionStore.writeMessage({ role: "user", content });
    if (stored && rootRuntime) {
      rootRuntime.controlPlane.createUserMessageEvent(
        conversationId,
        stored.event_id,
        sessionId,
        stored.timestamp,
      );
    }
  };
  if (persistConversation) {
    sessionStore.init();
    recordUserMessage(prompt);
    rootRuntime?.controlPlane.createRun({
      runId: sessionId,
      conversationId,
      kind: "root",
      trigger: options.runTrigger ?? (options.resumeSummary ? "resume" : "user_message"),
      provider: config.model.provider,
      model: config.model.model,
      sessionPath: sessionStore.getFilePath(),
      tracePath: rootRuntime.trace.path,
      draftPath: assistantDraft?.filePath,
    });
    if (rootRuntime) {
      rootLeaseHeartbeat = setInterval(() => {
        rootRuntime.controlPlane.heartbeatRun(sessionId);
      }, 5_000);
      rootLeaseHeartbeat.unref();
    }
  }
  let sessionMeta = createSessionMeta(
    sessionId,
    `${config.model.provider}/${config.model.model}`,
    undefined,
    { firstMessage: prompt.slice(0, 200) },
  );
  let rootInputTokens = 0;
  let rootOutputTokens = 0;
  let rootToolCalls = 0;

  const delegationGate = isRootProfile
    ? new RootDelegationGate(prompt)
    : undefined;

  // Agent context
  const ctx: AgentContext = {
    workingDir,
    projectId: projectHash,
    conversationId,
    runId: sessionId,
    sessionId,
    readGuard,
    permissionManager,
    config,
    mode: modeController.mode,
    depth: options.depth ?? 0,
    taskRuntime: options.taskRuntime,
    abortSignal: options.abortSignal,
    onConfirmTool: options.onConfirmTool,
    delegationGate,
  };
  if (ctx.mode === "plan") {
    rootRuntime?.trace.append({
      type: "agent_mode_changed",
      sessionId,
      agentId: sessionId,
      mode: ctx.mode,
    });
    if (persistConversation) sessionStore.writeToolEvent({ type: "agent_mode_changed", mode: ctx.mode });
  }

  // ---- Build system prompt via ContextAssembler ----
  let { systemPrompt, systemTokens } = await assembleContext({
    workingDir,
    prompt,
    ctx,
    tools,
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
  let extractedThisCycle = false;

  // ---- Main turn loop ----
  const configuredMaxTurns = options.maxTurns ??
    (options.contextProfile === "subagent" ? Number.POSITIVE_INFINITY : DEFAULT_MAX_TURNS);
  let doneReason: string | null = null;
  let assembledMode = ctx.mode;

  for (let turn = 0; turn < configuredMaxTurns && !doneReason; turn++) {
    if (options.abortSignal?.aborted) {
      doneReason = "cancelled";
      break;
    }
    options.taskRuntime?.onActivity?.(`model turn ${turn + 1}`);
    if (!options.tools && modeController.mode !== assembledMode) {
      ctx.mode = modeController.mode;
      tools = getToolsForMode(ctx.mode);
      ({ systemPrompt, systemTokens } = await assembleContext({
        workingDir,
        prompt,
        ctx,
        tools,
        resumeSummary: options.resumeSummary,
        roleSystemPrompt: options.roleSystemPrompt,
        contextProfile: options.contextProfile,
      }));
      assembledMode = ctx.mode;
      rootRuntime?.trace.append({
        type: "agent_mode_changed",
        sessionId,
        agentId: sessionId,
        mode: ctx.mode,
      });
      if (persistConversation) sessionStore.writeToolEvent({ type: "agent_mode_changed", mode: ctx.mode });
    }
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

    // ---- Memory extraction then compaction ----
    const willCompact = wouldCompact({
      messages,
      systemTokens,
      model: config.model.model,
      forceCompact: options.forceCompaction,
      skipCompaction: skipAutoCompact,
      isSubagent: Boolean(ctx.taskRuntime),
    });
    if (shouldExtractMemories({
      isRoot: isRootProfile,
      extractedThisCycle,
      memoryEnabled: ctx.config.memory?.enabled !== false,
      willCompact,
    })) {
      extractedThisCycle = true;
      const discarded = messagesToDiscard(
        messages,
        compactionKeepRecent(Boolean(ctx.taskRuntime)),
      );
      if (discarded.length > 0) {
        yield {
          type: "compacting",
          reason: options.forceCompaction
            ? "Extracting durable memory before requested compaction"
            : "Extracting durable memory before compaction",
        };
        const extraction = await extractMemories({
          discarded,
          ctx,
          config,
          provider,
          abortSignal: options.abortSignal,
        });
        if (extraction.warning) {
          yield { type: "warning", message: extraction.warning };
        }
      }
    }

    const compactResult = await checkAndCompact({
      messages,
      systemTokens,
      model: config.model.model,
      forceCompact: options.forceCompaction,
      skipCompaction: skipAutoCompact,
      ctx,
      config,
      provider,
      abortSignal: options.abortSignal,
      readGuard,
      consecutiveFailures: consecutiveCompactionFailures,
    });

    if (options.forceCompaction) options.forceCompaction = false;

    if (compactResult.compacted) {
      extractedThisCycle = false;
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
      const runtimeStatus = isRootProfile ? formatSubagentStatus(rootRuntime) : "";
      turnResult = yield* executeTurn({
        provider,
        model: config.model.model,
        systemPrompt: runtimeStatus ? `${systemPrompt}\n\n${runtimeStatus}` : systemPrompt,
        messages,
        tools,
        renderer,
        workingDir,
        ctx,
        toolRuntime,
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
        onTextDelta: assistantDraft ? (text) => assistantDraft.append(text) : undefined,
        onTextFlush: assistantDraft ? () => assistantDraft.flush() : undefined,
      });
    } catch (err) {
      if (err instanceof UserInterruptError) {
        assistantDraft?.boundary("interrupted");
        rootRuntime?.trace.append({
          type: "root_turn_failed",
          sessionId,
          agentId: sessionId,
          turn: turn + 1,
          reason: "user_interrupt",
        });
        yield { type: "warning", message: "Interrupted (Ctrl+C)" };
        if (options.getNextUserMessage) {
          yield { type: "waiting_for_input" };
          const runtime = processSubagentRegistry.get(conversationId);
          let nextMessage: string | null = null;
          if (runtime?.hasPendingTasks()) {
            const waitController = new AbortController();
            const next = await Promise.race([
              options.getNextUserMessage(waitController.signal)
                .then((message) => ({ kind: "user" as const, message })),
              runtime.inbox.wait(waitController.signal)
                .then((event) => ({ kind: "inbox" as const, event })),
            ]);
            waitController.abort();
            if (next.kind === "inbox") {
              messages.push({ role: "user", content: formatInboxEvents([next.event]) });
              continue;
            }
            nextMessage = next.message;
          } else {
            nextMessage = await options.getNextUserMessage();
          }
          if (nextMessage?.trim()) {
            const rawMessage = nextMessage.trim();
            const transformed = modeController.transformUserInput(rawMessage);
            ctx.mode = modeController.mode;
            delegationGate?.observeUserMessage(rawMessage);
            messages.push({ role: "user", content: transformed.modelMessage });
            if (persistConversation) recordUserMessage(rawMessage);
            continue;
          }
        }
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
      control,
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
    assistantDraft?.boundary("turn_complete");

    sessionMeta.messageCount = (sessionMeta.messageCount ?? 0) + 1;
    if (usage) {
      sessionMeta.totalTokens += usage.input + usage.output;
      rootInputTokens += usage.input;
      rootOutputTokens += usage.output;
    }
    rootToolCalls += toolExecutions.length;

    yield {
      type: "turn_end",
      turn: turn + 1,
      usage: usage ? { input: usage.input, output: usage.output } : undefined,
    };

    if (control?.type === "plan_ready") {
      modeController.markReady(control);
      rootRuntime?.trace.append({
        type: "plan_submitted",
        sessionId,
        agentId: sessionId,
        path: control.path,
        title: control.title,
      });
      if (persistConversation) {
        sessionStore.writeToolEvent({ type: "plan_submitted", path: control.path, title: control.title });
      }
      yield { type: "plan_ready", plan: control };
      if (!options.getNextUserMessage) {
        doneReason = "plan_ready";
        break;
      }
      yield { type: "waiting_for_input" };
      const nextMessage = await options.getNextUserMessage();
      if (!nextMessage || !nextMessage.trim()) {
        doneReason = "user_exit";
        break;
      }
      const raw = nextMessage.trim();
      const transformed = modeController.transformUserInput(raw);
      ctx.mode = modeController.mode;
      messages.push({ role: "user", content: transformed.modelMessage });
      if (persistConversation) {
        recordUserMessage(raw);
        sessionStore.writeToolEvent({
          type: transformed.event === "approved" ? "plan_approved" : "plan_revision_requested",
          path: control.path,
        });
      }
      rootRuntime?.trace.append({
        type: transformed.event === "approved" ? "plan_approved" : "plan_revision_requested",
        sessionId,
        agentId: sessionId,
        path: control.path,
      });
      sessionMeta.messageCount = (sessionMeta.messageCount ?? 0) + 1;
      continue;
    }

    // ---- End turn? ----
    if (stopReason === "end_turn" || toolUses.length === 0) {
      const runtime = options.contextProfile === "subagent"
        ? undefined
        : processSubagentRegistry.get(conversationId);
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
        if (runtime?.hasPendingTasks()) {
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
        const rawMessage = nextMessage.trim();
        const transformed = modeController.transformUserInput(rawMessage);
        ctx.mode = modeController.mode;
        delegationGate?.observeUserMessage(rawMessage);
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
        messages.push({ role: "user", content: transformed.modelMessage });
        if (persistConversation) {
          recordUserMessage(rawMessage);
        }
        sessionMeta.messageCount = (sessionMeta.messageCount ?? 0) + 1;
        continue;
      }
      doneReason = stopReason;
      break;
    }

    // ---- Tool denied → interactive wait ----
    if (toolDenied) {
      if (options.taskRuntime) continue;
      yield { type: "warning", message: "Tool denied — stopping for your input." };
      if (options.getNextUserMessage) {
        yield { type: "waiting_for_input" };
        const nextMessage = await options.getNextUserMessage();
        if (!nextMessage || !nextMessage.trim()) {
          doneReason = "user_exit";
          break;
        }
        const rawMessage = nextMessage.trim();
        const transformed = modeController.transformUserInput(rawMessage);
        ctx.mode = modeController.mode;
        delegationGate?.observeUserMessage(rawMessage);
        messages.push({ role: "user", content: transformed.modelMessage });
        if (persistConversation) {
          recordUserMessage(rawMessage);
        }
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
  assistantDraft?.flush();
  if (rootLeaseHeartbeat) clearInterval(rootLeaseHeartbeat);
  rootRuntime?.controlPlane.finishRun(
    sessionId,
    new Set(["circuit_breaker", "max_retries", "stream_failed", "user_interrupt"])
      .has(doneReason ?? "")
      ? "failed"
      : "finished",
    {
      failureKind: doneReason ?? undefined,
      inputTokens: rootInputTokens,
      outputTokens: rootOutputTokens,
      toolCalls: rootToolCalls,
    },
  );
  await rootRuntime?.trace.flush();
  yield { type: "done", reason: doneReason };
}

function formatInboxEvents(events: TaskInboxEvent[]): string {
  return [
    "[Runtime notification: Subagent task state changed.]",
    ...events.flatMap((event) => event.results.map((result) => [
      `Task ID: ${result.taskId}`,
      `Status: ${result.status}`,
      `Report: ${result.reportPath}`,
      ...(result.error ? [`Error: ${result.error.slice(0, 240)}`] : []),
      "Use Grep or Read on the report only if it is relevant to the current conversation.",
    ].join("\n"))),
  ].join("\n\n");
}

export function formatSubagentStatus(
  runtime: ReturnType<typeof processSubagentRegistry.get>,
): string {
  const tasks = runtime?.statusSnapshot() ?? [];
  if (tasks.length === 0) return "";
  return [
    "## Current Subagent tasks",
    "This is an ephemeral runtime snapshot. Reports are not loaded automatically.",
    ...tasks.map((task) => [
      `- task_id: ${task.taskId}`,
      `  description: ${task.description.replace(/\s+/g, " ").slice(0, 200)}`,
      `  status: ${task.status}`,
      `  report: ${task.reportPath}`,
      ...(task.failureKind ? [`  failure_kind: ${task.failureKind}`] : []),
    ].join("\n")),
    "Use Grep first and then a targeted Read when a report is relevant. Do not infer its contents from status or path.",
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
