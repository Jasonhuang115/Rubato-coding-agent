import type { SubagentDependency } from "../../shared/core-types.js";

export interface SchedulerJob {
  taskId: string;
  dependency: SubagentDependency;
  depth: number;
  createdAt: number;
  run: () => Promise<void>;
}

interface RunningSlot {
  held: boolean;
}

interface ResumeWaiter {
  taskId: string;
  resolve: () => void;
}

/**
 * Process-local FIFO scheduler. Required/nested work and suspended-parent
 * resumptions are preferred over new advisory work.
 */
export class TaskScheduler {
  private queue: SchedulerJob[] = [];
  private running = new Map<string, RunningSlot>();
  private resumes: ResumeWaiter[] = [];
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

  suspendForChild(taskId: string): boolean {
    const slot = this.running.get(taskId);
    if (!slot?.held) return false;
    slot.held = false;
    this.active = Math.max(0, this.active - 1);
    this.pump();
    return true;
  }

  reacquireAfterChild(taskId: string): Promise<void> {
    const slot = this.running.get(taskId);
    if (!slot || slot.held) return Promise.resolve();
    return new Promise((resolve) => {
      this.resumes.push({ taskId, resolve });
      this.pump();
    });
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.length + this.resumes.length;
  }

  private pump(): void {
    while (this.active < this.maxConcurrent) {
      const resume = this.resumes.shift();
      if (resume) {
        const slot = this.running.get(resume.taskId);
        if (!slot || slot.held) {
          resume.resolve();
          continue;
        }
        slot.held = true;
        this.active++;
        resume.resolve();
        continue;
      }

      const index = this.nextJobIndex();
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      this.active++;
      this.running.set(job.taskId, { held: true });
      void job.run().finally(() => {
        const slot = this.running.get(job.taskId);
        if (slot?.held) this.active = Math.max(0, this.active - 1);
        this.running.delete(job.taskId);
        this.resumes = this.resumes.filter((waiter) => {
          if (waiter.taskId !== job.taskId) return true;
          waiter.resolve();
          return false;
        });
        this.pump();
      });
    }
  }

  private nextJobIndex(): number {
    let best = -1;
    let bestPriority = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.queue.length; index++) {
      const job = this.queue[index];
      const priority = job.depth > 1 || job.dependency === "required" ? 0 : 1;
      if (priority < bestPriority) {
        best = index;
        bestPriority = priority;
      }
    }
    return best;
  }
}
