// BudgetManager — minimal resource guard for agent trees
//
// Only three hard limits, all deterministic counters:
//   1. hardDepth — agents at or beyond this depth cannot spawn (default 3)
//   2. maxAgents — total agents created in this session (default 12)
//   3. maxParallel — agents running concurrently (default 4)
//
// No model estimation. No token/tool-call/time budgets. Each agent runs
// as long as it needs; the only recursion guard is depth.

export interface BudgetConfig {
  maxAgents: number;
  maxParallel: number;
  hardDepth: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxAgents: 12,
  maxParallel: 4,
  hardDepth: 3,
};

export interface AllocationResult {
  allowed: boolean;
  reason?: string;
}

export class BudgetManager {
  readonly config: BudgetConfig;

  private _remainingAgents: number;
  private _activeAgents = 0;
  private _totalAgentsCreated = 0;

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET, ...config };
    this._remainingAgents = this.config.maxAgents;
  }

  get remainingAgents(): number { return this._remainingAgents; }
  get activeAgents(): number { return this._activeAgents; }
  get totalAgentsCreated(): number { return this._totalAgentsCreated; }

  /** Try to spawn a new agent at the given depth. O(1) counter checks. */
  tryAllocate(depth: number): AllocationResult {
    if (this._remainingAgents <= 0) {
      return { allowed: false, reason: `Agent limit reached (${this.config.maxAgents} max)` };
    }
    if (this._activeAgents >= this.config.maxParallel) {
      return { allowed: false, reason: `Parallel limit reached (${this.config.maxParallel} max)` };
    }
    if (depth >= this.config.hardDepth) {
      return { allowed: false, reason: `Maximum depth reached (${this.config.hardDepth})` };
    }

    this._remainingAgents--;
    this._activeAgents++;
    this._totalAgentsCreated++;
    return { allowed: true };
  }

  /** Release an agent's slot (call when agent completes or fails). */
  releaseAgent(): void {
    if (this._activeAgents > 0) this._activeAgents--;
  }

  snapshot() {
    return {
      remainingAgents: this._remainingAgents,
      activeAgents: this._activeAgents,
      totalAgentsCreated: this._totalAgentsCreated,
    };
  }
}
