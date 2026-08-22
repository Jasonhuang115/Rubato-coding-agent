import { randomUUID } from "crypto";
import type {
  AgentConfig,
  AgentContext,
  AgentTaskInput,
  SubagentDefinition,
  SubagentFailureKind,
  SubagentLimits,
  SubagentTaskStatus,
  TaskDetail,
  TaskResult,
  TaskService,
  TaskSummary,
  ToolDefinition,
  WorkspaceResult,
} from "../../shared/core-types.js";
import { WorktreeManager } from "../worktrees/worktree-manager.js";
import { ArtifactStore } from "./artifact-store.js";
import { ConversationInbox } from "./conversation-inbox.js";
import { coverageSummary, emptyCoverageManifest } from "./coverage.js";
import { TaskRunner, type TaskRunnerOutput } from "./task-runner.js";
import { TaskScheduler } from "./task-scheduler.js";
import { TraceSink } from "./trace-sink.js";
import fs from "node:fs";
import { findDefinition } from "../agent-defs.js";
import { getBuiltinDefinition, resolveSubagentTools } from "../subagent.js";

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  maxConcurrent: 4,
  maxWriteConcurrent: 2,
  maxTasksPerSession: 32,
  artifactTtlDays: 30,
  artifactSoftLimitBytes: 2 * 1024 * 1024 * 1024,
};

interface TaskRecord {
  detail: TaskDetail;
  controller: AbortController;
  writer: boolean;
  forcedFailureKind?: SubagentFailureKind;
  terminalDelivered: boolean;
  timeoutMs: number;
  accumulatedRuntimeMs: number;
  attempt: number;
  pauseRequested: boolean;
  currentAttemptRunId?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
}

export interface SubmittedTask {
  task: TaskDetail;
}

export type TaskStatusListener = (task: TaskSummary) => void;

export class SubagentRuntime implements TaskService {
  readonly artifacts: ArtifactStore;
  readonly trace: TraceSink;
  readonly inbox: ConversationInbox;
  readonly limits: SubagentLimits;

  private readonly scheduler: TaskScheduler;
  private readonly runner: Pick<TaskRunner, "run">;
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly listeners = new Set<TaskStatusListener>();
  private writeActive = 0;
  private readonly writeWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];
  private createdTaskCount = 0;
  private persistedTasksLoaded = false;

  constructor(
    readonly rootSessionId: string,
    readonly workingDir: string,
    readonly config: AgentConfig,
    runner: Pick<TaskRunner, "run"> = new TaskRunner(),
    readonly originRunId: string = rootSessionId,
  ) {
    this.runner = runner;
    this.limits = { ...DEFAULT_SUBAGENT_LIMITS, ...config.subagents };
    this.artifacts = new ArtifactStore(workingDir, originRunId);
    this.trace = new TraceSink(this.artifacts, {
      conversationId: rootSessionId,
      runId: originRunId,
    });
    this.inbox = new ConversationInbox(rootSessionId, this.artifacts);
    this.scheduler = new TaskScheduler(this.limits.maxConcurrent);
    this.trace.append({ type: "subagent_runtime_created", sessionId: rootSessionId });
    const worktrees = WorktreeManager.tryCreate(workingDir, config);
    if (worktrees) {
      const cutoff = Date.now() - config.session.cleanupPeriodDays * 24 * 60 * 60_000;
      for (const removedPath of worktrees.sweepMergedWorktrees(cutoff)) {
        this.trace.append({
          type: "worktree_removed",
          sessionId: rootSessionId,
          path: removedPath,
          reason: "startup sweep of old integrated worktree",
        });
      }
    }
    this.pruneArtifacts();
  }

  submit(
    input: AgentTaskInput,
    parentCtx: AgentContext,
    definition: SubagentDefinition,
    tools: ToolDefinition[],
  ): SubmittedTask {
    if (parentCtx.taskRuntime) {
      return this.rejectedTask(input, definition, "Only the root agent may dispatch Subagents.");
    }
    const writer = definition.isolation === "worktree" &&
      definition.tools.some((name) => ["Write", "Edit", "Bash", "*"].includes(name));
    if (!Number.isFinite(input.timeout_ms) || input.timeout_ms <= 0) {
      return this.rejectedTask(input, definition, "timeout_ms must be a positive number.");
    }
    if (writer && !input.scope?.length) {
      return this.rejectedTask(input, definition, "Worktree writers require an explicit scope.");
    }
    if (writer) {
      const overlap = [...this.tasks.values()].find((candidate) =>
        candidate.writer && !isTerminal(candidate.detail.status) &&
        scopesOverlap(input.scope!, candidate.detail.scope ?? []));
      if (overlap) {
        return this.rejectedTask(
          input,
          definition,
          `Writer scope overlaps active task ${overlap.detail.taskId}.`,
        );
      }
    }
    if (this.createdTaskCount >= this.limits.maxTasksPerSession) {
      return this.rejectedTask(input, definition, "Session subagent task limit exceeded.");
    }
    this.createdTaskCount++;

    const record = this.createRecord(input, definition, writer);
    this.tasks.set(record.detail.taskId, record);
    this.artifacts.initializeTask(record.detail, {
      timeoutMs: input.timeout_ms,
      model: input.model,
      mode: input.mode,
      coverage: input.coverage,
      isolation: input.isolation,
    });
    this.trace.append({
      type: "task_queued",
      sessionId: this.rootSessionId,
      taskId: record.detail.taskId,
      agentId: record.detail.agentId,
      description: input.description,
      reportPath: record.detail.artifacts.report,
    });
    this.emit(record);
    this.scheduler.enqueue({
      taskId: record.detail.taskId,
      run: () => this.runRecord(record, input, definition, tools),
    });
    return { task: { ...record.detail } };
  }

  async resumePersistedTasks(): Promise<void> {
    if (this.persistedTasksLoaded) return;
    this.persistedTasksLoaded = true;
    await this.trace.replayUnexported(this.rootSessionId);
    const persisted = this.artifacts.listConversationTasks(this.rootSessionId);
    this.createdTaskCount = Math.max(this.createdTaskCount, persisted.length);
    for (const saved of persisted) {
      if (this.tasks.has(saved.spec.taskId) || !fs.existsSync(saved.paths.task)) continue;
      try {
        const spec = saved.spec;
        let definition: SubagentDefinition;
        try {
          definition = getBuiltinDefinition(spec.subagentType);
        } catch {
          const custom = await findDefinition(spec.subagentType);
          if (!custom) throw new Error(`Subagent definition no longer exists: ${spec.subagentType}`);
          definition = custom;
        }
        const terminal = Boolean(saved.result);
        const detail: TaskDetail = {
          taskId: spec.taskId,
          agentId: spec.agentId,
          rootSessionId: this.rootSessionId,
          description: spec.description,
          prompt: spec.prompt,
          subagentType: spec.subagentType,
          scope: spec.scope,
          workspace: spec.workspace,
          status: terminal
            ? (saved.result?.status === "finished" ? "finished" : "failed")
            : "queued",
          createdAt: spec.createdAt,
          startedAt: spec.startedAt,
          endedAt: spec.endedAt ?? saved.result?.endedAt,
          lastActivityAt: spec.endedAt ?? spec.startedAt ?? spec.createdAt,
          currentActivity: terminal ? saved.result?.status : spec.currentActivity,
          currentTool: spec.currentTool,
          failureKind: saved.result?.failureKind ?? spec.failureKind,
          pinned: saved.pinned,
          artifacts: saved.paths,
          result: saved.result,
        };
        const writer = definition.isolation === "worktree" &&
          definition.tools.some((name) => ["Write", "Edit", "Bash", "*"].includes(name));
        const record: TaskRecord = {
          detail,
          controller: new AbortController(),
          writer,
          terminalDelivered: terminal,
          timeoutMs: Math.max(1, spec.timeoutMs ?? 1),
          accumulatedRuntimeMs: spec.accumulatedRuntimeMs ?? 0,
          attempt: spec.attempt ?? 0,
          pauseRequested: false,
        };
        this.tasks.set(spec.taskId, record);
        if (!terminal) {
          if ((spec.attempt ?? 0) > 0) {
            this.artifacts.appendReportAt(
              saved.paths.report,
              `\n\n<!-- Rubato recovery attempt ${(spec.attempt ?? 0) + 1} starting. -->\n\n`,
            );
          }
          const input: AgentTaskInput = {
            description: spec.description,
            prompt: spec.prompt,
            subagent_type: spec.subagentType,
            model: spec.model,
            timeout_ms: spec.timeoutMs ?? record.timeoutMs,
            mode: spec.mode as AgentTaskInput["mode"],
            coverage: spec.coverage as AgentTaskInput["coverage"],
            isolation: spec.isolation as AgentTaskInput["isolation"],
            scope: spec.scope,
          };
          const tools = resolveSubagentTools(definition, definition.isolation === "worktree");
          this.scheduler.enqueue({
            taskId: spec.taskId,
            run: () => this.runRecord(record, input, definition, tools),
          });
        }
      } catch (error) {
        this.artifacts.appendReportAt(
          saved.paths.report,
          `\n\n<!-- Rubato could not recover this task: ${String(error).replace(/-->/g, "--&gt;")} -->\n`,
        );
      }
    }
  }

  list(filter?: { status?: SubagentTaskStatus }): TaskSummary[] {
    return [...this.tasks.values()]
      .map((record) => this.summary(record.detail))
      .filter((task) => !filter?.status || task.status === filter.status)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  statusSnapshot(): Array<{
    taskId: string;
    description: string;
    status: SubagentTaskStatus;
    reportPath: string;
    failureKind?: SubagentFailureKind;
  }> {
    const live = [...this.tasks.values()].map((record) => ({
      taskId: record.detail.taskId,
      description: record.detail.description,
      status: record.detail.status,
      reportPath: record.detail.artifacts.report,
      failureKind: record.detail.failureKind,
    }));
    const seen = new Set(live.map((task) => task.taskId));
    const fromFiles = this.artifacts.listConversationTasks(this.rootSessionId)
      .filter((record) => !seen.has(record.spec.taskId))
      .map((record) => ({
        taskId: record.spec.taskId,
        description: record.spec.description,
        status: record.result
          ? (record.result.status === "finished" ? "finished" as const : "failed" as const)
          : (record.spec.status && isTerminal(record.spec.status) ? record.spec.status : "queued" as const),
        reportPath: record.paths.report,
        failureKind: record.result?.failureKind ?? record.spec.failureKind,
      }));
    return [...live, ...fromFiles].sort((left, right) => left.taskId.localeCompare(right.taskId));
  }

  get(taskId: string): TaskDetail | undefined {
    const detail = this.tasks.get(taskId)?.detail;
    return detail ? { ...detail, artifacts: { ...detail.artifacts } } : undefined;
  }

  async cancel(taskId: string): Promise<void> {
    const record = this.tasks.get(taskId);
    if (!record || isTerminal(record.detail.status)) return;
    record.forcedFailureKind = "cancelled";
    this.trace.append({
      type: "task_cancel_requested",
      sessionId: this.rootSessionId,
      taskId,
      agentId: record.detail.agentId,
    });
    if (record.detail.status === "queued" && this.scheduler.cancelQueued(taskId)) {
      this.finishWithoutRun(record, "cancelled", "Task was cancelled before it started.");
      return;
    }
    record.detail.currentActivity = "cancelling";
    this.emit(record);
    record.controller.abort(new Error("Task cancelled"));
  }

  async cleanup(taskId: string): Promise<void> {
    const record = this.tasks.get(taskId);
    if (!record) return;
    if (!isTerminal(record.detail.status)) throw new Error(`Cannot cleanup active task ${taskId}`);
    if (record.detail.workspace) {
      const manager = new WorktreeManager(record.detail.workspace.repoRoot, this.config);
      if (!manager.cleanupIfSafe(record.detail.workspace, record.detail.result?.workspace)) {
        throw new Error(`Worktree ${record.detail.workspace.path} is not safe to remove.`);
      }
    }
    this.artifacts.removeTask(taskId);
    this.tasks.delete(taskId);
  }

  pin(taskId: string, pinned = true): void {
    const record = this.tasks.get(taskId);
    if (!record && !this.artifacts.hasTask(taskId)) throw new Error(`Unknown task: ${taskId}`);
    this.artifacts.setPinned(taskId, pinned);
    if (record) {
      record.detail.pinned = pinned;
      this.persistRecord(record);
      this.emit(record);
    }
  }

  artifactStats(): { taskCount: number; pinnedCount: number; totalBytes: number } {
    return this.artifacts.stats();
  }

  pruneArtifacts(): { removed: string[]; freedBytes: number; remainingBytes: number } {
    const protectedTaskIds = new Set(
      [...this.tasks.values()]
        .filter((record) => !isTerminal(record.detail.status))
        .map((record) => record.detail.taskId),
    );
    const result = this.artifacts.prune({
      ttlMs: this.limits.artifactTtlDays * 24 * 60 * 60_000,
      softLimitBytes: this.limits.artifactSoftLimitBytes,
      protectedTaskIds,
    });
    for (const taskId of result.removed) this.tasks.delete(taskId);
    return result;
  }

  subscribe(listener: TaskStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasPendingTasks(): boolean {
    return [...this.tasks.values()].some((record) => !isTerminal(record.detail.status));
  }

  pauseAll(): void {
    for (const record of this.tasks.values()) {
      if (isTerminal(record.detail.status)) continue;
      record.pauseRequested = true;
      if (record.detail.status === "queued" && this.scheduler.cancelQueued(record.detail.taskId)) {
        record.detail.currentActivity = "paused";
        this.persistRecord(record);
        this.emit(record);
      } else {
        record.controller.abort(new Error("Runtime stopped"));
      }
    }
  }

  private createRecord(
    input: AgentTaskInput,
    definition: SubagentDefinition,
    writer: boolean,
  ): TaskRecord {
    const taskId = `task-${randomUUID()}`;
    const now = Date.now();
    const detail: TaskDetail = {
      taskId,
      agentId: `${this.rootSessionId}-sub-${randomUUID().slice(0, 8)}`,
      rootSessionId: this.rootSessionId,
      description: input.description,
      prompt: input.prompt,
      subagentType: definition.name,
      status: "queued",
      createdAt: now,
      lastActivityAt: now,
      currentActivity: "queued",
      scope: input.scope,
      artifacts: this.artifacts.paths(taskId),
    };
    return {
      detail,
      controller: new AbortController(),
      writer,
      terminalDelivered: false,
      timeoutMs: input.timeout_ms,
      accumulatedRuntimeMs: 0,
      attempt: 0,
      pauseRequested: false,
    };
  }

  private async runRecord(
    record: TaskRecord,
    input: AgentTaskInput,
    definition: SubagentDefinition,
    tools: ToolDefinition[],
  ): Promise<void> {
    let releaseWriteSlot = () => {};
    try {
      if (record.writer) releaseWriteSlot = await this.acquireWriteSlot(record.controller.signal);
      if (isTerminal(record.detail.status)) return;
      await this.executeRecord(record, input, definition, tools);
    } catch (error) {
      if (!record.pauseRequested && !isTerminal(record.detail.status)) {
        this.finishWithoutRun(
          record,
          record.forcedFailureKind ?? "runtime_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      releaseWriteSlot();
    }
  }

  private async executeRecord(
    record: TaskRecord,
    input: AgentTaskInput,
    definition: SubagentDefinition,
    tools: ToolDefinition[],
  ): Promise<void> {
    const attemptStartedAt = Date.now();
    const remainingTimeoutMs = Math.max(0, record.timeoutMs - record.accumulatedRuntimeMs);
    if (remainingTimeoutMs === 0) {
      this.finishWithoutRun(record, "timed_out", "Subagent safety timeout was exhausted.");
      return;
    }
    record.attempt++;
    record.detail.startedAt ??= attemptStartedAt;
    record.currentAttemptRunId = `${record.detail.taskId}-attempt-${record.attempt}-${randomUUID().slice(0, 8)}`;
    record.effectiveProvider = this.config.model.provider;
    record.effectiveModel = input.model && input.model !== "inherit"
      ? input.model
      : this.config.model.model;
    this.transition(record, "running", "starting");
    let flushReport = () => {};
    const timer = setTimeout(() => {
      record.forcedFailureKind = "timed_out";
      flushReport();
      record.controller.abort(new Error("Subagent safety timeout reached"));
    }, remainingTimeoutMs);
    timer.unref?.();

    let output: TaskRunnerOutput | undefined;
    let workspaceResult: WorkspaceResult | undefined;
    let manager: WorktreeManager | undefined;
    let taskWorkingDir = this.workingDir;
    const reportPath = record.detail.artifacts.report;
    const onActivity = (activity: string, toolName?: string) => {
      record.detail.lastActivityAt = Date.now();
      record.detail.currentActivity = activity;
      record.detail.currentTool = toolName;
      this.emit(record);
    };

    try {
      if (record.detail.workspace) {
        manager = new WorktreeManager(record.detail.workspace.repoRoot, this.config);
        taskWorkingDir = record.detail.workspace.path;
        if (!fs.existsSync(taskWorkingDir)) {
          throw new Error(`Persisted worktree is missing: ${taskWorkingDir}`);
        }
      } else if (input.isolation === "worktree" || definition.isolation === "worktree") {
        manager = new WorktreeManager(this.workingDir, this.config);
        onActivity("creating worktree");
        record.detail.workspace = manager.create(record.detail.taskId, this.rootSessionId);
        taskWorkingDir = record.detail.workspace.path;
        this.persistRecord(record);
      }
      output = await this.raceAbort(this.runner.run({
        rootSessionId: this.rootSessionId,
        taskId: record.detail.taskId,
        agentId: record.detail.agentId,
        prompt: [
          `Task: ${record.detail.description}`,
          "",
          input.prompt,
          ...(record.attempt > 1
            ? [
                "",
                "Recovery instructions:",
                `This is recovery attempt ${record.attempt}. You MUST Read the existing report at ${reportPath} before doing anything else.`,
                "Use ## Plan to see unchecked work and ## Report for conclusions already written.",
                "Continue from the first unchecked Plan item. Do not replay checked steps or clear existing Report text.",
                "Inspect the current workspace and Git state before acting. Do not replay a tool call merely because the prior attempt ended mid-operation.",
              ]
            : []),
          ...(record.detail.scope?.length
            ? ["", `Expected scope: ${record.detail.scope.join(", ")}`]
            : []),
          ...(record.detail.workspace
            ? [
                "",
                `Isolated worktree: ${record.detail.workspace.path}`,
                `Branch: ${record.detail.workspace.branch}`,
                "Implement, verify, and commit useful changes in the worktree.",
              ]
            : []),
        ].join("\n"),
        definition,
        config: {
          ...this.config,
          model: input.model && input.model !== "inherit"
            ? { ...this.config.model, model: input.model }
            : { ...this.config.model },
        },
        workingDir: taskWorkingDir,
        tools,
        coverageRequired: input.coverage === "exhaustive",
        abortSignal: record.controller.signal,
        trace: this.trace,
        appendReport: (content) => this.artifacts.appendReportAt(reportPath, content),
        registerReportFlusher: (flush) => { flushReport = flush; },
        onActivity,
        mode: input.mode,
        reportPath,
        writableWorkspace: record.writer,
        editReport: (oldString, newString, replaceAll) =>
          this.artifacts.editReport(reportPath, oldString, newString, replaceAll),
        takePlanReminder: () => this.artifacts.takePlanReminder(reportPath),
      }), record.controller.signal);
    } catch (error) {
      output = {
        status: "failed",
        failureKind: record.forcedFailureKind ?? "runtime_error",
        coverage: emptyCoverageManifest(input.coverage === "exhaustive"),
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
      record.accumulatedRuntimeMs += Math.max(0, Date.now() - attemptStartedAt);
      this.persistRecord(record);
    }

    if (record.pauseRequested) {
      flushReport();
      this.artifacts.appendReportAt(
        reportPath,
        "\n\n<!-- Rubato process paused this task; a later attempt will continue from this report. -->\n\n",
      );
      record.detail.status = "queued";
      record.detail.currentActivity = "paused";
      record.detail.currentTool = undefined;
      this.persistRecord(record);
      if (record.currentAttemptRunId) {
        this.trace.append({
          type: "task_attempt_paused",
          sessionId: this.rootSessionId,
          runId: record.currentAttemptRunId,
          taskId: record.detail.taskId,
          agentId: record.detail.agentId,
          accumulatedRuntimeMs: record.accumulatedRuntimeMs,
        });
      }
      this.emit(record);
      return;
    }

    if (!output) return;

    if (record.detail.workspace && manager) {
      try {
        workspaceResult = manager.finalize(
          record.detail.workspace,
          record.detail.artifacts.patch,
          record.detail.scope,
        );
        if (output.status === "finished" && (
          workspaceResult.dirty ||
          (record.writer && workspaceResult.commits.length === 0) ||
          workspaceResult.scopeDeviations.length > 0
        )) {
          output.status = "failed";
          output.failureKind = "worktree_invalid";
          output.error = workspaceResult.dirty
            ? "Worktree contains uncommitted changes."
            : workspaceResult.scopeDeviations.length > 0
              ? `Worktree changed files outside scope: ${workspaceResult.scopeDeviations.join(", ")}`
              : "Writer produced no commit.";
        }
        if (!workspaceResult.dirty && workspaceResult.commits.length === 0) {
          manager.cleanupIfSafe(record.detail.workspace, workspaceResult);
        }
      } catch (error) {
        output.status = "failed";
        output.failureKind = "worktree_invalid";
        output.error = error instanceof Error ? error.message : String(error);
      }
    }

    if (record.forcedFailureKind) {
      output.status = "failed";
      output.failureKind = record.forcedFailureKind;
    }
    flushReport();
    this.finish(record, output, workspaceResult);
  }

  private finish(
    record: TaskRecord,
    output: TaskRunnerOutput,
    workspace?: WorkspaceResult,
  ): void {
    if (isTerminal(record.detail.status)) return;
    const endedAt = Date.now();
    const status: SubagentTaskStatus = output.status === "finished" ? "finished" : "failed";
    record.detail.failureKind = status === "failed" ? output.failureKind ?? "runtime_error" : undefined;
    record.detail.error = status === "failed" ? output.error : undefined;
    record.detail.endedAt = endedAt;
    const result: TaskResult = {
      taskId: record.detail.taskId,
      agentId: record.detail.agentId,
      status,
      failureKind: record.detail.failureKind,
      reportPath: record.detail.artifacts.report,
      resultPath: record.detail.artifacts.result,
      transcriptPath: record.detail.artifacts.transcript,
      coveragePath: record.detail.artifacts.coverage,
      usage: output.usage,
      error: record.detail.error,
      coverage: coverageSummary(output.coverage),
      workspace,
      startedAt: record.detail.startedAt,
      endedAt,
    };
    record.detail.result = result;
    this.transition(record, status, status, { result, coverage: output.coverage });
  }

  private finishWithoutRun(
    record: TaskRecord,
    failureKind: SubagentFailureKind,
    error: string,
  ): void {
    this.finish(record, {
      status: "failed",
      failureKind,
      coverage: emptyCoverageManifest(false),
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      error,
    });
  }

  private rejectedTask(
    input: AgentTaskInput,
    definition: SubagentDefinition,
    reason: string,
  ): SubmittedTask {
    const record = this.createRecord(input, definition, false);
    this.tasks.set(record.detail.taskId, record);
    this.artifacts.initializeTask(record.detail, {
      timeoutMs: input.timeout_ms,
      model: input.model,
      mode: input.mode,
      coverage: input.coverage,
      isolation: input.isolation,
    });
    this.artifacts.appendReport(record.detail.taskId, `\nTask rejected: ${reason}\n`);
    this.finishWithoutRun(record, "runtime_error", reason);
    return { task: { ...record.detail } };
  }

  private transition(
    record: TaskRecord,
    next: SubagentTaskStatus,
    activity: string,
    terminal?: { result: TaskResult; coverage: TaskRunnerOutput["coverage"] },
  ): void {
    const current = record.detail.status;
    const valid = current === next ||
      (current === "queued" && (next === "running" || next === "failed")) ||
      (current === "running" && (next === "finished" || next === "failed"));
    if (!valid) throw new Error(`Invalid subagent status transition: ${current} -> ${next}`);
    record.detail.status = next;
    record.detail.currentActivity = activity;
    record.detail.currentTool = undefined;
    record.detail.lastActivityAt = Date.now();
    if (next === "running") {
      this.persistRecord(record);
      this.trace.append({
        type: "task_started",
        sessionId: this.rootSessionId,
        runId: record.currentAttemptRunId,
        taskId: record.detail.taskId,
        agentId: record.detail.agentId,
        provider: record.effectiveProvider,
        model: record.effectiveModel,
        attempt: record.attempt,
      });
      this.emit(record);
      return;
    }
    if (!terminal) throw new Error(`Terminal transition ${next} requires result data.`);
    const { result, coverage } = terminal;
    this.artifacts.appendReportAt(
      record.detail.artifacts.report,
      `\n\n<!-- Subagent ${next}${result.error ? `: ${result.error.replace(/-->/g, "--&gt;")}` : ""} -->\n`,
    );
    this.artifacts.finalizeTask(record.detail, result, coverage);
    this.persistRecord(record);
    this.trace.append({
      type: "task_terminal",
      sessionId: this.rootSessionId,
      runId: record.currentAttemptRunId,
      taskId: result.taskId,
      agentId: result.agentId,
      status: next,
      failureKind: result.failureKind,
      error: result.error,
      reportPath: result.reportPath,
    });
    this.emit(record);
    if (!record.terminalDelivered && this.inbox.deliver(result)) {
      record.terminalDelivered = true;
    }
    void this.trace.flush();
  }

  private persistRecord(record: TaskRecord): void {
    this.artifacts.updateTask(record.detail, {
      timeoutMs: record.timeoutMs,
      accumulatedRuntimeMs: record.accumulatedRuntimeMs,
      attempt: record.attempt,
      status: record.detail.status,
      startedAt: record.detail.startedAt,
      endedAt: record.detail.endedAt,
      currentActivity: record.detail.currentActivity,
      currentTool: record.detail.currentTool,
      failureKind: record.detail.failureKind,
    });
  }

  private async acquireWriteSlot(signal: AbortSignal): Promise<() => void> {
    const limit = Math.max(1, this.limits.maxWriteConcurrent);
    if (this.writeActive >= limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          signal,
          onAbort: () => {
            const index = this.writeWaiters.indexOf(waiter);
            if (index >= 0) this.writeWaiters.splice(index, 1);
            reject(signal.reason ?? new Error("Task cancelled"));
          },
        };
        this.writeWaiters.push(waiter);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      });
    }
    if (signal.aborted) throw signal.reason ?? new Error("Task cancelled");
    this.writeActive++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writeActive = Math.max(0, this.writeActive - 1);
      const next = this.writeWaiters.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.onAbort);
        next.resolve();
      }
    };
  }

  private raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Task aborted"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("Task aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private summary(detail: TaskDetail): TaskSummary {
    const { prompt: _prompt, result: _result, ...summary } = detail;
    return { ...summary, artifacts: { ...summary.artifacts } };
  }

  private emit(record: TaskRecord): void {
    const summary = this.summary(record.detail);
    for (const listener of this.listeners) listener(summary);
  }
}

export function isTerminal(status: SubagentTaskStatus): boolean {
  return status === "finished" || status === "failed";
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftEntry) => right.some((rightEntry) => {
    const a = normalizeScope(leftEntry);
    const b = normalizeScope(rightEntry);
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }));
}

function normalizeScope(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/$/, "");
}
