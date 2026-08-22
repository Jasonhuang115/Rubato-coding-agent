// CompactionController — context compaction orchestration
// Layered compact: keep last 10 user turns, judge against the current
// model's working window, then clear/offload recent tool results, then shrink
// turns. Occupancy failure is unrecoverable (root session should stop).

import type {
  Message,
  AgentContext,
  AgentConfig,
  ModelProvider,
} from "../shared/core-types.js";
import { microCompactBeforeRequest } from "../context/micro-compact.js";
import type { ReadGuardState } from "../shared/core-types.js";
import { estimateMessageTokens } from "../shared/tokens.js";
import {
  getCompactionBudget,
  systemLeavesNoConversationRoom,
  type CompactionBudget,
} from "./model-windows.js";
import { PASS1_KEEP_TURNS } from "../context/compression.js";
import {
  applyToolResultActions,
  collectToolResultEntries,
  countKeptUserTurns,
  extractSummaryText,
  heuristicToolResultActions,
  offloadHeavyToolResults,
  pickToolResultActionsViaModel,
  shrinkOldestKeptTurn,
  SHRINK_FLOOR_TURNS,
  summarizeOlderTurns,
} from "../context/layered-compact.js";
import {
  listOffloadPaths,
  toolResultOffloadDir,
  writeCompactionHandoff,
} from "../context/tool-result-offload.js";
import path from "path";

export { estimateMessageTokens };
export { PASS1_KEEP_TURNS };
export const MAX_COMPACTION_FAILURES = 3;

export type CompactionOutcome = "ok" | "skipped" | "unrecoverable";
export type UnrecoverableCode = "occupancy" | "system_too_large";

export interface CompactionHandoff {
  sessionId: string;
  summary: string;
  offloadIndex: string[];
  handoffPath?: string;
}

export interface CompactionResult {
  compacted: boolean;
  reason?: string;
  messages: Message[];
  disableAutoCompact: boolean;
  outcome: CompactionOutcome;
  unrecoverableCode?: UnrecoverableCode;
  warning?: string;
  handoff?: CompactionHandoff;
  modelCallFailed?: boolean;
}

export interface CompactionOptions {
  messages: Message[];
  systemTokens: number;
  model: string;
  forceCompact?: boolean;
  skipCompaction?: boolean;
  overflowRecovery?: boolean;
  ctx: AgentContext;
  config: AgentConfig;
  provider: ModelProvider;
  abortSignal?: AbortSignal;
  readGuard: ReadGuardState;
  consecutiveFailures: number;
}

export function compactionKeepTurns(): number {
  return PASS1_KEEP_TURNS;
}

/** @deprecated Use compactionKeepTurns — kept as an alias for call-site updates. */
export function compactionKeepRecent(_isSubagent?: boolean): number {
  return PASS1_KEEP_TURNS;
}

export function wouldCompact(options: {
  messages: Message[];
  systemTokens: number;
  model: string;
  forceCompact?: boolean;
  skipCompaction?: boolean;
  isSubagent?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): boolean {
  if (options.skipCompaction) return false;
  if (options.forceCompact) return true;
  const budget = getCompactionBudget({
    model: options.model,
    isSubagent: options.isSubagent,
    contextWindow: options.contextWindow,
    maxTokens: options.maxTokens,
  });
  const approxTokens = estimateMessageTokens(options.messages) + options.systemTokens;
  return approxTokens > budget.trigger;
}

export async function checkAndCompact(
  options: CompactionOptions,
): Promise<CompactionResult> {
  const {
    messages, systemTokens, model, forceCompact, skipCompaction,
    overflowRecovery, ctx, config, provider, abortSignal, readGuard,
    consecutiveFailures,
  } = options;

  const budget = getCompactionBudget({
    model,
    isSubagent: Boolean(ctx.taskRuntime),
    contextWindow: config.model.contextWindow,
    maxTokens: config.model.maxTokens,
  });

  if (skipCompaction) {
    return skipped(messages, budget.windowWarning);
  }

  if (systemLeavesNoConversationRoom(systemTokens, budget)) {
    return {
      compacted: false,
      messages,
      disableAutoCompact: false,
      outcome: "unrecoverable",
      unrecoverableCode: "system_too_large",
      reason: systemTooLargeMessage(systemTokens, budget),
      warning: budget.windowWarning,
    };
  }

  const approxTokens = estimateMessageTokens(messages) + systemTokens;
  const overTrigger = approxTokens > budget.trigger;
  if (!forceCompact && !overflowRecovery && !overTrigger) {
    return skipped(messages, budget.windowWarning);
  }

  const reason = forceCompact
    ? "User requested compaction"
    : overflowRecovery
      ? "Context overflow — compacting further"
      : `~${Math.round(approxTokens / 1000)}K / ${Math.round(budget.trigger / 1000)}K tokens (${model})`;

  const offloadDir = toolResultOffloadDir(ctx.projectId, ctx.sessionId);
  let next = offloadHeavyToolResults(messages, offloadDir);
  let modelCallFailed = false;

  const pass1 = await summarizeOlderTurns(
    next,
    PASS1_KEEP_TURNS,
    config,
    provider,
    abortSignal,
  );
  next = pass1.messages;
  if (pass1.modelFailed) modelCallFailed = true;

  if (occupancyOk(next, systemTokens, budget)) {
    return success(next, reason, readGuard, modelCallFailed, consecutiveFailures, budget.windowWarning);
  }

  next = await runPass2(next, config, provider, abortSignal, offloadDir);
  if (occupancyOk(next, systemTokens, budget)) {
    return success(next, `${reason} — pass 2`, readGuard, modelCallFailed, consecutiveFailures, budget.windowWarning);
  }

  while (
    countKeptUserTurns(next) > SHRINK_FLOOR_TURNS &&
    !occupancyOk(next, systemTokens, budget)
  ) {
    const shrunk = shrinkOldestKeptTurn(next);
    if (shrunk === next) break;
    next = shrunk;
  }

  if (occupancyOk(next, systemTokens, budget)) {
    return success(next, `${reason} — shrunk turns`, readGuard, modelCallFailed, consecutiveFailures, budget.windowWarning);
  }

  const handoff = buildHandoff(next, ctx, offloadDir);
  return {
    compacted: true,
    reason: occupancyFailureMessage(ctx.sessionId, handoff, Boolean(ctx.taskRuntime)),
    messages: next,
    disableAutoCompact: false,
    outcome: "unrecoverable",
    unrecoverableCode: "occupancy",
    handoff,
    modelCallFailed,
    warning: budget.windowWarning,
  };
}

async function runPass2(
  messages: Message[],
  config: AgentConfig,
  provider: ModelProvider,
  abortSignal: AbortSignal | undefined,
  offloadDir: string,
): Promise<Message[]> {
  const entries = collectToolResultEntries(messages);
  if (entries.length === 0) return messages;
  let actions;
  try {
    actions = await pickToolResultActionsViaModel(entries, config, provider, abortSignal);
  } catch {
    actions = heuristicToolResultActions(entries);
  }
  return applyToolResultActions(messages, actions, offloadDir);
}

function occupancyOk(messages: Message[], systemTokens: number, budget: CompactionBudget): boolean {
  return systemTokens + estimateMessageTokens(messages) < budget.successCeiling;
}

function success(
  messages: Message[],
  reason: string,
  readGuard: ReadGuardState,
  modelCallFailed: boolean,
  consecutiveFailures: number,
  warning?: string,
): CompactionResult {
  const restored = injectRecentFiles(messages, readGuard);
  const newFailures = modelCallFailed ? consecutiveFailures + 1 : 0;
  return {
    compacted: true,
    reason: modelCallFailed
      ? `Compaction summary failed (${newFailures}/${MAX_COMPACTION_FAILURES}) — used heuristic summary.`
      : reason,
    messages: restored,
    disableAutoCompact: modelCallFailed && newFailures >= MAX_COMPACTION_FAILURES,
    outcome: "ok",
    modelCallFailed,
    warning,
  };
}

function skipped(messages: Message[], warning?: string): CompactionResult {
  return {
    compacted: false,
    messages,
    disableAutoCompact: false,
    outcome: "skipped",
    warning,
  };
}

function injectRecentFiles(messages: Message[], readGuard: ReadGuardState): Message[] {
  const snapshot = readGuard.serialize();
  const recentFiles = Object.entries(snapshot.files)
    .sort(([, a], [, b]) => b.timestamp - a.timestamp)
    .slice(0, 3)
    .map(([fp]) => fp);
  if (recentFiles.length === 0) return messages;
  return [
    ...messages,
    {
      role: "user",
      content: `[Recently accessed files after compaction: ${recentFiles.join(", ")}. You may want to re-read these if you need their current content.]`,
    },
  ];
}

function buildHandoff(messages: Message[], ctx: AgentContext, offloadDir: string): CompactionHandoff {
  const summary = extractSummaryText(messages);
  const offloadIndex = listOffloadPaths(messages);
  let handoffPath: string | undefined;
  try {
    handoffPath = writeCompactionHandoff({
      dir: path.dirname(offloadDir),
      sessionId: ctx.sessionId,
      summary,
      offloadIndex,
    });
  } catch {
    // Session disk is best-effort; the in-memory handoff still works.
  }
  return { sessionId: ctx.sessionId, summary, offloadIndex, handoffPath };
}

function systemTooLargeMessage(systemTokens: number, budget: CompactionBudget): string {
  const window = budget.window ?? 0;
  return (
    `System prompt is unexpectedly large (~${Math.round(systemTokens)} tokens) ` +
    `for working window ${window} (output reserve ${budget.outputReserve}). ` +
    `This is a configuration or prompt-assembly bug, not a conversation-history problem.`
  );
}

function occupancyFailureMessage(
  sessionId: string,
  handoff: CompactionHandoff,
  isSubagent: boolean,
): string {
  const index = handoff.offloadIndex.length > 0
    ? handoff.offloadIndex.map((p) => `  ${p}`).join("\n")
    : "  (none)";
  if (isSubagent) {
    // Subagent stop-path rewrite is out of this plan; fail the task without /clear copy.
    return (
      `Context compaction could not free enough space to continue this subagent task.\n` +
      `Session: ${sessionId}\n` +
      (handoff.handoffPath ? `Handoff: ${handoff.handoffPath}\n` : "") +
      `Offloaded files:\n${index}`
    );
  }
  return (
    `Context compaction could not free enough space to continue.\n` +
    `Session: ${sessionId}\n` +
    `Start a new conversation with /clear. The summary and offloaded file index were saved` +
    (handoff.handoffPath ? ` at ${handoff.handoffPath}` : "") +
    `.\nOffloaded files:\n${index}`
  );
}

export interface MicroCompactResult {
  cleared: boolean;
  count: number;
  messages: Message[];
}

export function runMicroCompact(messages: Message[]): MicroCompactResult {
  const mcResult = microCompactBeforeRequest(messages);
  if (mcResult.cleared > 0) {
    return { cleared: true, count: mcResult.cleared, messages: mcResult.messages };
  }
  return { cleared: false, count: 0, messages };
}

export function getAutoCompactThreshold(
  model: string,
  isSubagent = false,
  options?: { contextWindow?: number; maxTokens?: number },
): number {
  return getCompactionBudget({
    model,
    isSubagent,
    contextWindow: options?.contextWindow,
    maxTokens: options?.maxTokens,
  }).trigger;
}

export function formatHandoffResumeSummary(handoff: CompactionHandoff): string {
  const index = handoff.offloadIndex.length > 0
    ? handoff.offloadIndex.map((p) => `- ${p}`).join("\n")
    : "- (none)";
  return [
    `Previous session: ${handoff.sessionId}`,
    "",
    handoff.summary,
    "",
    "Offloaded tool results (Read these paths if you need the original output):",
    index,
  ].join("\n");
}
