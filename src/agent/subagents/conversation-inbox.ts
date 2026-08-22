import type { TaskResult } from "../../shared/core-types.js";
import type { ArtifactStore } from "./artifact-store.js";

export type SubagentTerminalResult = Pick<
  TaskResult,
  "taskId" | "status" | "reportPath" | "error"
>;

export interface TaskInboxEvent {
  type: "subagent_terminal";
  rootSessionId: string;
  taskIds: string[];
  results: SubagentTerminalResult[];
  createdAt: number;
}

type Listener = (event: TaskInboxEvent) => void;

export class ConversationInbox {
  private queue: TaskInboxEvent[] = [];
  private listeners = new Set<Listener>();
  private pendingResults: SubagentTerminalResult[] = [];
  private deliveredTaskIds = new Set<string>();
  private flushScheduled = false;

  constructor(
    private readonly rootSessionId: string,
    private readonly artifacts?: ArtifactStore,
  ) {
    if (artifacts) this.restorePending();
  }

  deliver(result: TaskResult): boolean {
    if (this.deliveredTaskIds.has(result.taskId)) return false;
    if (
      this.pendingResults.some((pending) => pending.taskId === result.taskId) ||
      this.queue.some((event) => event.taskIds.includes(result.taskId))
    ) {
      return false;
    }
    this.pendingResults.push({
      taskId: result.taskId,
      status: result.status,
      reportPath: result.reportPath,
      error: result.error,
    });
    if (this.flushScheduled) return true;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
    return true;
  }

  drain(): TaskInboxEvent[] {
    const events = this.queue.splice(0);
    this.acknowledge(events);
    return events;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wait(signal?: AbortSignal): Promise<TaskInboxEvent> {
    const ready = this.queue.shift();
    if (ready) {
      this.acknowledge([ready]);
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const unsubscribe = this.subscribe((event) => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        const index = this.queue.indexOf(event);
        if (index >= 0) this.queue.splice(index, 1);
        this.acknowledge([event]);
        resolve(event);
      });
      const onAbort = () => {
        unsubscribe();
        reject(signal?.reason ?? new Error("Inbox wait aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private acknowledge(events: TaskInboxEvent[]): void {
    if (!this.artifacts) return;
    for (const event of events) {
      for (const taskId of event.taskIds) this.artifacts.markNotified(taskId);
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.pendingResults.length === 0) return;
    const results = this.pendingResults.splice(0)
      .filter((result) => !this.deliveredTaskIds.has(result.taskId));
    if (results.length === 0) return;
    for (const result of results) this.deliveredTaskIds.add(result.taskId);
    const event = this.eventFromResults(results);
    this.queue.push(event);
    for (const listener of this.listeners) listener(event);
  }

  private eventFromResults(
    results: SubagentTerminalResult[],
    createdAt = Date.now(),
  ): TaskInboxEvent {
    return {
      type: "subagent_terminal",
      rootSessionId: this.rootSessionId,
      taskIds: results.map((result) => result.taskId),
      results,
      createdAt,
    };
  }

  private restorePending(): void {
    const pending = this.artifacts?.listUnnotifiedResults(this.rootSessionId) ?? [];
    if (pending.length === 0) return;
    const results: SubagentTerminalResult[] = pending.map((result) => ({
      taskId: result.taskId,
      status: result.status,
      reportPath: result.reportPath,
      error: result.error,
    }));
    for (const result of results) this.deliveredTaskIds.add(result.taskId);
    this.queue.push(this.eventFromResults(results));
  }
}
