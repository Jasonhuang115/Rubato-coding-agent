// Fusion — multi-strategy hybrid retrieval
// 3-path: vector + FTS5 + graph traversal, merged via Reciprocal Rank Fusion

import { getMnemosyneStore } from "./store.js";
import type { EntityRow } from "./store.js";
import { rewriteQuery, learnFromRetrieval } from "./rewriter.js";

export interface FusionResult {
  entity: EntityRow; score: number; sources: string[];
  rankContributions: { vector?: { rank: number; score: number }; fts5?: { rank: number; score: number }; graph?: { rank: number; score: number } };
}

export interface FusionSearchResult {
  results: FusionResult[]; query: string; variantsUsed: string[];
  strategyWeights: Record<string, number>;
  timing: { vectorMs: number; fts5Ms: number; graphMs: number; totalMs: number };
}

const RRF_K = 60;

export async function hybridRetrieve(query: string, limit = 10): Promise<FusionSearchResult> {
  const store = getMnemosyneStore();
  const startTime = Date.now();
  const timing = { vectorMs: 0, graphMs: 0, fts5Ms: 0, totalMs: 0 };

  const weights = store.getStrategyWeights();
  const weightMap: Record<string, number> = {};
  for (const w of weights) weightMap[w.strategy] = w.weight;
  const wFts5 = weightMap["fts5"] ?? 0.5;
  const wVector = weightMap["vector"] ?? 0.3;
  const wGraph = weightMap["graph"] ?? 0.2;

  const rewriteResult = rewriteQuery(query);
  const allQueries = rewriteResult.variants;

  // 1. FTS5
  const fts5Start = Date.now();
  const fts5Results = new Map<number, { entity: EntityRow; rank: number }>();
  for (const q of allQueries) {
    const results = store.searchEntities(q, limit * 2);
    for (let i = 0; i < results.length; i++)
      if (!fts5Results.has(results[i].id) || fts5Results.get(results[i].id)!.rank > i)
        fts5Results.set(results[i].id, { entity: results[i], rank: i + 1 });
  }
  timing.fts5Ms = Date.now() - fts5Start;

  // 2. Vector
  const vectorStart = Date.now();
  const vectorResults = new Map<number, { entity: EntityRow; rank: number; score: number }>();
  try {
    const { generate } = await import("../embedding/generate.js");
    const embedding = await generate(query);
    if (embedding) {
      const { searchByVector } = await import("./vector-search.js");
      const vecResults = await searchByVector(store, embedding, limit * 2);
      for (let i = 0; i < vecResults.length; i++)
        vectorResults.set(vecResults[i].entity.id, { entity: vecResults[i].entity, rank: i + 1, score: vecResults[i].similarity });
    }
  } catch { /* vector not available */ }
  timing.vectorMs = Date.now() - vectorStart;

  // 3. Graph: expand FTS5 top-5 via 1-hop
  const graphStart = Date.now();
  const graphResults = new Map<number, { entity: EntityRow; rank: number }>();
  const fts5Top = [...fts5Results.values()].sort((a, b) => a.rank - b.rank).slice(0, 5);
  const seenGraph = new Set<number>();
  for (const { entity } of fts5Top) {
    seenGraph.add(entity.id);
    const neighbors = store.getNeighbors(entity.id, 0.3);
    for (let i = 0; i < neighbors.length; i++)
      if (!seenGraph.has(neighbors[i].entity.id)) {
        seenGraph.add(neighbors[i].entity.id);
        graphResults.set(neighbors[i].entity.id, { entity: neighbors[i].entity, rank: i + 1 });
      }
  }
  timing.graphMs = Date.now() - graphStart;

  // 4. RRF merge
  const allEntityIds = new Set<number>();
  for (const id of fts5Results.keys()) allEntityIds.add(id);
  for (const id of vectorResults.keys()) allEntityIds.add(id);
  for (const id of graphResults.keys()) allEntityIds.add(id);

  const fused: FusionResult[] = [];
  for (const entityId of allEntityIds) {
    let rrfScore = 0;
    const sources: string[] = [];
    const rankContributions: FusionResult["rankContributions"] = {};

    const fts5Hit = fts5Results.get(entityId);
    if (fts5Hit) { const s = wFts5 / (RRF_K + fts5Hit.rank); rrfScore += s; sources.push("fts5"); rankContributions.fts5 = { rank: fts5Hit.rank, score: s }; }

    const vecHit = vectorResults.get(entityId);
    if (vecHit) { const s = wVector / (RRF_K + vecHit.rank); rrfScore += s; sources.push("vector"); rankContributions.vector = { rank: vecHit.rank, score: s }; }

    const graphHit = graphResults.get(entityId);
    if (graphHit) { const s = wGraph / (RRF_K + graphHit.rank); rrfScore += s; sources.push("graph"); rankContributions.graph = { rank: graphHit.rank, score: s }; }

    // Skip inactive entities (superseded/deprecated)
    const entity = fts5Hit?.entity ?? vecHit?.entity ?? graphHit!.entity;
    if (entity && entity.status !== "superseded" && entity.status !== "deprecated") {
      fused.push({ entity, score: rrfScore, sources, rankContributions });
    }
  }

  fused.sort((a, b) => b.score - a.score);
  timing.totalMs = Date.now() - startTime;

  // Auto-tune strategy weights every 100 queries
  if (Math.random() < 0.01) {
    const store = getMnemosyneStore();
    store.autoTuneStrategyWeights();
  }

  return { results: fused.slice(0, limit), query, variantsUsed: allQueries, strategyWeights: weightMap, timing };
}

export async function hybridSearch(query: string, limit = 10): Promise<EntityRow[]> {
  return (await hybridRetrieve(query, limit)).results.map((r) => r.entity);
}

export function recordRetrievalFeedback(query: string, retrievedIds: number[], wasHelpful: boolean): void {
  learnFromRetrieval(query, retrievedIds, wasHelpful);
}
