// Evaluator — multi-dimensional memory scoring engine
// 5 dimensions: accuracy, freshness, relevance, conflict, frequency

import { getMnemosyneStore } from "./store.js";
import type { MnemosyneStore, EntityRow } from "./store.js";

export interface MemoryScore {
  total: number;
  dimensions: { accuracy: number; freshness: number; relevance: number; conflict: number; frequency: number };
}

export interface ScoreReport {
  entityId: number; entityName: string;
  score: MemoryScore;
  recommendation: "inject" | "hold" | "forget" | "upgrade";
}

export const THRESHOLDS = {
  inject: 0.55,
  forget: 0.15,
  upgrade: 0.85,
  upgradeMinAccesses: 10,
};

export function evaluateMemory(entityId: number, store?: MnemosyneStore): ScoreReport | null {
  const s = store ?? getMnemosyneStore();
  const entity = s.getEntity(entityId);
  if (!entity) return null;

  const feedback = s.getFeedbackStats(entityId);
  const now = Date.now();

  const accuracy = computeAccuracy(feedback);
  const freshness = computeFreshness(entity, now);
  const relevance = computeRelevance(entityId, s);
  const conflict = computeConflict(entity, s);
  const frequency = computeFrequency(feedback);

  const weights = { accuracy: 0.30, freshness: 0.20, relevance: 0.20, conflict: 0.15, frequency: 0.15 };
  const total = clamp(
    accuracy * weights.accuracy + freshness * weights.freshness +
    relevance * weights.relevance + conflict * weights.conflict + frequency * weights.frequency
  );

  const score: MemoryScore = { total, dimensions: { accuracy, freshness, relevance, conflict, frequency } };

  let recommendation: ScoreReport["recommendation"] = "hold";
  if (total >= THRESHOLDS.upgrade && feedback.injections >= THRESHOLDS.upgradeMinAccesses) recommendation = "upgrade";
  else if (total >= THRESHOLDS.inject) recommendation = "inject";
  else if (total < THRESHOLDS.forget && entity.protected === 0) recommendation = "forget";

  return { entityId: entity.id, entityName: entity.name, score, recommendation };
}

export function evaluateAll(limit = 200, store?: MnemosyneStore): ScoreReport[] {
  const s = store ?? getMnemosyneStore();
  return s.getAllEntityIds(limit)
    .map((row) => evaluateMemory(row.id, s))
    .filter((r): r is ScoreReport => r !== null)
    .sort((a, b) => b.score.total - a.score.total);
}

export function getInjectCandidates(query?: string, limit = 10, store?: MnemosyneStore): ScoreReport[] {
  const all = evaluateAll(100, store);
  const candidates = all.filter((r) => r.recommendation === "inject" || r.recommendation === "upgrade");
  if (query) {
    const lower = query.toLowerCase();
    candidates.sort((a, b) => {
      const aMatch = a.entityName.toLowerCase().includes(lower) ? 0.2 : 0;
      const bMatch = b.entityName.toLowerCase().includes(lower) ? 0.2 : 0;
      return (b.score.total + bMatch) - (a.score.total + aMatch);
    });
  }
  return candidates.slice(0, limit);
}

export function getForgetCandidates(limit = 20, store?: MnemosyneStore): ScoreReport[] {
  return evaluateAll(100, store).filter((r) => r.recommendation === "forget").slice(0, limit);
}

// ---- Dimension computations ----

function computeAccuracy(feedback: { injections: number; successes: number; failures: number }): number {
  const total = feedback.successes + feedback.failures;
  if (total === 0) return 0.5;
  return (feedback.successes + 1) / (total + 2);
}

function computeFreshness(entity: EntityRow, now: number): number {
  const ageDays = (now - entity.updated_at) / (1000 * 60 * 60 * 24);
  return clamp(Math.exp(-0.0231 * ageDays));
}

function computeRelevance(entityId: number, s: MnemosyneStore): number {
  const totalAccesses = s.getAccessCount(entityId);
  return clamp(1 / (1 + Math.exp(-0.15 * (totalAccesses - 5))));
}

function computeConflict(entity: EntityRow, s: MnemosyneStore): number {
  const relations = s.getRelations(entity.id);
  const conflictCount = relations.filter((r) => r.relation_type === "REPLACES" || r.relation_type === "ALTERNATIVE_TO").length;
  return clamp(1.0 - conflictCount * 0.2);
}

function computeFrequency(feedback: { injections: number; successes: number; failures: number }): number {
  return clamp(1 / (1 + Math.exp(-0.15 * (feedback.injections - 5))));
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
