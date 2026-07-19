// Context Scheduler — token-aware context provider management.
// Replaces the simple ContextChain with budget-aware scheduling.
// Collects → Sorts by priority → Allocates budget → Compresses/Drops → Returns.

import type { ContextSource, ContextBlock, AgentContext } from "../shared/core-types.js";
import { PromptBudgetManager } from "../prompt/budget.js";

// ---- Scheduler configuration ----

const DEFAULT_BUDGET = 3000; // tokens for injected context (not including static prompt)

// ---- Scheduler ----

export class ContextScheduler {
  private sources: ContextSource[] = [];
  private budgetManager: PromptBudgetManager;

  constructor(budgetTokens = DEFAULT_BUDGET) {
    this.budgetManager = new PromptBudgetManager(budgetTokens);
  }

  /**
   * Register a context source (sorted by priority).
   */
  register(source: ContextSource): void {
    const idx = this.sources.findIndex((s) => s.priority > source.priority);
    if (idx === -1) {
      this.sources.push(source);
    } else {
      this.sources.splice(idx, 0, source);
    }
  }

  /**
   * Remove a source by name.
   */
  remove(name: string): void {
    this.sources = this.sources.filter((s) => s.name !== name);
  }

  /**
   * Fetch all sources with budget-aware allocation.
   *
   * Flow:
   * 1. Collect all providers (fetch in parallel)
   * 2. Sort by priority (lowest = highest priority)
   * 3. Allocate budget: high priority full, medium compressed, low dropped
   * 4. Return final blocks
   */
  async fetchAll(
    query: string,
    ctx: AgentContext,
    budgetTokens?: number,
  ): Promise<ContextBlock[]> {
    if (budgetTokens) {
      this.budgetManager.setBudget(budgetTokens);
    }

    // 1. Collect from all sources (parallel with error isolation)
    type ProviderResult = { source: ContextSource; block: ContextBlock | null };
    const results: ProviderResult[] = await Promise.all(
      this.sources.map(async (source): Promise<ProviderResult> => {
        try {
          const block = await source.fetch(query, ctx);
          return { source, block };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            source,
            block: {
              content: `[Context source "${source.name}" failed: ${message}]`,
              priority: source.priority + 100, // demote errors
              source: source.name,
            },
          };
        }
      }),
    );

    // 2. Build provider list for budget allocation
    const providers = results
      .filter((r): r is { source: ContextSource; block: ContextBlock } => r.block !== null)
      .filter((r) => r.source.priority < 200); // skip very low priority

    // 3. Budget-aware allocation
    const allocation = await this.budgetManager.allocate(providers);

    // 4. Sort by priority for final output
    allocation.blocks.sort((a, b) => a.priority - b.priority);

    return allocation.blocks;
  }

  /**
   * Get registered sources (read-only).
   */
  getSources(): ReadonlyArray<ContextSource> {
    return this.sources;
  }

  /**
   * Get current budget.
   */
  getBudget(): number {
    return this.budgetManager.getBudget();
  }

  /**
   * Set a new budget.
   */
  setBudget(tokens: number): void {
    this.budgetManager.setBudget(tokens);
  }
}
