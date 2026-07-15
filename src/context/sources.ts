// ContextSource chain — collects context blocks before each turn

import type { ContextSource, ContextBlock, AgentContext } from "../core-types.js";

export class ContextChain {
  private sources: ContextSource[] = [];

  register(source: ContextSource): void {
    // Insert sorted by priority (lower = higher priority)
    const idx = this.sources.findIndex((s) => s.priority > source.priority);
    if (idx === -1) {
      this.sources.push(source);
    } else {
      this.sources.splice(idx, 0, source);
    }
  }

  remove(name: string): void {
    this.sources = this.sources.filter((s) => s.name !== name);
  }

  async fetchAll(query: string, ctx: AgentContext): Promise<ContextBlock[]> {
    const results: ContextBlock[] = [];

    for (const source of this.sources) {
      try {
        const block = await source.fetch(query, ctx);
        if (block) {
          results.push(block);
        }
      } catch (err: unknown) {
        // Log but don't crash — one bad source shouldn't break the chain
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          content: `[Context source "${source.name}" failed: ${message}]`,
          priority: source.priority + 100,
          source: source.name,
        });
      }
    }

    // Sort by priority
    results.sort((a, b) => a.priority - b.priority);
    return results;
  }

  getSources(): ReadonlyArray<ContextSource> {
    return this.sources;
  }
}
