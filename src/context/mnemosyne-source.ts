// Mnemosyne context source — injects relevant memories into the system prompt
// Uses Fusion multi-strategy retrieval (vector + FTS5 + graph, RRF merged)

import type { ContextSource, ContextBlock, AgentContext } from "../core-types.js";
import { getMnemosyneStore } from "../memory/store.js";
import { hybridRetrieve, type FusionResult } from "../memory/fusion.js";

export class MnemosyneSource implements ContextSource {
  readonly name = "mnemosyne";
  readonly priority = 15;

  async fetch(query: string, ctx: AgentContext): Promise<ContextBlock | null> {
    try {
      const store = getMnemosyneStore();

      // Use Fusion multi-strategy hybrid retrieval (replaces manual candidate+search merge)
      const fusionResult = await hybridRetrieve(query, 8);
      const toInject = fusionResult.results.filter((r) => r.score >= 0.3);

      if (toInject.length === 0) return null;

      const lines = ["## 💡 Related Knowledge (Mnemosyne)", ""];

      for (const { entity, score, sources } of toInject.slice(0, 5)) {
        const sourceTag = entity.source === "manual" ? " [📓]" : entity.source === "seeder" ? " [🌱]" : "";
        const strategyHint = sources.length > 1 ? ` (via ${sources.join("+")})` : "";
        const neighborStr = this.formatWithNeighbors(store, entity);
        lines.push(`### ${entity.name} (${entity.type}, score: ${score.toFixed(2)})${strategyHint}${sourceTag}`);
        if (entity.content) lines.push(`> ${entity.content.slice(0, 200)}`);
        if (neighborStr) lines.push(neighborStr);
        lines.push("");
      }

      // Record access for decay reset
      for (const { entity } of toInject.slice(0, 5)) {
        store.recordAccess(entity.id, ctx.sessionId);
        store.recordFeedback(entity.id, ctx.sessionId, "injected", 0, { query, source: "mnemosyne-source" });
      }

      return { content: lines.join("\n"), priority: this.priority, source: this.name };
    } catch {
      return null;
    }
  }

  private formatWithNeighbors(store: ReturnType<typeof getMnemosyneStore>, entity: { id: number }): string {
    const neighbors = store.getNeighbors(entity.id, 0.5);
    if (neighbors.length === 0) return "";
    const related = neighbors.slice(0, 5).map((n) => `  - ${n.relation.relation_type} → ${n.entity.name} (${n.relevance.toFixed(2)})`);
    return `  Related:\n${related.join("\n")}`;
  }
}
