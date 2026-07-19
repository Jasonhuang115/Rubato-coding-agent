// Prompt Budget Manager — token allocation across context providers.
// Ensures the system prompt + injected context doesn't exceed model limits.
// When over budget, low-priority providers are compressed or dropped.

import type { ContextBlock, ContextSource, AgentContext } from "../shared/core-types.js";

// ---- Types ----

export interface BudgetAllocation {
  source: string;
  priority: number;
  maxTokens: number;
}

export interface BudgetResult {
  blocks: ContextBlock[];
  allocations: BudgetAllocation[];
  totalTokens: number;
  budget: number;
  overBudget: boolean;
}

// ---- BudgetManager ----

export class PromptBudgetManager {
  private budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  /**
   * Allocate token budget to context providers and collect their output.
   * High-priority sources get full allocation; low-priority are compressed/dropped.
   */
  async allocate(
    providers: Array<{ source: ContextSource; block: ContextBlock }>,
  ): Promise<BudgetResult> {
    let remaining = this.budget;
    const allocations: BudgetAllocation[] = [];
    const blocks: ContextBlock[] = [];

    // Sort by priority (lowest = highest priority)
    const sorted = [...providers].sort((a, b) => a.source.priority - b.source.priority);

    // Phase 1: Allocate to high-priority providers (priority < 50)
    for (const { source, block } of sorted) {
      if (source.priority >= 50) continue;

      const tokens = estimateTokens(block.content);
      allocations.push({ source: source.name, priority: source.priority, maxTokens: tokens });
      remaining -= tokens;
      blocks.push(block);
    }

    // Phase 2: Allocate remaining to medium/low priority
    for (const { source, block } of sorted) {
      if (source.priority < 50) continue;

      if (remaining <= 0) break;

      const tokens = estimateTokens(block.content);

      if (remaining >= tokens) {
        // Full allocation
        allocations.push({ source: source.name, priority: source.priority, maxTokens: tokens });
        remaining -= tokens;
        blocks.push(block);
      } else if (remaining >= 100) {
        // Partial: compress the block
        const compressed = compressBlock(block, remaining);
        allocations.push({ source: source.name, priority: source.priority, maxTokens: remaining });
        remaining = 0;
        blocks.push(compressed);
      }
      // else: too little budget — drop
    }

    return {
      blocks,
      allocations,
      totalTokens: this.budget - Math.max(0, remaining),
      budget: this.budget,
      overBudget: remaining < 0,
    };
  }

  /**
   * Set a new budget.
   */
  setBudget(newBudget: number): void {
    this.budget = newBudget;
  }

  /**
   * Get remaining budget after allocation.
   */
  getBudget(): number {
    return this.budget;
  }
}

// ---- Helpers ----

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function compressBlock(block: ContextBlock, targetTokens: number): ContextBlock {
  const targetChars = targetTokens * 3;
  let content = block.content;

  if (content.length <= targetChars) return block;

  // Keep head 60% + tail 20% + truncation marker
  const headSize = Math.floor(targetChars * 0.6);
  const tailSize = Math.floor(targetChars * 0.2);

  const head = content.slice(0, headSize);
  const tail = content.slice(-tailSize);

  return {
    content: `${head}\n\n[...truncated for budget...]\n\n${tail}`,
    priority: block.priority,
    source: block.source,
  };
}
