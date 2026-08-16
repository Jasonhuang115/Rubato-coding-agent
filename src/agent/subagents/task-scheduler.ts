export interface SchedulerJob {
  taskId: string;
  run: () => Promise<void>;
}

/** Process-local FIFO scheduler with a fixed concurrency ceiling. */
export class TaskScheduler {
  private readonly queue: SchedulerJob[] = [];
  private active = 0;

  constructor(private readonly maxConcurrent: number) {}

  enqueue(job: SchedulerJob): void {
    this.queue.push(job);
    this.pump();
  }

  cancelQueued(taskId: string): boolean {
    const index = this.queue.findIndex((job) => job.taskId === taskId);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  private pump(): void {
    while (this.active < this.maxConcurrent) {
      const job = this.queue.shift();
      if (!job) return;
      this.active++;
      void job.run().finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.pump();
      });
    }
  }
}
