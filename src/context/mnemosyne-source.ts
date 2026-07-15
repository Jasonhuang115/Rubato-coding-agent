// Mnemosyne context source — injects relevant memories into the system prompt
// Searches the knowledge graph for entities related to the current query

import type { ContextSource, ContextBlock, AgentContext } from "../core-types.js";
import { getMnemosyneStore } from "../memory/store.js";

export class MnemosyneSource implements ContextSource {
  readonly name = "mnemosyne";
  readonly priority = 15; // after CLAUDE.md (10), before git-status (20)

  async fetch(query: string, _ctx: AgentContext): Promise<ContextBlock | null> {
    try {
      const store = getMnemosyneStore();
      const results = store.searchWithRelevance(query, 5);

      if (results.length === 0) return null;

      const lines = [
        "## 💡 Related Knowledge (Mnemosyne)",
        "",
      ];

      for (const { entity, relevance } of results) {
        const neighborStr = await this.formatWithNeighbors(store, entity);

        lines.push(`### ${entity.name} (${entity.type}, relevance: ${relevance.toFixed(2)})`);
        if (entity.content) {
          lines.push(`> ${entity.content.slice(0, 200)}`);
        }
        if (neighborStr) {
          lines.push(neighborStr);
        }
        lines.push("");
      }

      // Record access (resets decay)
      for (const { entity } of results) {
        store.recordAccess(entity.id, "context_injection");
      }

      return {
        content: lines.join("\n"),
        priority: this.priority,
        source: this.name,
      };
    } catch {
      // Memory store may not be initialized — graceful degradation
      return null;
    }
  }

  private formatWithNeighbors(store: ReturnType<typeof getMnemosyneStore>, entity: { id: number }): string {
    const neighbors = store.getNeighbors(entity.id, 0.5);
    if (neighbors.length === 0) return "";

    const related = neighbors
      .slice(0, 5)
      .map(
        (n) =>
          `  - ${n.relation.relation_type} → ${n.entity.name} (${n.relevance.toFixed(2)})`
      );

    return `  Related:\n${related.join("\n")}`;
  }
}
