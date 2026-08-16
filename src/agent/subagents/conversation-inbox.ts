import type { TaskResult } from "../../shared/core-types.js";
import { randomUUID } from "node:crypto";
import type { ControlPlaneStore } from "../../runtime/control-plane/store.js";

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
  eventIds?: string[];
}

type Listener = (event: TaskInboxEvent) => void;

export class ConversationInbox {
  private queue: TaskInboxEvent[] = [];
  private listeners = new Set<Listener>();
  private pendingResults: SubagentTerminalResult[] = [];
  private pendingEventIds = new Map<string, string>();
  private deliveredTaskIds = new Set<string>();
  private flushScheduled = false;
  private readonly claimOwner = `inbox-${randomUUID()}`;

  constructor(
    private readonly rootSessionId: string,
    private readonly controlPlane?: ControlPlaneStore,
  ) {
    if (controlPlane) this.restorePending();
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
    const eventId = this.controlPlane?.createTerminalEvent(this.rootSessionId, {
      taskId: result.taskId,
      status: result.status === "finished" ? "finished" : "failed",
      failureKind: result.failureKind,
      reportPath: result.reportPath,
      claimOwner: this.claimOwner,
    });
    if (eventId) this.pendingEventIds.set(result.taskId, eventId);
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
    const ids = events.flatMap((event) => event.eventIds ?? []);
    this.controlPlane?.markEventsDelivered(ids, this.claimOwner);
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.pendingResults.length === 0) return;
    const results = this.pendingResults.splice(0)
      .filter((result) => !this.deliveredTaskIds.has(result.taskId));
    if (results.length === 0) return;
    for (const result of results) this.deliveredTaskIds.add(result.taskId);
    const event = this.eventFromResults(results);
    event.eventIds = results.flatMap((result) => {
      const eventId = this.pendingEventIds.get(result.taskId);
      this.pendingEventIds.delete(result.taskId);
      return eventId ? [eventId] : [];
    });
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
    const persisted = this.controlPlane?.claimEvents(
      this.rootSessionId,
      this.claimOwner,
    ) ?? [];
    const terminal = persisted.filter((event) =>
      event.kind === "subagent_terminal" && event.taskId && event.terminalStatus && event.reportPath);
    if (terminal.length === 0) return;
    const results: SubagentTerminalResult[] = terminal.map((event) => ({
      taskId: event.taskId!,
      status: event.terminalStatus!,
      reportPath: event.reportPath!,
    }));
    for (const result of results) this.deliveredTaskIds.add(result.taskId);
    this.queue.push({
      ...this.eventFromResults(results, Math.min(...terminal.map((event) => event.createdAt))),
      eventIds: terminal.map((event) => event.eventId),
    });
  }
}
