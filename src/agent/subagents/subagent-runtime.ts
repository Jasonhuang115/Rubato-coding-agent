import { randomUUID } from "crypto";
import type {
  AgentConfig,
  AgentContext,
  AgentTaskInput,
  SubagentDefinition,
  SubagentLimits,
  SubagentTaskStatus,
  TaskDetail,
  TaskResult,
  TaskService,
  TaskSummary,
  ToolDefinition,
} from "../../shared/core-types.js";
import { ArtifactStore } from "./artifact-store.js";
import { ConversationInbox } from "./conversation-inbox.js";
import { TaskRunner, type TaskRunnerOutput } from "./task-runner.js";
import { TaskScheduler } from "./task-scheduler.js";
import { TraceSink } from "./trace-sink.js";
import { coverageSummary, emptyCoverageManifest } from "./coverage.js";
import { WorktreeManager } from "../worktrees/worktree-manager.js";

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  maxConcurrent: 4,
  maxWriteConcurrent: 2,
  maxTasksPerSession: 32,
  maxDepth: 3,
  stallTimeoutMs: 15 * 60_000,
  hardTimeoutMs: 2 * 60 * 60_000,
  maxTurns: undefined,
  artifactTtlDays: 30,
  artifactSoftLimitBytes: 2 * 1024 * 1024 * 1024,
};

interface TaskRecord {
  detail: TaskDetail;
  controller: AbortController;
  resolve: (result: TaskResult) => void;
  promise: Promise<TaskResult>;
  forcedStatus?: "timed_out" | "cancelled";
  children: Set<string>;
  onConfirmTool?: AgentContext["onConfirmTool"];
  writer: boolean;
}

export interface SubmittedTask {
  task: TaskDetail;
  result: Promise<TaskResult>;
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
  private confirmationTail: Promise<void> = Promise.resolve();
  private writeActive = 0;
  private readonly writeWaiters: Array<{
    resolve: () => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];
  private createdTaskCount = 0;

  constructor(
    readonly rootSessionId: string,
    readonly workingDir: string,
    readonly config: AgentConfig,
    runner: Pick<TaskRunner, "run"> = new TaskRunner(),
  ) {
    this.runner = runner;
    this.limits = { ...DEFAULT_SUBAGENT_LIMITS, ...config.subagents };
    this.artifacts = new ArtifactStore(workingDir, rootSessionId);
    this.trace = new TraceSink(this.artifacts);
    this.inbox = new ConversationInbox(rootSessionId);
    this.scheduler = new TaskScheduler(this.limits.maxConcurrent);
    this.trace.append({ type: "subagent_runtime_created", sessionId: rootSessionId });
    const worktrees = WorktreeManager.tryCreate(workingDir, config);
    if (worktrees) {
      const cutoff = Date.now() -
        config.session.cleanupPeriodDays * 24 * 60 * 60_000;
      for (const removedPath of worktrees.sweepMergedWorktrees(cutoff)) {
        this.trace.append({
          type: "worktree_removed",
          sessionId: rootSessionId,
          path: removedPath,
          reason: "startup sweep of old integrated worktree",
        });
      }
    }
    for (const result of this.artifacts.recoverOrphaned()) {
      this.trace.append({
        type: "task_recovered_orphaned",
        sessionId: rootSessionId,
        taskId: result.taskId,
        agentId: result.agentId,
        resultPath: result.resultPath,
      });
      this.artifacts.refreshTranscript(result.taskId);
    }
    const startupPrune = this.pruneArtifacts();
    if (startupPrune.remainingBytes > this.limits.artifactSoftLimitBytes) {
      this.trace.append({
        type: "artifact_space_pressure",
        sessionId: rootSessionId,
        remainingBytes: startupPrune.remainingBytes,
        softLimitBytes: this.limits.artifactSoftLimitBytes,
        reason: "Only pinned, active, or otherwise protected artifacts remain.",
      });
    }
  }

  submit(
    input: AgentTaskInput,
    parentCtx: AgentContext,
    definition: SubagentDefinition,
    tools: ToolDefinition[],
  ): SubmittedTask {
    const parentTaskId = parentCtx.taskRuntime?.taskId;
    const depth = (parentCtx.taskRuntime?.depth ?? parentCtx.depth ?? 0) + 1;
    const dependency = parentTaskId ? "required" : (input.dependency ?? "required");
    const writer = definition.isolation === "worktree" &&
      definition.tools.some((name) => ["Write", "Edit", "Bash", "*"].includes(name));

    if (depth > this.limits.maxDepth) {
      return this.rejectedTask(input, definition, parentTaskId, depth, "Maximum subagent recursion depth exceeded.");
    }
    if (writer && !input.scope?.length) {
      return this.rejectedTask(
        input,
        definition,
        parentTaskId,
        depth,
        "Worktree writers require an explicit non-overlapping scope.",
      );
    }
    if (writer) {
      const overlap = [...this.tasks.values()].find((candidate) =>
        candidate.writer &&
        !isTerminal(candidate.detail.status) &&
        scopesOverlap(input.scope!, candidate.detail.scope ?? []));
      if (overlap) {
        return this.rejectedTask(
          input,
          definition,
          parentTaskId,
          depth,
          `Writer scope overlaps active task ${overlap.detail.taskId}.`,
        );
      }
    }
    if (this.createdTaskCount >= this.limits.maxTasksPerSession) {
      return this.rejectedTask(input, definition, parentTaskId, depth, "Root session subagent task budget exceeded.");
    }
    this.createdTaskCount++;

    const taskId = `task-${randomUUID()}`;
    const agentId = `${this.rootSessionId}-sub-${randomUUID().slice(0, 8)}`;
    const createdAt = Date.now();
    const artifacts = this.artifacts.paths(taskId);
    const detail: TaskDetail = {
      taskId,
      agentId,
      rootSessionId: this.rootSessionId,
      parentTaskId,
      description: input.description,
      prompt: input.prompt,
      subagentType: definition.name,
      dependency,
      status: "queued",
      depth,
      createdAt,
      lastActivityAt: createdAt,
      currentActivity: "queued",
      childCount: 0,
      scope: input.scope,
      artifacts,
    };

    let resolveResult!: (result: TaskResult) => void;
    const promise = new Promise<TaskResult>((resolve) => {
      resolveResult = resolve;
    });
    const record: TaskRecord = {
      detail,
      controller: new AbortController(),
      resolve: resolveResult,
      promise,
      children: new Set(),
      onConfirmTool: parentCtx.onConfirmTool
        ? (toolName, toolInput) =>
            this.requestConfirmation(parentCtx.onConfirmTool!, toolName, toolInput)
        : undefined,
      writer,
    };
    this.tasks.set(taskId, record);
    this.artifacts.initializeTask(detail);
    this.trace.append({
      type: "task_queued",
      sessionId: this.rootSessionId,
      taskId,
      agentId,
      parentTaskId,
      dependency,
      depth,
      description: input.description,
    });

    let parentSuspended = false;
    if (parentTaskId) {
      const parent = this.tasks.get(parentTaskId);
      if (parent) {
        parent.children.add(taskId);
        parent.detail.childCount = parent.children.size;
        parent.detail.status = "waiting_child";
        parent.detail.currentActivity = `waiting for ${taskId}`;
        parentSuspended = this.scheduler.suspendForChild(parentTaskId);
        this.emit(parent);
        this.trace.append({
          type: "task_waiting_child",
          sessionId: this.rootSessionId,
          taskId: parentTaskId,
          agentId: parent.detail.agentId,
          childTaskId: taskId,
          releasedSlot: parentSuspended,
        });
      }
    }

    this.scheduler.enqueue({
      taskId,
      dependency,
      depth,
      createdAt,
      run: () => this.runRecord(record, input, definition, tools),
    });
    this.emit(record);

    const outward = parentTaskId && parentSuspended
      ? promise.then(async (result) => {
          await this.scheduler.reacquireAfterChild(parentTaskId);
          const parent = this.tasks.get(parentTaskId);
          if (parent && !isTerminal(parent.detail.status)) {
            parent.detail.status = "running";
            parent.detail.currentActivity = `resumed after ${taskId}`;
            parent.detail.lastActivityAt = Date.now();
            this.emit(parent);
            this.trace.append({
              type: "task_resumed",
              sessionId: this.rootSessionId,
              taskId: parentTaskId,
              agentId: parent.detail.agentId,
              childTaskId: taskId,
            });
          }
          return result;
        })
      : promise;

    return { task: detail, result: outward };
  }

  list(filter?: { status?: SubagentTaskStatus }): TaskSummary[] {
    return [...this.tasks.values()]
      .map((record) => this.summary(record.detail))
      .filter((task) => !filter?.status || task.status === filter.status)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  get(taskId: string): TaskDetail | undefined {
    const record = this.tasks.get(taskId);
    if (!record) return undefined;
    if (isTerminal(record.detail.status)) {
      this.acknowledgeCompletion(record, "get");
    }
    return { ...record.detail, artifacts: { ...record.detail.artifacts } };
  }

  async wait(taskId: string, timeoutMs?: number): Promise<TaskResult> {
    const waitSpanId = randomUUID();
    const startedAt = Date.now();
    const record = this.tasks.get(taskId);
    this.trace.append({
      type: "task_wait_started",
      sessionId: this.rootSessionId,
      taskId,
      agentId: record?.detail.agentId,
      spanId: waitSpanId,
      timeoutMs,
    });
    try {
      if (!record) throw new Error(`Unknown task: ${taskId}`);
      const result = timeoutMs && timeoutMs > 0
        ? await this.waitWithTimeout(record, timeoutMs)
        : await record.promise;
      this.acknowledgeCompletion(record, "wait");
      this.trace.append({
        type: "task_wait_completed",
        sessionId: this.rootSessionId,
        taskId,
        agentId: record.detail.agentId,
        parentSpanId: waitSpanId,
        outcome: "result",
        status: result.status,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.trace.append({
        type: "task_wait_completed",
        sessionId: this.rootSessionId,
        taskId,
        agentId: record?.detail.agentId,
        parentSpanId: waitSpanId,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async cancel(taskId: string, cascade = true): Promise<void> {
    const record = this.tasks.get(taskId);
    if (!record || isTerminal(record.detail.status)) return;
    record.forcedStatus = "cancelled";
    record.controller.abort(new Error("Task cancelled"));
    record.detail.currentActivity = "cancelling";
    this.trace.append({
      type: "task_cancel_requested",
      sessionId: this.rootSessionId,
      taskId,
      agentId: record.detail.agentId,
      cascade,
    });
    this.emit(record);
    if (record.detail.status === "queued" && this.scheduler.cancelQueued(taskId)) {
      this.finalizeWithoutRun(record, "cancelled", "Task was cancelled before it started.");
    }
    if (cascade) {
      await Promise.all([...record.children].map((childId) => this.cancel(childId, true)));
    }
  }

  async cleanup(taskId: string): Promise<void> {
    const record = this.tasks.get(taskId);
    if (!record) return;
    if (!isTerminal(record.detail.status)) {
      throw new Error(`Cannot cleanup non-terminal task ${taskId}`);
    }
    if (record.detail.workspace) {
      const manager = new WorktreeManager(record.detail.workspace.repoRoot, this.config);
      if (!manager.cleanupIfSafe(record.detail.workspace, record.detail.result?.workspace)) {
        throw new Error(
          `Worktree ${record.detail.workspace.path} contains uncommitted or unmerged work; ` +
          "merge/cherry-pick the branch before cleanup.",
        );
      }
      this.trace.append({
        type: "worktree_removed",
        sessionId: this.rootSessionId,
        taskId,
        agentId: record.detail.agentId,
        reason: "task cleanup after integration",
      });
    }
    this.artifacts.removeTask(taskId);
    this.tasks.delete(taskId);
    this.trace.append({
      type: "task_cleaned",
      sessionId: this.rootSessionId,
      taskId,
      agentId: record.detail.agentId,
    });
  }

  pin(taskId: string, pinned = true): void {
    const record = this.tasks.get(taskId);
    if (!record && !this.artifacts.hasTask(taskId)) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    this.artifacts.setPinned(taskId, pinned);
    if (record) record.detail.pinned = pinned;
    this.trace.append({
      type: pinned ? "task_pinned" : "task_unpinned",
      sessionId: this.rootSessionId,
      taskId,
      agentId: record?.detail.agentId,
    });
    if (record) this.emit(record);
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
    this.trace.append({
      type: "artifact_pruned",
      sessionId: this.rootSessionId,
      removedTaskIds: result.removed,
      freedBytes: result.freedBytes,
      remainingBytes: result.remainingBytes,
    });
    return result;
  }

  subscribe(listener: TaskStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasPendingAdvisory(): boolean {
    return [...this.tasks.values()].some((record) =>
      record.detail.dependency === "advisory" && !isTerminal(record.detail.status),
    );
  }

  markRunningTasksOrphaned(): void {
    for (const record of this.tasks.values()) {
      if (!isTerminal(record.detail.status)) {
        record.forcedStatus = "cancelled";
        record.controller.abort(new Error("Runtime stopped"));
        record.detail.status = "orphaned";
        record.detail.endedAt = Date.now();
        record.detail.currentActivity = "orphaned after runtime exit";
        this.emit(record);
      }
    }
  }

  private async runRecord(
    record: TaskRecord,
    input: AgentTaskInput,
    definition: SubagentDefinition,
    tools: ToolDefinition[],
  ): Promise<void> {
    const isWriter = definition.isolation === "worktree" &&
      definition.tools.some((name) => ["Write", "Edit", "Bash", "*"].includes(name));
    let releaseWriteSlot = () => {};
    try {
      if (isWriter) {
        try {
          releaseWriteSlot = await this.acquireWriteSlot(record.controller.signal);
        } catch {
          this.finalizeWithoutRun(
            record,
            "cancelled",
            "Task was cancelled while waiting for an isolated writer slot.",
          );
          return;
        }
      }
      await this.executeRecord(record, input, definition, tools);
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
    const detail = record.detail;
    detail.status = "running";
    detail.startedAt = Date.now();
    detail.lastActivityAt = detail.startedAt;
    detail.currentActivity = "starting";
    this.emit(record);
    this.trace.append({
      type: "task_started",
      sessionId: this.rootSessionId,
      taskId: detail.taskId,
      agentId: detail.agentId,
    });

    const hardTimeoutMs = input.timeout_ms ?? this.limits.hardTimeoutMs;
    const hardTimer = setTimeout(() => {
      record.forcedStatus = "timed_out";
      record.controller.abort(new Error("Task hard timeout"));
    }, hardTimeoutMs);
    hardTimer.unref?.();
    let stallTimer: ReturnType<typeof setTimeout>;
    const checkForStall = () => {
      const inactiveForMs = Date.now() - detail.lastActivityAt;
      const remainingMs = this.limits.stallTimeoutMs - inactiveForMs;
      if (remainingMs <= 0) {
        record.forcedStatus = "timed_out";
        record.controller.abort(new Error("Task stalled"));
        return;
      }
      stallTimer = setTimeout(checkForStall, remainingMs);
      stallTimer.unref?.();
    };
    stallTimer = setTimeout(checkForStall, this.limits.stallTimeoutMs);
    stallTimer.unref?.();

    let lastEmittedActivityAt = 0;
    let lastEmittedActivity = "";
    const onActivity = (activity: string, toolName?: string) => {
      const now = Date.now();
      detail.lastActivityAt = now;
      detail.currentActivity = activity;
      detail.currentTool = toolName;
      const label = `${activity}:${toolName ?? ""}`;
      if (label === lastEmittedActivity && now - lastEmittedActivityAt < 5_000) return;
      lastEmittedActivityAt = now;
      lastEmittedActivity = label;
      this.emit(record);
    };

    let output: TaskRunnerOutput | undefined;
    let worktreeManager: WorktreeManager | undefined;
    let taskWorkingDir = this.workingDir;
    if (input.isolation === "worktree" || definition.isolation === "worktree") {
      try {
        worktreeManager = new WorktreeManager(this.workingDir, this.config);
        detail.currentActivity = "creating worktree";
        detail.workspace = worktreeManager.create(detail.taskId, this.rootSessionId);
        taskWorkingDir = detail.workspace.path;
        this.artifacts.updateTask(detail);
        this.trace.append({
          type: "worktree_created",
          sessionId: this.rootSessionId,
          taskId: detail.taskId,
          agentId: detail.agentId,
          path: detail.workspace.path,
          branch: detail.workspace.branch,
          baseCommit: detail.workspace.baseCommit,
          sourceDirty: detail.workspace.sourceDirty,
        });
      } catch (error) {
        output = {
          status: "failed",
          summary: "The isolated Git worktree could not be created.",
          report: `# Worktree creation failed\n\n${error instanceof Error ? error.message : String(error)}`,
          usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    try {
      output ??= await this.raceAbort(this.runner.run({
        rootSessionId: this.rootSessionId,
        parentSessionId: this.rootSessionId,
        parentTaskId: detail.parentTaskId,
        taskId: detail.taskId,
        agentId: detail.agentId,
        depth: detail.depth,
        prompt: [
          `Task: ${detail.description}`,
          "",
          input.prompt,
          ...(detail.scope?.length
            ? ["", `Expected scope: ${detail.scope.join(", ")}`]
            : []),
          ...(detail.workspace
            ? [
                "",
                `Isolated worktree: ${detail.workspace.path}`,
                `Branch: ${detail.workspace.branch}`,
                `Base commit: ${detail.workspace.baseCommit}`,
                detail.workspace.sourceDirty
                  ? "Warning: the source checkout is dirty; its uncommitted changes are not present here."
                  : "",
              ].filter(Boolean)
            : []),
          "",
          definition.isolation === "worktree"
            ? "Implement, test, commit the deliverable, and report branch/commit evidence."
            : "Return evidence, conclusions, uncertainty, and recommended next steps.",
          "You must finish by calling CompleteTask with a self-contained Markdown report.",
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
        onConfirmTool: record.onConfirmTool,
        trace: this.trace,
        onActivity,
      }), record.controller.signal);
    } catch (error) {
      output = {
        status: record.forcedStatus ?? "failed",
        summary: record.forcedStatus === "timed_out"
          ? "Task reached its runtime safety timeout."
          : record.forcedStatus === "cancelled"
            ? "Task was cancelled."
            : "Task runner failed.",
        report: `# Incomplete task\n\n${error instanceof Error ? error.message : String(error)}`,
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(hardTimer);
      clearTimeout(stallTimer);
    }

    output ??= {
      status: "failed",
      summary: "Task ended without a runner result.",
      report: "# Incomplete task\n\nNo runner result was produced.",
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      error: "No runner result was produced.",
    };
    let status = record.forcedStatus ?? output.status;
    let workspaceResult;
    if (detail.workspace && worktreeManager) {
      try {
        workspaceResult = worktreeManager.finalize(
          detail.workspace,
          detail.artifacts.patch,
          detail.scope,
        );
        if (workspaceResult.dirty && status === "completed") {
          status = "partial";
          output.summary =
            `${output.summary} Worktree has uncommitted changes; resume the worker and commit before integration.`;
        }
        const noTaskCommits = workspaceResult.commits.length === 0;
        const isWriter = definition.tools.some((name) =>
          ["Write", "Edit", "Bash", "*"].includes(name));
        if (isWriter && noTaskCommits && status === "completed") {
          status = "partial";
          output.summary =
            `${output.summary} Worker produced no commit, so there is nothing to integrate.`;
        }
        if (!workspaceResult.dirty && noTaskCommits) {
          const cleaned = worktreeManager.cleanupIfSafe(detail.workspace, workspaceResult);
          if (cleaned) {
            this.trace.append({
              type: "worktree_removed",
              sessionId: this.rootSessionId,
              taskId: detail.taskId,
              agentId: detail.agentId,
              reason: "clean task with no commits",
            });
          }
        }
        this.trace.append({
          type: "worktree_finalized",
          sessionId: this.rootSessionId,
          taskId: detail.taskId,
          agentId: detail.agentId,
          branch: workspaceResult.branch,
          headCommit: workspaceResult.headCommit,
          commits: workspaceResult.commits,
          filesChanged: workspaceResult.filesChanged,
          dirty: workspaceResult.dirty,
          patchPath: workspaceResult.patchPath,
          scopeDeviations: workspaceResult.scopeDeviations,
        });
      } catch (error) {
        status = "failed";
        output.error = error instanceof Error ? error.message : String(error);
        output.summary = `${output.summary} Worktree finalization failed: ${output.error}`;
      }
    }
    const finalCoverage = output.coverage ??
      emptyCoverageManifest(input.coverage === "exhaustive");
    detail.status = status;
    detail.endedAt = Date.now();
    detail.lastActivityAt = detail.endedAt;
    detail.currentActivity = status;
    detail.currentTool = undefined;
    const result: TaskResult = {
      taskId: detail.taskId,
      agentId: detail.agentId,
      status,
      summary: output.summary,
      reportPath: detail.artifacts.report,
      resultPath: detail.artifacts.result,
      transcriptPath: detail.artifacts.transcript,
      coveragePath: detail.artifacts.coverage,
      usage: output.usage,
      error: output.error,
      keyFiles: output.completion?.key_files,
      artifacts: output.completion?.artifacts,
      coverage: coverageSummary(finalCoverage),
      workspace: workspaceResult,
      startedAt: detail.startedAt,
      endedAt: detail.endedAt,
    };
    detail.result = result;
    this.trace.append({
      type: "task_terminal",
      sessionId: this.rootSessionId,
      taskId: detail.taskId,
      agentId: detail.agentId,
      status,
      summary: output.summary,
      resultPath: result.resultPath,
      reportPath: result.reportPath,
      coveragePath: result.coveragePath,
    });
    this.artifacts.finalizeTask(detail, result, output.report, finalCoverage);
    this.emit(record);
    record.resolve(result);
    if (detail.dependency === "advisory") {
      if (this.inbox.deliver(result)) {
        this.trace.append({
          type: "background_notification_queued",
          sessionId: this.rootSessionId,
          taskId: detail.taskId,
          agentId: detail.agentId,
        });
      }
    }
  }

  private async requestConfirmation(
    handler: NonNullable<AgentContext["onConfirmTool"]>,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<NonNullable<AgentContext["onConfirmTool"]>>>> {
    const request = this.confirmationTail.then(() => handler(toolName, input));
    this.confirmationTail = request.then(() => undefined, () => undefined);
    return request;
  }

  private async acquireWriteSlot(signal: AbortSignal): Promise<() => void> {
    const limit = Math.max(1, this.limits.maxWriteConcurrent);
    if (this.writeActive >= limit) {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
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

  private finalizeWithoutRun(
    record: TaskRecord,
    status: "cancelled" | "orphaned",
    summary: string,
  ): void {
    const endedAt = Date.now();
    record.detail.status = status;
    record.detail.endedAt = endedAt;
    record.detail.lastActivityAt = endedAt;
    record.detail.currentActivity = status;
    const result: TaskResult = {
      taskId: record.detail.taskId,
      agentId: record.detail.agentId,
      status,
      summary,
      reportPath: record.detail.artifacts.report,
      resultPath: record.detail.artifacts.result,
      transcriptPath: record.detail.artifacts.transcript,
      coveragePath: record.detail.artifacts.coverage,
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      coverage: coverageSummary(emptyCoverageManifest(false)),
      endedAt,
    };
    record.detail.result = result;
    this.trace.append({
      type: "task_terminal",
      sessionId: this.rootSessionId,
      taskId: result.taskId,
      agentId: result.agentId,
      status,
      summary,
    });
    this.artifacts.finalizeTask(record.detail, result, `# ${status}\n\n${summary}`);
    this.emit(record);
    record.resolve(result);
  }

  private rejectedTask(
    input: AgentTaskInput,
    definition: SubagentDefinition,
    parentTaskId: string | undefined,
    depth: number,
    reason: string,
  ): SubmittedTask {
    const taskId = `task-${randomUUID()}`;
    const agentId = `${this.rootSessionId}-sub-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const detail: TaskDetail = {
      taskId,
      agentId,
      rootSessionId: this.rootSessionId,
      parentTaskId,
      description: input.description,
      prompt: input.prompt,
      subagentType: definition.name,
      dependency: parentTaskId ? "required" : (input.dependency ?? "required"),
      status: "failed",
      depth,
      createdAt: now,
      endedAt: now,
      lastActivityAt: now,
      currentActivity: reason,
      childCount: 0,
      artifacts: this.artifacts.paths(taskId),
    };
    const result: TaskResult = {
      taskId,
      agentId,
      status: "failed",
      summary: reason,
      reportPath: detail.artifacts.report,
      resultPath: detail.artifacts.result,
      transcriptPath: detail.artifacts.transcript,
      coveragePath: detail.artifacts.coverage,
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      coverage: coverageSummary(emptyCoverageManifest(false)),
      error: reason,
      endedAt: now,
    };
    detail.result = result;
    let resolve!: (value: TaskResult) => void;
    const promise = new Promise<TaskResult>((done) => { resolve = done; });
    const record: TaskRecord = {
      detail,
      controller: new AbortController(),
      resolve,
      promise,
      children: new Set(),
      writer: false,
    };
    this.tasks.set(taskId, record);
    this.artifacts.initializeTask(detail);
    this.artifacts.finalizeTask(detail, result, `# Task rejected\n\n${reason}`);
    resolve(result);
    return { task: detail, result: promise };
  }

  private summary(detail: TaskDetail): TaskSummary {
    const { prompt: _prompt, result: _result, ...summary } = detail;
    return { ...summary, artifacts: { ...summary.artifacts } };
  }

  private emit(record: TaskRecord): void {
    const summary = this.summary(record.detail);
    for (const listener of this.listeners) listener(summary);
  }

  private acknowledgeCompletion(record: TaskRecord, source: "get" | "wait"): void {
    if (record.detail.dependency !== "advisory" || !record.detail.result) return;
    const acknowledged = this.inbox.acknowledge([record.detail.taskId]);
    if (acknowledged.length === 0) return;
    this.trace.append({
      type: "background_notification_acknowledged",
      sessionId: this.rootSessionId,
      taskId: record.detail.taskId,
      agentId: record.detail.agentId,
      source,
    });
  }

  private waitWithTimeout(
    record: TaskRecord,
    timeoutMs: number,
  ): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const task = record.detail;
        const elapsedMs = Date.now() - (task.startedAt ?? task.createdAt);
        reject(new Error(
          `Timed out waiting for task ${task.taskId}; task is still ${task.status}. ` +
          `Elapsed ${formatElapsed(elapsedMs)}; activity=${task.currentActivity ?? "unknown"}; ` +
          `tool=${task.currentTool ?? "none"}; children=${task.childCount}. ` +
          "The task was not cancelled. Use Task get/watch or wait again.",
        ));
      }, timeoutMs);
      timer.unref?.();
      record.promise.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Task aborted"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason ?? new Error("Task aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}

export function isTerminal(status: SubagentTaskStatus): boolean {
  return status === "completed" || status === "partial" || status === "blocked" ||
    status === "failed" || status === "timed_out" || status === "cancelled" ||
    status === "orphaned";
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

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
