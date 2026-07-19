// Mnemosyne Memory Store — SQLite-backed knowledge graph
// Tables: entities (nodes), relations (edges), access_log (decay)
// Memory decay: weight * exp(-decay_rate * days_since_last_access)
// Phase 2: FTS5 search, feedback_log, strategy_weights, query_rewrite_rules

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { MemoryStore, MemoryEntry, MemoryEdge } from "./schema.js";
import { generateSimpleEmbedding } from "./embedding/setup.js";

const DECAY_RATE = 0.01;
const DECAY_THRESHOLD = 0.3;

export interface EntityRow {
  id: number;
  type: string;
  name: string;
  content: string;
  source_session: string;
  source: string;         // 'auto' | 'manual' | 'seeder' | 'memories_md'
  protected: number;       // 1 = never auto-delete
  tags: string;            // comma-separated
  confidence: number;
  created_at: number;
  updated_at: number;
  embedding: Buffer | null; // 384-dim float32
  status: string;           // 'active' | 'superseded' | 'deprecated'
  superseded_by: number | null;
  abstracted_from: string;  // comma-separated IDs of source entities
  feedback_score: number;   // cumulative feedback signal
  access_count: number;     // total times accessed
}

export interface RelationRow {
  id: number;
  source_id: number;
  target_id: number;
  relation_type: string;
  weight: number;
  evidence: string;
  created_at: number;
}

export interface AccessLogRow {
  entity_id: number;
  accessed_at: number;
  source_session: string;
}

export interface InjectedMemory {
  entity: EntityRow;
  retrievalSource: string;
  query: string;
}

export interface FeedbackSignalRow {
  memoryId: number;
  sessionId: string;
  eventType: string;
  signalType: string;
  retrievalSource: string;
  scoreDelta: number;
  context: Record<string, unknown>;
}

const STRATEGIES = ["fts5", "vector", "graph"] as const;
const MIN_STRATEGY_SAMPLES = 5;
const MIN_STRATEGY_WEIGHT = 0.1;
const STRATEGY_LEARNING_RATE = 0.25;

// ---- SQLite Store ----

export class MnemosyneStore implements MemoryStore {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? getDefaultDBPath();
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('file','function','class','concept','config','error','deploy','api','dependency','test','note')),
        name TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        source_session TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK(relation_type IN (
          'DEPENDS_ON','FIXED_BY','RELATED_TO','MENTIONED_IN',
          'IMPLEMENTS','CONFIGURES','TESTED_BY','ALTERNATIVE_TO',
          'REPLACES','CAUSES','PREVENTS','EXAMPLES'
        )),
        weight REAL NOT NULL DEFAULT 1.0,
        evidence TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        accessed_at INTEGER NOT NULL,
        source_session TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
      CREATE INDEX IF NOT EXISTS idx_access_entity ON access_log(entity_id);
    `);

    // Phase 2 migration: add new columns
    this.migrateAddColumn("entities", "source", "TEXT NOT NULL DEFAULT 'auto'");
    this.migrateAddColumn("entities", "protected", "INTEGER NOT NULL DEFAULT 0");
    this.migrateAddColumn("entities", "tags", "TEXT NOT NULL DEFAULT ''");
    this.migrateAddColumn("entities", "embedding", "BLOB");
    this.migrateAddColumn("entities", "status", "TEXT NOT NULL DEFAULT 'active'");
    this.migrateAddColumn("entities", "superseded_by", "INTEGER DEFAULT NULL");
    this.migrateAddColumn("entities", "abstracted_from", "TEXT NOT NULL DEFAULT ''");
    this.migrateAddColumn("entities", "feedback_score", "REAL NOT NULL DEFAULT 0.0");
    this.migrateAddColumn("entities", "access_count", "INTEGER NOT NULL DEFAULT 0");

    // FTS5 virtual table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name, content, tags, content='entities', content_rowid='id'
      );
    `);

    // Feedback log — tracks injection, reference, and usage signals
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
        session_id TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL CHECK(event_type IN ('injected','referenced','ignored','user_corrected','tool_success','tool_failed')),
        score_delta REAL NOT NULL DEFAULT 0,
        signal_type TEXT NOT NULL DEFAULT 'injected',
        context TEXT DEFAULT '{}',
        retrieval_source TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_memory ON feedback_log(memory_id);
      CREATE INDEX IF NOT EXISTS idx_feedback_event ON feedback_log(event_type);
    `);

    // Extra columns for feedback_log (migration-safe)
    this.migrateAddColumn("feedback_log", "signal_type", "TEXT NOT NULL DEFAULT 'injected'");
    this.migrateAddColumn("feedback_log", "retrieval_source", "TEXT NOT NULL DEFAULT ''");

    // Pending consolidation — lazy merging (RecMem pattern)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_consolidation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_hash TEXT NOT NULL,
        entity_ids TEXT NOT NULL,
        similarity REAL NOT NULL DEFAULT 0,
        trigger_count INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);

    // Strategy weights
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategy_weights (
        strategy TEXT PRIMARY KEY,
        weight REAL NOT NULL DEFAULT 0.33,
        total_calls INTEGER NOT NULL DEFAULT 0,
        success_calls INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);

    const existingWeights = this.db.prepare("SELECT COUNT(*) as c FROM strategy_weights").get() as { c: number };
    if (existingWeights.c === 0) {
      const now = Date.now();
      this.db.prepare("INSERT INTO strategy_weights (strategy, weight, updated_at) VALUES (?, ?, ?)").run("fts5", 0.5, now);
      this.db.prepare("INSERT INTO strategy_weights (strategy, weight, updated_at) VALUES (?, ?, ?)").run("vector", 0.3, now);
      this.db.prepare("INSERT INTO strategy_weights (strategy, weight, updated_at) VALUES (?, ?, ?)").run("graph", 0.2, now);
    }

    // Query rewrite rules
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS query_rewrite_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_pattern TEXT NOT NULL,
        rewritten_query TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 1,
        last_used INTEGER NOT NULL DEFAULT 0
      );
    `);

    // FTS5 triggers — keep index in sync with entities table
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, name, content, tags) VALUES (new.id, new.name, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, content, tags) VALUES('delete', old.id, old.name, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, content, tags) VALUES('delete', old.id, old.name, old.content, old.tags);
        INSERT INTO entities_fts(rowid, name, content, tags) VALUES (new.id, new.name, new.content, new.tags);
      END;
    `);

    // Rebuild FTS5 index from existing data
    this.db.exec(`INSERT INTO entities_fts(entities_fts) VALUES('rebuild');`);
  }

  private migrateAddColumn(table: string, column: string, definition: string): void {
    const info = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!info.some((col) => col.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // ---- Entity CRUD ----

  upsertEntity(
    name: string,
    type: EntityRow["type"],
    content: string,
    sourceSession: string,
    confidence = 1.0,
    source: string = "auto",
    isProtected = 0
  ): number {
    const now = Date.now();
    const existing = this.findEntityByName(name, type);

    if (existing) {
      const finalProtected = existing.protected === 1 ? 1 : isProtected;
      const supersedableTypes = ["config", "error", "api", "deploy"];
      const shouldSupersede = supersedableTypes.includes(type) &&
        content !== existing.content && content.length > 0;

      if (shouldSupersede) {
        // MemStrata pattern: mark old entity as superseded, create new one
        this.db
          .prepare(`UPDATE entities SET status = 'superseded', superseded_by = NULL, updated_at = ? WHERE id = ?`)
          .run(now, existing.id);

        const result = this.db
          .prepare(
            `INSERT INTO entities (type, name, content, source_session, source, protected, confidence, created_at, updated_at, status, superseded_by, abstracted_from, feedback_score, access_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, '', 0, 0)`
          )
          .run(type, name, content, sourceSession, source, isProtected, confidence, now, now, existing.id);

        const id = Number(result.lastInsertRowid);
        this.autoEmbed(id, name, content);
        return id;
      } else {
        // Merge pattern: accumulate knowledge for notes/concepts
        const mergedContent = existing.content
          ? `${existing.content}\n${content}`
          : content;
        const mergedConfidence = Math.min(1.0, existing.confidence + confidence * 0.2);

        this.db
          .prepare(
            `UPDATE entities SET content = ?, confidence = ?, updated_at = ?, source_session = ?, protected = ?
             WHERE id = ?`
          )
          .run(mergedContent, mergedConfidence, now, sourceSession, finalProtected, existing.id);

        return existing.id;
      }
    }

    const result = this.db
      .prepare(
        `INSERT INTO entities (type, name, content, source_session, source, protected, confidence, created_at, updated_at, status, abstracted_from, feedback_score, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '', 0, 0)`
      )
      .run(type, name, content, sourceSession, source, isProtected, confidence, now, now);

    const id = Number(result.lastInsertRowid);
    this.autoEmbed(id, name, content);
    return id;
  }

  private autoEmbed(id: number, name: string, content: string): void {
    try {
      const emb = generateSimpleEmbedding(`${name} ${content}`.slice(0, 500));
      this.setEmbedding(id, Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength));
    } catch { /* best-effort */ }
  }

  findEntityByName(name: string, type?: string): EntityRow | null {
    const row = type
      ? this.db.prepare(`SELECT * FROM entities WHERE name = ? AND type = ? LIMIT 1`).get(name, type)
      : this.db.prepare(`SELECT * FROM entities WHERE name = ? LIMIT 1`).get(name);
    return (row as EntityRow) ?? null;
  }

  getEntity(id: number): EntityRow | null {
    const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id);
    return (row as EntityRow) ?? null;
  }

  // ---- Relations ----

  addRelation(
    sourceId: number, targetId: number,
    relationType: RelationRow["relation_type"],
    weight = 1.0, evidence = ""
  ): number {
    const existing = this.db
      .prepare(`SELECT id, weight FROM relations WHERE source_id = ? AND target_id = ? AND relation_type = ?`)
      .get(sourceId, targetId, relationType) as { id: number; weight: number } | undefined;

    if (existing) {
      const newWeight = Math.min(2.0, existing.weight + weight * 0.3);
      this.db.prepare(`UPDATE relations SET weight = ?, evidence = ? WHERE id = ?`).run(newWeight, evidence, existing.id);
      return existing.id;
    }

    const result = this.db
      .prepare(`INSERT INTO relations (source_id, target_id, relation_type, weight, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sourceId, targetId, relationType, weight, evidence, Date.now());
    return Number(result.lastInsertRowid);
  }

  getRelations(entityId: number, relationType?: string): RelationRow[] {
    const sql = relationType
      ? `SELECT * FROM relations WHERE (source_id = ? OR target_id = ?) AND relation_type = ? ORDER BY weight DESC`
      : `SELECT * FROM relations WHERE source_id = ? OR target_id = ? ORDER BY weight DESC`;
    const rows = relationType
      ? this.db.prepare(sql).all(entityId, entityId, relationType)
      : this.db.prepare(sql).all(entityId, entityId);
    return rows as RelationRow[];
  }

  getNeighbors(entityId: number, minWeight = 0.3): Array<{ entity: EntityRow; relation: RelationRow; relevance: number }> {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT e.*, r.id as rel_id, r.relation_type, r.weight as rel_weight,
                r.source_id as rel_source, r.target_id as rel_target
         FROM relations r
         JOIN entities e ON (e.id = r.source_id OR e.id = r.target_id)
         WHERE (r.source_id = ? OR r.target_id = ?) AND e.id != ?
         ORDER BY r.weight DESC`
      )
      .all(entityId, entityId, entityId) as Array<
      EntityRow & { rel_id: number; relation_type: string; rel_weight: number; rel_source: number; rel_target: number }
    >;

    return rows
      .map((row) => {
        const daysSinceAccess = (now - row.updated_at) / (1000 * 60 * 60 * 24);
        const decay = Math.exp(-DECAY_RATE * daysSinceAccess);
        const relevance = row.rel_weight * decay;

        return {
          entity: {
            id: row.id, type: row.type, name: row.name, content: row.content,
            source_session: row.source_session,
            source: row.source ?? "auto", protected: row.protected ?? 0,
            tags: row.tags ?? "", embedding: row.embedding as Buffer | null,
            confidence: row.confidence, created_at: row.created_at, updated_at: row.updated_at,
            status: row.status ?? "active", superseded_by: row.superseded_by as number | null ?? null,
            abstracted_from: row.abstracted_from ?? "", feedback_score: row.feedback_score ?? 0,
            access_count: row.access_count ?? 0,
          },
          relation: {
            id: row.rel_id, source_id: row.rel_source, target_id: row.rel_target,
            relation_type: row.relation_type as RelationRow["relation_type"],
            weight: row.rel_weight, evidence: "", created_at: row.created_at,
          },
          relevance,
        };
      })
      .filter((n) => n.relevance >= minWeight)
      .sort((a, b) => b.relevance - a.relevance);
  }

  // ---- Access Log & Decay ----

  recordAccess(entityId: number, sessionId: string): void {
    this.db.prepare(`INSERT INTO access_log (entity_id, accessed_at, source_session) VALUES (?, ?, ?)`).run(entityId, Date.now(), sessionId);
    this.db.prepare(`UPDATE entities SET updated_at = ?, access_count = access_count + 1 WHERE id = ?`).run(Date.now(), entityId);
  }

  getForgottenCandidates(olderThanDays = 30): EntityRow[] {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities e
         LEFT JOIN access_log a ON a.entity_id = e.id
         WHERE e.updated_at < ?
         GROUP BY e.id
         HAVING COUNT(a.id) = 0 OR MAX(a.accessed_at) < ?
         ORDER BY e.updated_at ASC LIMIT 100`
      )
      .all(cutoff, cutoff);
    return rows as EntityRow[];
  }

  pruneForgotten(olderThanDays = 60): number {
    const candidates = this.getForgottenCandidates(olderThanDays);
    if (candidates.length === 0) return 0;

    // NEVER delete protected entities
    const ids = candidates.filter((c) => c.protected === 0).map((c) => c.id);
    if (ids.length === 0) return 0;

    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM access_log WHERE entity_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`).run(...ids, ...ids);
    const result = this.db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids);
    return result.changes;
  }

  // ---- Search ----

  searchEntities(query: string, limit = 10): EntityRow[] {
    try {
      const rows = this.db
        .prepare(`SELECT e.* FROM entities e INNER JOIN entities_fts fts ON e.id = fts.rowid WHERE entities_fts MATCH ? ORDER BY rank LIMIT ?`)
        .all(query, limit);
      return rows as EntityRow[];
    } catch {
      const like = `%${query}%`;
      const rows = this.db
        .prepare(`SELECT * FROM entities WHERE name LIKE ? OR content LIKE ? ORDER BY confidence DESC, updated_at DESC LIMIT ?`)
        .all(like, like, limit);
      return rows as EntityRow[];
    }
  }

  searchWithRelevance(query: string, limit = 10): Array<{ entity: EntityRow; relevance: number }> {
    const raw = this.searchEntities(query, limit * 2);
    const now = Date.now();

    return raw
      .map((entity) => {
        const daysSinceAccess = (now - entity.updated_at) / (1000 * 60 * 60 * 24);
        const decay = Math.exp(-DECAY_RATE * daysSinceAccess);
        const nameMatch = entity.name.toLowerCase().includes(query.toLowerCase()) ? 1.0 : 0.5;
        const relevance = entity.confidence * decay * nameMatch;
        return { entity, relevance };
      })
      .filter((r) => r.relevance >= DECAY_THRESHOLD)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  }

  getByType(type: string, limit = 50): EntityRow[] {
    const rows = this.db.prepare(`SELECT * FROM entities WHERE type = ? ORDER BY updated_at DESC LIMIT ?`).all(type, limit);
    return rows as EntityRow[];
  }

  /** Get most recent entities with content */
  getRecentEntities(limit = 20): EntityRow[] {
    return this.db.prepare(`SELECT * FROM entities ORDER BY updated_at DESC LIMIT ?`).all(limit) as EntityRow[];
  }

  getAllEntityIds(limit = 200): Array<{ id: number }> {
    return this.db.prepare(`SELECT id FROM entities ORDER BY updated_at DESC LIMIT ?`).all(limit) as Array<{ id: number }>;
  }

  getAccessCount(entityId: number): number {
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM access_log WHERE entity_id = ?`).get(entityId) as { c: number };
    return row.c;
  }

  setEmbedding(entityId: number, embedding: Buffer): void {
    this.db.prepare(`UPDATE entities SET embedding = ? WHERE id = ?`).run(embedding, entityId);
  }

  // ---- Manual Memory ----

  addManualMemory(title: string, content: string, tags: string[], sourceSession: string, type: EntityRow["type"] = "note"): number {
    const now = Date.now();
    const tagStr = tags.join(",");

    const existing = this.findEntityByName(title, type);
    if (existing) {
      this.db.prepare(`UPDATE entities SET content = ?, tags = ?, updated_at = ?, protected = 1, source = 'manual' WHERE id = ?`)
        .run(content, tagStr, now, existing.id);
      return existing.id;
    }

    const result = this.db
      .prepare(`INSERT INTO entities (type, name, content, source_session, source, protected, tags, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', 1, ?, 1.0, ?, ?)`)
      .run(type, title, content, sourceSession, tagStr, now, now);
    return Number(result.lastInsertRowid);
  }

  getManualMemories(limit = 50): EntityRow[] {
    return this.db.prepare(`SELECT * FROM entities WHERE source IN ('manual', 'memories_md') ORDER BY updated_at DESC LIMIT ?`).all(limit) as EntityRow[];
  }

  // ---- Feedback Log ----

  recordFeedback(memoryId: number, sessionId: string, eventType: "injected" | "referenced" | "ignored" | "user_corrected" | "tool_success" | "tool_failed", scoreDelta = 0, context: Record<string, unknown> = {}): void {
    this.db.prepare(`INSERT INTO feedback_log (memory_id, session_id, event_type, score_delta, context, signal_type, retrieval_source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(memoryId, sessionId, eventType, scoreDelta, JSON.stringify(context), eventType, "", Date.now());
  }

  /** Record feedback with retrieval source tracking (for strategy adaptation) */
  recordFeedbackSignal(memoryId: number, sessionId: string, signalType: "injected" | "referenced" | "ignored", retrievalSource: string, context: Record<string, unknown> = {}): void {
    const scoreDelta = signalType === "referenced" ? 0.1 : signalType === "ignored" ? -0.05 : 0;
    this.db.prepare(`INSERT INTO feedback_log (memory_id, session_id, event_type, score_delta, context, signal_type, retrieval_source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(memoryId, sessionId, signalType, scoreDelta, JSON.stringify(context), signalType, retrievalSource, Date.now());
    // Update entity's cumulative feedback score
    this.db.prepare(`UPDATE entities SET feedback_score = feedback_score + ? WHERE id = ?`).run(scoreDelta, memoryId);
  }

  /** Record that a memory was referenced by the AI in its response */
  markReferenced(memoryId: number, sessionId: string, retrievalSource: string, context: Record<string, unknown> = {}): void {
    const exists = this.db.prepare(
      `SELECT 1 FROM feedback_log WHERE memory_id = ? AND session_id = ? AND signal_type = 'referenced' LIMIT 1`
    ).get(memoryId, sessionId);
    if (!exists) {
      this.recordFeedbackSignal(memoryId, sessionId, "referenced", retrievalSource, context);
    }
  }

  /** Return one attribution sample per memory injected during a session. */
  getInjectedMemoriesForSession(sessionId: string): InjectedMemory[] {
    const rows = this.db.prepare(
      `SELECT f.memory_id, f.retrieval_source, f.context, e.*
       FROM feedback_log f
       JOIN entities e ON e.id = f.memory_id
       WHERE f.session_id = ? AND f.signal_type = 'injected'
       ORDER BY f.timestamp ASC`
    ).all(sessionId) as Array<EntityRow & {
      memory_id: number;
      retrieval_source: string;
      context: string;
    }>;

    const combined = new Map<number, { entity: EntityRow; sources: Set<string>; query: string }>();
    for (const row of rows) {
      let entry = combined.get(row.memory_id);
      if (!entry) {
        entry = { entity: row, sources: new Set<string>(), query: "" };
        combined.set(row.memory_id, entry);
      }
      for (const source of splitRetrievalSources(row.retrieval_source)) {
        entry.sources.add(source);
      }
      if (!entry.query) {
        try {
          const context = JSON.parse(row.context) as { query?: unknown };
          if (typeof context.query === "string") entry.query = context.query;
        } catch { /* malformed legacy context */ }
      }
    }

    return [...combined.values()].map(({ entity, sources, query }) => ({
      entity,
      retrievalSource: [...sources].join(","),
      query,
    }));
  }

  /** Mark all injected-but-not-referenced memories as ignored */
  markIgnoredForSession(sessionId: string): void {
    const resolved = new Set(
      (this.db.prepare(
        `SELECT DISTINCT memory_id FROM feedback_log
         WHERE session_id = ? AND signal_type IN ('referenced', 'ignored')`
      ).all(sessionId) as Array<{ memory_id: number }>).map((row) => row.memory_id)
    );
    for (const injected of this.getInjectedMemoriesForSession(sessionId)) {
      if (!resolved.has(injected.entity.id)) {
        this.recordFeedbackSignal(injected.entity.id, sessionId, "ignored", injected.retrievalSource);
      }
    }
  }

  getFeedbackSignalsForSession(sessionId: string): FeedbackSignalRow[] {
    const rows = this.db.prepare(
      `SELECT memory_id, session_id, event_type, signal_type, retrieval_source, score_delta, context
       FROM feedback_log WHERE session_id = ? ORDER BY id ASC`
    ).all(sessionId) as Array<{
      memory_id: number;
      session_id: string;
      event_type: string;
      signal_type: string;
      retrieval_source: string;
      score_delta: number;
      context: string;
    }>;
    return rows.map((row) => {
      let context: Record<string, unknown> = {};
      try { context = JSON.parse(row.context) as Record<string, unknown>; } catch { /* malformed legacy context */ }
      return {
        memoryId: row.memory_id,
        sessionId: row.session_id,
        eventType: row.event_type,
        signalType: row.signal_type,
        retrievalSource: row.retrieval_source,
        scoreDelta: row.score_delta,
        context,
      };
    });
  }

  getFeedbackStats(memoryId: number): { injections: number; successes: number; failures: number } {
    const injections = (this.db.prepare(`SELECT COUNT(*) as c FROM feedback_log WHERE memory_id = ? AND event_type = 'injected'`).get(memoryId) as { c: number }).c;
    const successes = (this.db.prepare(`SELECT COUNT(*) as c FROM feedback_log WHERE memory_id = ? AND event_type = 'tool_success'`).get(memoryId) as { c: number }).c;
    const failures = (this.db.prepare(`SELECT COUNT(*) as c FROM feedback_log WHERE memory_id = ? AND event_type = 'tool_failed'`).get(memoryId) as { c: number }).c;
    return { injections, successes, failures };
  }

  // ---- Strategy Weights ----

  updateStrategyWeight(strategy: string, wasHelpful: boolean): void {
    this.db.prepare(
      `UPDATE strategy_weights SET total_calls = total_calls + 1, success_calls = success_calls + ?,
       weight = CASE WHEN total_calls > 0 THEN CAST(success_calls + ? AS REAL) / (total_calls + 1) ELSE weight END,
       updated_at = ? WHERE strategy = ?`
    ).run(wasHelpful ? 1 : 0, wasHelpful ? 1 : 0, Date.now(), strategy);
  }

  getStrategyWeights(): Array<{ strategy: string; weight: number; totalCalls: number; successRate: number }> {
    const rows = this.db.prepare(`SELECT * FROM strategy_weights ORDER BY weight DESC`).all() as Array<{ strategy: string; weight: number; total_calls: number; success_calls: number }>;
    return rows.map((r) => ({ strategy: r.strategy, weight: r.weight, totalCalls: r.total_calls, successRate: r.total_calls > 0 ? r.success_calls / r.total_calls : 0 }));
  }

  /** Auto-tune strategy weights based on feedback signals */
  autoTuneStrategyWeights(): void {
    const rows = this.db.prepare(
      `SELECT session_id, memory_id, signal_type, retrieval_source
       FROM feedback_log
       WHERE signal_type IN ('injected', 'referenced', 'ignored') AND retrieval_source != ''
       ORDER BY id ASC`
    ).all() as Array<{
      session_id: string;
      memory_id: number;
      signal_type: string;
      retrieval_source: string;
    }>;

    const samples = new Map<string, { sources: Set<string>; injected: boolean; resolved: boolean; referenced: boolean }>();
    for (const row of rows) {
      const key = `${row.session_id}:${row.memory_id}`;
      let sample = samples.get(key);
      if (!sample) {
        sample = { sources: new Set<string>(), injected: false, resolved: false, referenced: false };
        samples.set(key, sample);
      }
      for (const source of splitRetrievalSources(row.retrieval_source)) {
        sample.sources.add(source);
      }
      if (row.signal_type === "injected") sample.injected = true;
      if (row.signal_type === "referenced" || row.signal_type === "ignored") sample.resolved = true;
      if (row.signal_type === "referenced") sample.referenced = true;
    }

    const totals = new Map<string, { total: number; hits: number }>();
    for (const strategy of STRATEGIES) totals.set(strategy, { total: 0, hits: 0 });
    for (const sample of samples.values()) {
      if (!sample.injected || !sample.resolved) continue;
      for (const source of sample.sources) {
        const stat = totals.get(source);
        if (!stat) continue;
        stat.total++;
        if (sample.referenced) stat.hits++;
      }
    }

    const current = new Map(this.getStrategyWeights().map((row) => [row.strategy, row]));
    const candidate = new Map<string, number>();
    let hasNewEvidence = false;
    for (const strategy of STRATEGIES) {
      const stat = totals.get(strategy)!;
      const currentRow = current.get(strategy);
      const currentWeight = currentRow?.weight ?? 1 / STRATEGIES.length;
      if (stat.total >= MIN_STRATEGY_SAMPLES && stat.total > (currentRow?.totalCalls ?? 0)) {
        const observedRate = (stat.hits + 1) / (stat.total + 2);
        candidate.set(strategy, currentWeight * (1 - STRATEGY_LEARNING_RATE) + observedRate * STRATEGY_LEARNING_RATE);
        hasNewEvidence = true;
      } else {
        candidate.set(strategy, currentWeight);
      }
    }

    const candidateTotal = [...candidate.values()].reduce((sum, weight) => sum + weight, 0);
    const needsRepair = [...candidate.values()].some((weight) => weight < MIN_STRATEGY_WEIGHT) ||
      Math.abs(candidateTotal - 1) > 1e-9;
    const normalized = hasNewEvidence || needsRepair ? normalizeStrategyWeights(candidate) : candidate;
    const now = Date.now();
    for (const strategy of STRATEGIES) {
      const stat = totals.get(strategy)!;
      this.db.prepare(
        `UPDATE strategy_weights SET weight = ?, total_calls = ?, success_calls = ?, updated_at = ?
         WHERE strategy = ?`
      ).run(normalized.get(strategy), stat.total, stat.hits, now, strategy);
    }
  }

  /** Get entities that were referenced in recent sessions (positive feedback) */
  getTopPerforming(limit = 10): EntityRow[] {
    return this.db.prepare(
      `SELECT * FROM entities WHERE status = 'active' ORDER BY feedback_score DESC LIMIT ?`
    ).all(limit) as EntityRow[];
  }

  // ---- Pending Consolidation (RecMem lazy pattern) ----

  /** Check if similar entities should be consolidated */
  checkConsolidationThreshold(groupHash: string, threshold = 3): boolean {
    const row = this.db.prepare(
      `SELECT trigger_count FROM pending_consolidation WHERE group_hash = ?`
    ).get(groupHash) as { trigger_count: number } | undefined;
    return (row?.trigger_count ?? 0) >= threshold;
  }

  /** Add or bump a pending consolidation group */
  upsertPendingConsolidation(groupHash: string, entityIds: number[], similarity: number): void {
    const existing = this.db.prepare(
      `SELECT id, trigger_count, entity_ids FROM pending_consolidation WHERE group_hash = ?`
    ).get(groupHash) as { id: number; trigger_count: number; entity_ids: string } | undefined;

    if (existing) {
      const mergedIds = [...new Set([...existing.entity_ids.split(",").map(Number), ...entityIds])];
      this.db.prepare(
        `UPDATE pending_consolidation SET entity_ids = ?, trigger_count = trigger_count + 1, similarity = ?, last_seen_at = ? WHERE id = ?`
      ).run(mergedIds.join(","), similarity, Date.now(), existing.id);
    } else {
      this.db.prepare(
        `INSERT INTO pending_consolidation (group_hash, entity_ids, similarity, trigger_count, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, 1, ?, ?)`
      ).run(groupHash, entityIds.join(","), similarity, Date.now(), Date.now());
    }
  }

  getPendingConsolidations(): Array<{ groupHash: string; entityIds: number[]; triggerCount: number; similarity: number }> {
    return (this.db.prepare(
      `SELECT * FROM pending_consolidation WHERE trigger_count >= 3 ORDER BY trigger_count DESC`
    ).all() as Array<{ group_hash: string; entity_ids: string; trigger_count: number; similarity: number }>)
      .map((r) => ({ groupHash: r.group_hash, entityIds: r.entity_ids.split(",").map(Number), triggerCount: r.trigger_count, similarity: r.similarity }));
  }

  // ---- Memory Health ----

  getHealthReport(): { active: number; superseded: number; deprecated: number; pendingConsolidation: number; vectorReady: boolean } {
    const active = (this.db.prepare(`SELECT COUNT(*) as c FROM entities WHERE status = 'active'`).get() as { c: number }).c;
    const superseded = (this.db.prepare(`SELECT COUNT(*) as c FROM entities WHERE status = 'superseded'`).get() as { c: number }).c;
    const deprecated = (this.db.prepare(`SELECT COUNT(*) as c FROM entities WHERE status = 'deprecated'`).get() as { c: number }).c;
    const pending = (this.db.prepare(`SELECT COUNT(*) as c FROM pending_consolidation WHERE trigger_count >= 3`).get() as { c: number }).c;
    const embeddedCount = (this.db.prepare(`SELECT COUNT(*) as c FROM entities WHERE embedding IS NOT NULL`).get() as { c: number }).c;
    return { active, superseded, deprecated, pendingConsolidation: pending, vectorReady: embeddedCount > 0 };
  }

  // ---- Query Rewrite Rules ----

  addQueryRewriteRule(originalPattern: string, rewrittenQuery: string): void {
    const existing = this.db.prepare(`SELECT id, success_count FROM query_rewrite_rules WHERE original_pattern = ? AND rewritten_query = ?`).get(originalPattern, rewrittenQuery) as { id: number; success_count: number } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE query_rewrite_rules SET success_count = ?, last_used = ? WHERE id = ?`).run(existing.success_count + 1, Date.now(), existing.id);
    } else {
      this.db.prepare(`INSERT INTO query_rewrite_rules (original_pattern, rewritten_query, last_used) VALUES (?, ?, ?)`).run(originalPattern, rewrittenQuery, Date.now());
    }
  }

  getQueryRewrites(originalPattern: string, limit = 5): string[] {
    const rows = this.db.prepare(`SELECT rewritten_query FROM query_rewrite_rules WHERE original_pattern = ? ORDER BY success_count DESC LIMIT ?`).all(originalPattern, limit) as Array<{ rewritten_query: string }>;
    return rows.map((r) => r.rewritten_query);
  }

  // ---- Graph Traversal ----

  traverseGraph(startIds: number[], maxHops = 2, maxResults = 30): Array<{ entity: EntityRow; hops: number; path: string[] }> {
    const visited = new Set<number>();
    const results: Array<{ entity: EntityRow; hops: number; path: string[] }> = [];
    const queue: Array<{ id: number; hops: number; path: string[] }> = startIds.map((id) => ({ id, hops: 0, path: [String(id)] }));

    while (queue.length > 0 && results.length < maxResults) {
      const current = queue.shift()!;
      if (visited.has(current.id) || current.hops > maxHops) continue;
      visited.add(current.id);

      const entity = this.getEntity(current.id);
      if (!entity) continue;

      if (current.hops > 0) {
        results.push({ entity, hops: current.hops, path: current.path });
      }

      const relations = this.getRelations(current.id);
      for (const rel of relations) {
        const neighborId = rel.source_id === current.id ? rel.target_id : rel.source_id;
        if (!visited.has(neighborId)) {
          queue.push({ id: neighborId, hops: current.hops + 1, path: [...current.path, `${rel.relation_type}→${neighborId}`] });
        }
      }
    }

    return results.sort((a, b) => a.hops - b.hops);
  }

  // ---- Journal Migration ----

  migrateJournalEntries(journalDbPath: string): number {
    if (!fs.existsSync(journalDbPath)) return 0;
    let migrated = 0;
    try {
      const journalDb = new Database(journalDbPath);
      journalDb.pragma("journal_mode = WAL");

      const rows = journalDb.prepare(`SELECT * FROM journal_entries ORDER BY created_at`).all() as Array<{
        title: string; content: string; tags: string; source_session: string; type: string;
      }>;

      for (const row of rows) {
        const tagList = row.tags ? row.tags.split(",").filter(Boolean) : [];
        const entityType = mapJournalType(row.type);
        this.addManualMemory(row.title, row.content, tagList, row.source_session || "journal_migration", entityType);
        migrated++;
      }

      journalDb.close();
    } catch { /* best-effort */ }
    return migrated;
  }

  // ---- Stats ----

  getStats(): { entities: number; relations: number; accessLogs: number; manualMemories: number } {
    const entities = (this.db.prepare(`SELECT COUNT(*) as c FROM entities`).get() as { c: number }).c;
    const relations = (this.db.prepare(`SELECT COUNT(*) as c FROM relations`).get() as { c: number }).c;
    const accessLogs = (this.db.prepare(`SELECT COUNT(*) as c FROM access_log`).get() as { c: number }).c;
    const manualMemories = (this.db.prepare(`SELECT COUNT(*) as c FROM entities WHERE source IN ('manual', 'memories_md')`).get() as { c: number }).c;
    return { entities, relations, accessLogs, manualMemories };
  }

  // ---- Lifecycle ----

  close(): void { this.db.close(); }

  // ---- MemoryStore interface ----

  async addEntry(entry: MemoryEntry): Promise<number> {
    return this.upsertEntity(entry.content.slice(0, 100), entry.type as EntityRow["type"], entry.content, entry.source ?? "", 1.0);
  }

  async addEdge(edge: MemoryEdge): Promise<number> {
    return this.addRelation(edge.source_id, edge.target_id, edge.relation as RelationRow["relation_type"], edge.weight);
  }

  async search(query: string, limit = 10): Promise<MemoryEntry[]> {
    const entities = this.searchWithRelevance(query, limit);
    return entities.map(({ entity }) => ({ id: entity.id, type: entity.type as MemoryEntry["type"], content: `${entity.name}: ${entity.content}`, source: entity.source_session, timestamp: entity.updated_at }));
  }

  async searchByVector(_vector: Float32Array, _limit = 10): Promise<MemoryEntry[]> { return []; }

  async getEdges(entryId: number): Promise<MemoryEdge[]> {
    const rels = this.getRelations(entryId);
    return rels.map((r) => ({ id: r.id, source_id: r.source_id, target_id: r.target_id, relation: r.relation_type as MemoryEdge["relation"], weight: r.weight, timestamp: r.created_at }));
  }

  async getRelated(entryId: number, depth = 1): Promise<MemoryEntry[]> {
    const neighbors = this.getNeighbors(entryId);
    return neighbors.map(({ entity }) => ({ id: entity.id, type: entity.type as MemoryEntry["type"], content: `${entity.name}: ${entity.content}`, source: entity.source_session, timestamp: entity.updated_at }));
  }
}

// ---- Helpers ----

function mapJournalType(journalType: string): EntityRow["type"] {
  switch (journalType) {
    case "tip": return "note";
    case "fix": return "error";
    case "concept": return "concept";
    case "snippet": return "note";
    case "resource": return "note";
    default: return "note";
  }
}

function splitRetrievalSources(value: string): string[] {
  return [...new Set(
    value.split(/[,+]/)
      .map((source) => source.trim())
      .filter((source) => (STRATEGIES as readonly string[]).includes(source))
  )];
}

function normalizeStrategyWeights(weights: Map<string, number>): Map<string, number> {
  const excessBudget = 1 - MIN_STRATEGY_WEIGHT * STRATEGIES.length;
  const excess = STRATEGIES.map((strategy) =>
    Math.max(0, (weights.get(strategy) ?? MIN_STRATEGY_WEIGHT) - MIN_STRATEGY_WEIGHT)
  );
  const excessTotal = excess.reduce((sum, value) => sum + value, 0);

  return new Map(STRATEGIES.map((strategy, index) => [
    strategy,
    MIN_STRATEGY_WEIGHT + (excessTotal > 0
      ? excessBudget * excess[index] / excessTotal
      : excessBudget / STRATEGIES.length),
  ]));
}

// ---- Singleton ----

let defaultStore: MnemosyneStore | null = null;

export function getMnemosyneStore(dbPath?: string): MnemosyneStore {
  if (!defaultStore) defaultStore = new MnemosyneStore(dbPath);
  return defaultStore;
}

export function setMnemosyneStore(store: MnemosyneStore | null): void {
  if (defaultStore && defaultStore !== store) {
    try {
      defaultStore.close();
    } catch {
      // Store may already be closed by a test or shutdown hook.
    }
  }
  defaultStore = store;
}

export function closeMnemosyneStore(): void {
  const store = defaultStore;
  defaultStore = null;
  if (store) {
    store.close();
  }
}

function getDefaultDBPath(): string {
  const dir = process.env.HOME ?? "/tmp";
  return path.join(dir, ".rubato", "mnemosyne", "memory.db");
}
