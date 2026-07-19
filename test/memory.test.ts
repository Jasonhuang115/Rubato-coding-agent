// Memory system tests — Mnemosyne store, evaluator, seeder, embedding
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { MnemosyneStore, closeMnemosyneStore, setMnemosyneStore } from "../src/memory/store.js";
import { evaluateMemory, evaluateAll, getInjectCandidates, THRESHOLDS } from "../src/memory/evaluator.js";
import { rewriteQuery, learnQueryRewrite } from "../src/memory/rewriter.js";
import { shouldConsolidate, consolidateMemories, parseConsolidationJson } from "../src/memory/consolidator.js";
import { generateSimpleEmbedding, cosineSimilarity } from "../src/memory/embedding/setup.js";

const TEST_DB = "/tmp/test-mnemosyne.db";

function freshStore(): MnemosyneStore {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  // Force new singleton by closing old one
  try { closeMnemosyneStore(); } catch {}
  const store = new MnemosyneStore(TEST_DB);
  setMnemosyneStore(store);
  return store;
}

// ---- Store CRUD ----

describe("MnemosyneStore CRUD", () => {
  let store: MnemosyneStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("upserts and retrieves entities", () => {
    const id = store.upsertEntity("test-entity", "concept", "A test concept", "test-session", 0.8);
    expect(id).toBeGreaterThan(0);

    const entity = store.getEntity(id);
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe("test-entity");
    expect(entity!.type).toBe("concept");
    expect(entity!.confidence).toBe(0.8);
    expect(entity!.source).toBe("auto");
    expect(entity!.protected).toBe(0);
  });

  it("upsert merges existing entity", () => {
    const id1 = store.upsertEntity("merge-test", "concept", "First content", "s1", 0.5);
    const id2 = store.upsertEntity("merge-test", "concept", "Second content", "s2", 0.5);
    expect(id1).toBe(id2);

    const entity = store.getEntity(id1);
    expect(entity!.content).toContain("First");
    expect(entity!.content).toContain("Second");
    expect(entity!.confidence).toBeGreaterThan(0.5);
  });

  it("findEntityByName works", () => {
    store.upsertEntity("find-me", "error", "An error", "s1");
    const found = store.findEntityByName("find-me", "error");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("find-me");

    const notFound = store.findEntityByName("nope");
    expect(notFound).toBeNull();
  });

  it("getByType filters correctly", () => {
    store.upsertEntity("e1", "concept", "c1", "s1");
    store.upsertEntity("e2", "error", "c2", "s1");
    store.upsertEntity("e3", "concept", "c3", "s1");

    const concepts = store.getByType("concept");
    expect(concepts.length).toBe(2);
  });
});

// ---- Manual Memories ----

describe("Manual Memories", () => {
  let store: MnemosyneStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("addManualMemory sets source='manual' and protected=1", () => {
    const id = store.addManualMemory("Postgres tip", "Use connection pooling", ["postgres", "performance"], "user-session", "note");
    expect(id).toBeGreaterThan(0);

    const entity = store.getEntity(id);
    expect(entity!.source).toBe("manual");
    expect(entity!.protected).toBe(1);
    expect(entity!.tags).toContain("postgres");
  });

  it("getManualMemories filters correctly", () => {
    store.addManualMemory("Manual 1", "content", [], "s1", "note");
    store.addManualMemory("Manual 2", "content", [], "s1", "note");
    store.upsertEntity("Auto entity", "concept", "auto content", "s1");

    const manuals = store.getManualMemories();
    expect(manuals.length).toBe(2);
    manuals.forEach((m) => expect(m.source).toMatch(/manual|memories_md/));
  });

  it("protected memories survive pruning", () => {
    store.addManualMemory("Protected", "important", [], "s1", "note");

    // Make it very old
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare("UPDATE entities SET updated_at = ? WHERE name = ?").run(0, "Protected");

    const deleted = store.pruneForgotten(1); // 1 day
    expect(deleted).toBe(0); // protected memory should survive

    const entity = store.findEntityByName("Protected");
    expect(entity).not.toBeNull();
  });

  it("unprotected old memories become dormant instead of being deleted", () => {
    store.upsertEntity("Old entity", "concept", "will be archived", "s1", 0.5, "auto", 0);

    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare("UPDATE entities SET updated_at = ? WHERE name = ?").run(0, "Old entity");

    const archived = store.pruneForgotten(1);
    expect(archived).toBe(1);
    expect(store.findEntityByName("Old entity")).toMatchObject({ status: "dormant" });
    expect(store.searchEntities("archived", 10).map((entity) => entity.name)).toContain("Old entity");
    expect(store.searchEntities("archived", 10, { statuses: ["active"] })).toHaveLength(0);
  });
});

// ---- FTS5 Search ----

describe("FTS5 Search", () => {
  let store: MnemosyneStore;

  beforeEach(() => {
    store = freshStore();
    store.upsertEntity("PostgreSQL connection pool", "config", "Use PgBouncer for connection pooling", "s1");
    store.upsertEntity("React hooks", "concept", "useEffect runs after render", "s1");
    store.upsertEntity("TypeScript generics", "concept", "Generic types in TypeScript", "s1");
  });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("searchEntities finds relevant results", () => {
    const results = store.searchEntities("PostgreSQL", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toContain("PostgreSQL");
  });

  it("searchEntities returns empty for no match", () => {
    const results = store.searchEntities("zzz_nonexistent_zzz", 5);
    expect(results.length).toBe(0);
  });

  it("searchWithRelevance includes scores", () => {
    const results = store.searchWithRelevance("TypeScript", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].relevance).toBeGreaterThan(0);
    expect(results[0].relevance).toBeLessThanOrEqual(1);
  });
});

// ---- Relations & Graph ----

describe("Relations & Graph Traversal", () => {
  let store: MnemosyneStore;

  beforeEach(() => {
    store = freshStore();
    const a = store.upsertEntity("Node A", "concept", "A", "s1");
    const b = store.upsertEntity("Node B", "concept", "B", "s1");
    const c = store.upsertEntity("Node C", "concept", "C", "s1");
    store.addRelation(a, b, "RELATED_TO", 0.8);
    store.addRelation(b, c, "DEPENDS_ON", 0.6);
    store.recordAccess(a, "s1");
    store.recordAccess(b, "s1");
  });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("addRelation avoids duplicates", () => {
    const a = store.findEntityByName("Node A")!.id;
    const b = store.findEntityByName("Node B")!.id;
    const r1 = store.addRelation(a, b, "RELATED_TO", 0.5);
    const r2 = store.addRelation(a, b, "RELATED_TO", 0.5);
    expect(r1).toBe(r2);
  });

  it("getNeighbors finds connected entities", () => {
    const a = store.findEntityByName("Node A")!.id;
    const neighbors = store.getNeighbors(a);
    expect(neighbors.length).toBe(1);
    expect(neighbors[0].entity.name).toBe("Node B");
  });

  it("traverseGraph does multi-hop", () => {
    const a = store.findEntityByName("Node A")!.id;
    const results = store.traverseGraph([a], 2);
    // Should find B (1 hop) and C (2 hops)
    expect(results.length).toBeGreaterThanOrEqual(1);
    const names = results.map((r) => r.entity.name);
    expect(names).toContain("Node B");
  });

  it("getAccessCount tracks accesses", () => {
    const a = store.findEntityByName("Node A")!.id;
    store.recordAccess(a, "s2");
    const count = store.getAccessCount(a);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// ---- Feedback Log ----

describe("Feedback Log", () => {
  let store: MnemosyneStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("recordFeedback and getFeedbackStats", () => {
    const id = store.upsertEntity("Test", "concept", "test", "s1");
    store.recordFeedback(id, "s1", "injected");
    store.recordFeedback(id, "s1", "tool_success", 0.05);
    store.recordFeedback(id, "s1", "tool_failed", -0.03);

    const stats = store.getFeedbackStats(id);
    expect(stats.injections).toBe(1);
    expect(stats.successes).toBe(1);
    expect(stats.failures).toBe(1);
  });

  it("records real event types and preserves retrieval sources for ignored memories", () => {
    const id = store.upsertEntity("Pool config", "config", "Use PgBouncer", "s1");
    store.recordFeedbackSignal(id, "feedback-session", "injected", "fts5,vector", { query: "database pool" });

    const injected = store.getInjectedMemoriesForSession("feedback-session");
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({ retrievalSource: "fts5,vector", query: "database pool" });

    store.markIgnoredForSession("feedback-session");
    store.markIgnoredForSession("feedback-session");

    const signals = store.getFeedbackSignalsForSession("feedback-session");
    expect(signals.map((signal) => signal.eventType)).toEqual(["injected", "ignored"]);
    expect(signals[1].retrievalSource).toBe("fts5,vector");
  });

  it("records referenced feedback idempotently", () => {
    const id = store.upsertEntity("Abort handling", "concept", "Use AbortController", "s1");
    store.recordFeedbackSignal(id, "reference-session", "injected", "graph");
    store.markReferenced(id, "reference-session", "graph", { confidence: 0.9 });
    store.markReferenced(id, "reference-session", "graph", { confidence: 0.9 });
    store.markIgnoredForSession("reference-session");

    const signals = store.getFeedbackSignalsForSession("reference-session");
    expect(signals.map((signal) => signal.eventType)).toEqual(["injected", "referenced"]);
    expect(signals[1].context).toEqual({ confidence: 0.9 });
  });
});

// ---- Strategy Weights ----

describe("Strategy Weights", () => {
  let store: MnemosyneStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("default weights are initialized", () => {
    const weights = store.getStrategyWeights();
    expect(weights.length).toBe(3);
    const strategies = weights.map((w) => w.strategy).sort();
    expect(strategies).toEqual(["fts5", "graph", "vector"]);
  });

  it("updateStrategyWeight adjusts weights", () => {
    store.updateStrategyWeight("fts5", true);
    store.updateStrategyWeight("fts5", true);
    store.updateStrategyWeight("fts5", false);

    const weights = store.getStrategyWeights();
    const fts5 = weights.find((w) => w.strategy === "fts5")!;
    expect(fts5.totalCalls).toBe(3);
    expect(fts5.successRate).toBeCloseTo(2 / 3, 1);
  });

  it("auto-tunes per source from session-memory samples without double counting", () => {
    for (let i = 0; i < 6; i++) {
      const id = store.upsertEntity(`memory-${i}`, "concept", `content-${i}`, `s${i}`);
      store.recordFeedbackSignal(id, `tune-${i}`, "injected", "fts5,vector");
      if (i < 3) store.markReferenced(id, `tune-${i}`, "fts5,vector");
      else store.markIgnoredForSession(`tune-${i}`);
    }

    store.autoTuneStrategyWeights();
    const first = store.getStrategyWeights();
    store.autoTuneStrategyWeights();
    const second = store.getStrategyWeights();

    for (const strategy of ["fts5", "vector"]) {
      const firstRow = first.find((row) => row.strategy === strategy)!;
      const secondRow = second.find((row) => row.strategy === strategy)!;
      expect(firstRow.totalCalls).toBe(6);
      expect(firstRow.successRate).toBeCloseTo(0.5, 5);
      expect(secondRow.totalCalls).toBe(6);
      expect(secondRow.weight).toBeCloseTo(firstRow.weight, 12);
    }
    expect(second.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(1, 8);
    expect(second.every((row) => row.weight >= 0.1)).toBe(true);
  });

  it("repairs legacy strategy weights below the safety floor", () => {
    const db = (store as unknown as {
      db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
    }).db;
    db.prepare("UPDATE strategy_weights SET weight = CASE strategy WHEN 'fts5' THEN 0 WHEN 'vector' THEN 0.7 ELSE 0.3 END").run();

    store.autoTuneStrategyWeights();

    const weights = store.getStrategyWeights();
    expect(weights.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(1, 8);
    expect(weights.every((row) => row.weight >= 0.1)).toBe(true);
  });
});

// ---- Query Rewrite Rules ----

describe("Query Rewrite Rules", () => {
  let store: MnemosyneStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("addQueryRewriteRule and getQueryRewrites", () => {
    store.addQueryRewriteRule("slow db", "PostgreSQL connection timeout");
    store.addQueryRewriteRule("slow db", "PostgreSQL connection timeout");

    const rewrites = store.getQueryRewrites("slow db");
    expect(rewrites.length).toBe(1);
    expect(rewrites[0]).toBe("PostgreSQL connection timeout");
  });
});

// ---- Stats ----

describe("Stats", () => {
  let store: MnemosyneStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("getStats returns counts", () => {
    store.upsertEntity("e1", "concept", "c1", "s1");
    store.upsertEntity("e2", "concept", "c2", "s1");
    store.addManualMemory("manual", "content", [], "s1", "note");

    const stats = store.getStats();
    expect(stats.entities).toBe(3);
    expect(stats.manualMemories).toBe(1);
  });
});

// ---- Evaluator ----

describe("Evaluator", () => {
  let store: MnemosyneStore;

  beforeEach(() => {
    store = freshStore();
    store.upsertEntity("High quality", "concept", "Important knowledge", "s1", 0.9, "auto", 0);
  });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("evaluateMemory returns a score report", () => {
    const entity = store.findEntityByName("High quality")!;
    const report = evaluateMemory(entity.id, store);

    expect(report).not.toBeNull();
    expect(report!.score.total).toBeGreaterThan(0);
    expect(report!.score.total).toBeLessThanOrEqual(1);
    expect(report!.score.dimensions.accuracy).toBeDefined();
    expect(report!.score.dimensions.freshness).toBeDefined();
    expect(report!.score.dimensions.relevance).toBeDefined();
    expect(report!.score.dimensions.conflict).toBeDefined();
    expect(report!.score.dimensions.frequency).toBeDefined();
  });

  it("fresh memory scores high on freshness", () => {
    const id = store.upsertEntity("Fresh", "concept", "Just created", "s1");
    const report = evaluateMemory(id, store);
    expect(report!.score.dimensions.freshness).toBeGreaterThan(0.9);
  });

  it("old memory without access scores low", () => {
    const id = store.upsertEntity("Stale", "concept", "Very old", "s1");

    // Artificially age the entity
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    const oldTime = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
    db.prepare("UPDATE entities SET updated_at = ? WHERE id = ?").run(oldTime, id);

    const report = evaluateMemory(id, store);
    expect(report!.score.dimensions.freshness).toBeLessThan(0.3);
    expect(report!.decisions.shouldDormant).toBe(true);
    expect(report!.recommendation).toBe("dormant");
  });

  it("never demotes protected memories", () => {
    const id = store.addManualMemory("Keep this", "A long-lived personal rule", [], "s1", "note");
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare("UPDATE entities SET updated_at = ? WHERE id = ?").run(Date.now() - 180 * 24 * 60 * 60 * 1000, id);

    const report = evaluateMemory(id, store);
    expect(report!.decisions.shouldDormant).toBe(false);
    expect(report!.decisions.shouldDeleteNoise).toBe(false);
  });

  it("only flags obvious low-confidence auto memories as deleteable noise", () => {
    const id = store.upsertEntity("Transient note", "note", "todo", "s1", 0.2, "auto", 0);
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare("UPDATE entities SET updated_at = ? WHERE id = ?").run(Date.now() - 180 * 24 * 60 * 60 * 1000, id);

    const report = evaluateMemory(id, store);
    expect(report!.decisions.shouldDormant).toBe(true);
    expect(report!.decisions.shouldDeleteNoise).toBe(true);
    expect(report!.recommendation).toBe("delete_noise");
  });

  it("getInjectCandidates filters by threshold", () => {
    // Create entity with feedback to push score above inject threshold
    const id = store.upsertEntity("Injectable", "concept", "Should be injected", "s1", 0.9, "auto", 0);
    // Give it lots of positive feedback
    for (let i = 0; i < 10; i++) {
      store.recordAccess(id, "s1");
      store.recordFeedback(id, "s1", "injected");
      store.recordFeedback(id, "s1", "tool_success", 0.1);
    }

    const candidates = getInjectCandidates("Injectable", 10, store);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0].recommendation).toMatch(/inject|upgrade/);
  });
});

// ---- Query Rewriter ----

describe("Query Rewriter", () => {
  let store: MnemosyneStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("rewriteQuery returns variants", () => {
    const result = rewriteQuery("how do I fix the database error");
    expect(result.variants.length).toBeGreaterThanOrEqual(1);
    expect(result.variants[0]).toBe("how do I fix the database error"); // original first
  });

  it("rewriteQuery strips filler words", () => {
    const result = rewriteQuery("how do I configure the API");
    expect(result.variants).toContain("configure the API");
  });

  it("learnQueryRewrite creates a rule", () => {
    const id = store.upsertEntity("PostgreSQL pool", "config", "PgBouncer setup", "s1");
    learnQueryRewrite("database timeout", [id], store);

    const rewrites = store.getQueryRewrites("database timeout");
    expect(rewrites.length).toBeGreaterThan(0);
  });
});

// ---- Embedding ----

describe("Embedding", () => {
  it("generateSimpleEmbedding produces 384-dim normalized vector", () => {
    const vec = generateSimpleEmbedding("test query");
    expect(vec.length).toBe(384);

    // Should be L2 normalized
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  });

  it("similar queries have higher cosine similarity", () => {
    const vec1 = generateSimpleEmbedding("PostgreSQL connection pool configuration");
    const vec2 = generateSimpleEmbedding("database connection pooling setup");
    const vec3 = generateSimpleEmbedding("React component rendering lifecycle");

    const sim12 = cosineSimilarity(vec1, vec2);
    const sim13 = cosineSimilarity(vec1, vec3);

    // Similar queries should be closer
    expect(sim12).toBeGreaterThan(sim13);
  });

  it("identical texts have similarity 1", () => {
    const vec = generateSimpleEmbedding("test");
    const sim = cosineSimilarity(vec, vec);
    expect(sim).toBeCloseTo(1.0, 2);
  });
});

// ---- Consolidator ----

describe("Consolidator", () => {
  let store: MnemosyneStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { closeMnemosyneStore(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("shouldConsolidate returns false initially (not enough sessions)", () => {
    // In a fresh store with few entities, should NOT consolidate
    expect(shouldConsolidate()).toBe(false);
  });

  it("consolidateMemories runs without errors", async () => {
    // Add some memories
    store.upsertEntity("Similar 1", "concept", "content about databases and SQL", "s1");
    store.upsertEntity("Similar 2", "concept", "more content about databases", "s1");
    store.upsertEntity("Similar 3", "concept", "database related content again", "s1");
    store.upsertEntity("Different", "error", "completely different topic", "s1");

    const result = await consolidateMemories();
    expect(result.errors.length).toBe(0);
    // Should not crash
  });

  it("parses LLM consolidation JSON conservatively", () => {
    const parsed = parseConsolidationJson(`\`\`\`json
{"action":"create_principle","name":"rubato-memory","type":"concept","summary":"Rubato should keep personal project preferences as stable reusable memory.","scope":"Use in Rubato memory work.","confidence":0.82,"validity":"Review when memory storage changes.","conflicts":[]}
\`\`\``, "note");

    expect(parsed?.name).toBe("rubato-memory");
    expect(parsed?.type).toBe("concept");
    expect(parsed?.confidence).toBe(0.82);
  });

  it("uses LLM summarizer to create traceable semantic memory", async () => {
    store.upsertEntity("rubato/memory/preference/a", "concept", "Rubato should keep long-term user preferences recoverable instead of deleting old preferences.", "s1", 0.8, "auto", 0);
    store.upsertEntity("rubato/memory/preference/b", "concept", "Rubato memory lifecycle should prefer dormant archival for stale personal preferences.", "s1", 0.8, "auto", 0);
    store.upsertEntity("rubato/memory/preference/c", "concept", "Personal preference memories should be recoverable through explicit recall even when not injected by default.", "s1", 0.8, "auto", 0);

    const result = await consolidateMemories({
      summarizer: async () => ({
        action: "create_principle",
        name: "rubato-memory-lifecycle",
        type: "concept",
        summary: "Rubato should preserve personal memory as recoverable dormant knowledge before considering deletion.",
        scope: "Use when changing Mnemosyne lifecycle, retrieval, or pruning behavior.",
        confidence: 0.86,
        validity: "Review if memory volume or storage backend changes.",
        conflicts: [],
      }),
    });

    const principle = store.findEntityByName("principle/rubato-memory-lifecycle", "concept");
    expect(result.abstracted).toBeGreaterThan(0);
    expect(principle?.content).toContain("Scope: Use when changing Mnemosyne lifecycle");
    expect(principle?.abstracted_from.split(",").length).toBe(3);
    expect(store.getRelations(principle!.id, "RELATED_TO").length).toBe(3);

    const dormant = ["rubato/memory/preference/a", "rubato/memory/preference/b", "rubato/memory/preference/c"]
      .map((name) => store.findEntityByName(name, "concept")?.status);
    expect(dormant).toEqual(["dormant", "dormant", "dormant"]);
  });
});

// ---- getAllEntityIds & setEmbedding ----

describe("Entity IDs & Embeddings", () => {
  let store: MnemosyneStore;

  beforeEach(() => { store = freshStore(); });
  afterEach(() => { store.close(); try { fs.unlinkSync(TEST_DB); } catch {} });

  it("getAllEntityIds returns all IDs", () => {
    store.upsertEntity("e1", "concept", "c1", "s1");
    store.upsertEntity("e2", "concept", "c2", "s1");
    store.upsertEntity("e3", "concept", "c3", "s1");

    const ids = store.getAllEntityIds(100);
    expect(ids.length).toBe(3);
  });

  it("setEmbedding stores embedding", () => {
    const id = store.upsertEntity("Embedded", "concept", "Has vector", "s1");
    const embedding = Buffer.from(new Float32Array(384).buffer);

    store.setEmbedding(id, embedding);

    const entity = store.getEntity(id);
    expect(entity!.embedding).not.toBeNull();
    expect(entity!.embedding!.length).toBe(384 * 4); // float32 = 4 bytes
  });

  it("getAllEntityIds respects limit", () => {
    for (let i = 0; i < 10; i++) store.upsertEntity(`e${i}`, "concept", `c${i}`, "s1");
    const ids = store.getAllEntityIds(5);
    expect(ids.length).toBe(5);
  });
});
