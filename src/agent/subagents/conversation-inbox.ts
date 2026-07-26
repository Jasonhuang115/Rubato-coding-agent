import type { TaskResult } from "../../shared/core-types.js";

export interface TaskInboxEvent {
  type: "subagent_completed";
  rootSessionId: string;
  taskIds: string[];
  results: TaskResult[];
  createdAt: number;
}

type Listener = (event: TaskInboxEvent) => void;

export class ConversationInbox {
  private queue: TaskInboxEvent[] = [];
  private listeners = new Set<Listener>();
  private pendingResults: TaskResult[] = [];
  private acknowledgedTaskIds = new Set<string>();
  private flushScheduled = false;

  constructor(private readonly rootSessionId: string) {}

  deliver(result: TaskResult): boolean {
    if (this.acknowledgedTaskIds.has(result.taskId)) return false;
    if (
      this.pendingResults.some((pending) => pending.taskId === result.taskId) ||
      this.queue.some((event) => event.taskIds.includes(result.taskId))
    ) {
      return false;
    }
    this.pendingResults.push(result);
    if (this.flushScheduled) return true;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
    return true;
  }

  /**
   * Marks task completions as already consumed through an explicit Task get/wait.
   * Pending and queued notifications are filtered atomically so a manual join
   * cannot cause a later parent wake.
   */
  acknowledge(taskIds: Iterable<string>): string[] {
    const ids = new Set(taskIds);
    const newlyAcknowledged: string[] = [];
    for (const taskId of ids) {
      if (!this.acknowledgedTaskIds.has(taskId)) {
        this.acknowledgedTaskIds.add(taskId);
        newlyAcknowledged.push(taskId);
      }
    }
    if (ids.size === 0) return newlyAcknowledged;

    this.pendingResults = this.pendingResults.filter((result) => !ids.has(result.taskId));
    this.queue = this.queue.flatMap((event) => {
      const results = event.results.filter((result) => !ids.has(result.taskId));
      return results.length > 0 ? [this.eventFromResults(results, event.createdAt)] : [];
    });
    return newlyAcknowledged;
  }

  drain(): TaskInboxEvent[] {
    const events = this.queue.splice(0);
    this.acknowledge(events.flatMap((event) => event.taskIds));
    return events;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wait(signal?: AbortSignal): Promise<TaskInboxEvent> {
    const ready = this.queue.shift();
    if (ready) {
      this.acknowledge(ready.taskIds);
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const unsubscribe = this.subscribe((event) => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        const index = this.queue.indexOf(event);
        if (index >= 0) this.queue.splice(index, 1);
        this.acknowledge(event.taskIds);
        resolve(event);
      });
      const onAbort = () => {
        unsubscribe();
        reject(signal?.reason ?? new Error("Inbox wait aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.pendingResults.length === 0) return;
    const results = this.pendingResults.splice(0)
      .filter((result) => !this.acknowledgedTaskIds.has(result.taskId));
    if (results.length === 0) return;
    const event = this.eventFromResults(results);
    this.queue.push(event);
    for (const listener of this.listeners) listener(event);
  }

  private eventFromResults(results: TaskResult[], createdAt = Date.now()): TaskInboxEvent {
    return {
      type: "subagent_completed",
      rootSessionId: this.rootSessionId,
      taskIds: results.map((result) => result.taskId),
      results,
      createdAt,
    };
  }
}
