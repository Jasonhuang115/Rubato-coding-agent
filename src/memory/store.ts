// Mnemosyne Memory Store — SQLite-backed knowledge graph
// Tables: entities (nodes), relations (edges), access_log (decay)
// Memory decay: weight * exp(-decay_rate * days_since_last_access)

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { MemoryStore, MemoryEntry, MemoryEdge } from "./schema.js";

const DECAY_RATE = 0.01; // per day
const DECAY_THRESHOLD = 0.3; // below this, memory is "forgotten"

export interface EntityRow {
  id: number;
  type: string;
  name: string;
  content: string;
  source_session: string;
  confidence: number;
  created_at: number;
  updated_at: number;
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
  }

  // ---- Entity CRUD ----

  upsertEntity(
    name: string,
    type: EntityRow["type"],
    content: string,
    sourceSession: string,
    confidence = 1.0
  ): number {
    const now = Date.now();
    const existing = this.findEntityByName(name, type);

    if (existing) {
      // Merge: update content if new info, bump confidence
      const mergedContent = existing.content
        ? `${existing.content}\n${content}`
        : content;
      const mergedConfidence = Math.min(1.0, existing.confidence + confidence * 0.2);

      this.db
        .prepare(
          `UPDATE entities SET content = ?, confidence = ?, updated_at = ?, source_session = ?
           WHERE id = ?`
        )
        .run(mergedContent, mergedConfidence, now, sourceSession, existing.id);

      return existing.id;
    }

    const result = this.db
      .prepare(
        `INSERT INTO entities (type, name, content, source_session, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(type, name, content, sourceSession, confidence, now, now);

    return Number(result.lastInsertRowid);
  }

  findEntityByName(name: string, type?: string): EntityRow | null {
    const row = type
      ? this.db
          .prepare(`SELECT * FROM entities WHERE name = ? AND type = ? LIMIT 1`)
          .get(name, type)
      : this.db
          .prepare(`SELECT * FROM entities WHERE name = ? LIMIT 1`)
          .get(name);

    return (row as EntityRow) ?? null;
  }

  getEntity(id: number): EntityRow | null {
    const row = this.db
      .prepare(`SELECT * FROM entities WHERE id = ?`)
      .get(id);
    return (row as EntityRow) ?? null;
  }

  // ---- Relations ----

  addRelation(
    sourceId: number,
    targetId: number,
    relationType: RelationRow["relation_type"],
    weight = 1.0,
    evidence = ""
  ): number {
    // Avoid exact duplicates — update weight instead
    const existing = this.db
      .prepare(
        `SELECT id, weight FROM relations
         WHERE source_id = ? AND target_id = ? AND relation_type = ?`
      )
      .get(sourceId, targetId, relationType) as { id: number; weight: number } | undefined;

    if (existing) {
      const newWeight = Math.min(2.0, existing.weight + weight * 0.3);
      this.db
        .prepare(`UPDATE relations SET weight = ?, evidence = ? WHERE id = ?`)
        .run(newWeight, evidence, existing.id);
      return existing.id;
    }

    const result = this.db
      .prepare(
        `INSERT INTO relations (source_id, target_id, relation_type, weight, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
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

  /** Get 1-hop neighbors with decay-adjusted relevance */
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
      EntityRow & {
        rel_id: number;
        relation_type: string;
        rel_weight: number;
        rel_source: number;
        rel_target: number;
      }
    >;

    return rows
      .map((row) => {
        const daysSinceAccess = (now - row.updated_at) / (1000 * 60 * 60 * 24);
        const decay = Math.exp(-DECAY_RATE * daysSinceAccess);
        const relevance = row.rel_weight * decay;

        return {
          entity: {
            id: row.id,
            type: row.type,
            name: row.name,
            content: row.content,
            source_session: row.source_session,
            confidence: row.confidence,
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
          relation: {
            id: row.rel_id,
            source_id: row.rel_source,
            target_id: row.rel_target,
            relation_type: row.relation_type as RelationRow["relation_type"],
            weight: row.rel_weight,
            evidence: "",
            created_at: row.created_at,
          },
          relevance,
        };
      })
      .filter((n) => n.relevance >= minWeight)
      .sort((a, b) => b.relevance - a.relevance);
  }

  // ---- Access Log & Decay ----

  recordAccess(entityId: number, sessionId: string): void {
    this.db
      .prepare(`INSERT INTO access_log (entity_id, accessed_at, source_session) VALUES (?, ?, ?)`)
      .run(entityId, Date.now(), sessionId);

    // Update entity timestamp (resets decay)
    this.db
      .prepare(`UPDATE entities SET updated_at = ? WHERE id = ?`)
      .run(Date.now(), entityId);
  }

  /** Get entities that have decayed below threshold — ready for pruning */
  getForgottenCandidates(olderThanDays = 30): EntityRow[] {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities e
         LEFT JOIN access_log a ON a.entity_id = e.id
         WHERE e.updated_at < ?
         GROUP BY e.id
         HAVING COUNT(a.id) = 0
            OR MAX(a.accessed_at) < ?
         ORDER BY e.updated_at ASC
         LIMIT 100`
      )
      .all(cutoff, cutoff);

    return rows as EntityRow[];
  }

  pruneForgotten(olderThanDays = 60): number {
    const candidates = this.getForgottenCandidates(olderThanDays);
    if (candidates.length === 0) return 0;

    const ids = candidates.map((c) => c.id);
    const placeholders = ids.map(() => "?").join(",");

    this.db.prepare(`DELETE FROM access_log WHERE entity_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM relations WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`).run(...ids, ...ids);
    const result = this.db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...ids);

    return result.changes;
  }

  // ---- Search ----

  /** Full-text search across entity names and content */
  searchEntities(query: string, limit = 10): EntityRow[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM entities
         WHERE name LIKE ? OR content LIKE ?
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?`
      )
      .all(like, like, limit);

    return rows as EntityRow[];
  }

  /** Search with decay-adjusted relevance scoring */
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

  /** Get entities of a specific type */
  getByType(type: string, limit = 50): EntityRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM entities WHERE type = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(type, limit);
    return rows as EntityRow[];
  }

  // ---- Stats ----

  getStats(): { entities: number; relations: number; accessLogs: number } {
    const entities = (this.db.prepare(`SELECT COUNT(*) as c FROM entities`).get() as { c: number }).c;
    const relations = (this.db.prepare(`SELECT COUNT(*) as c FROM relations`).get() as { c: number }).c;
    const accessLogs = (this.db.prepare(`SELECT COUNT(*) as c FROM access_log`).get() as { c: number }).c;
    return { entities, relations, accessLogs };
  }

  // ---- Lifecycle ----

  close(): void {
    this.db.close();
  }

  // ---- MemoryStore interface (compat with schema.ts) ----

  async addEntry(entry: MemoryEntry): Promise<number> {
    return this.upsertEntity(
      entry.content.slice(0, 100), // name from content
      entry.type as EntityRow["type"],
      entry.content,
      entry.source ?? "",
      1.0
    );
  }

  async addEdge(edge: MemoryEdge): Promise<number> {
    return this.addRelation(
      edge.source_id,
      edge.target_id,
      edge.relation as RelationRow["relation_type"],
      edge.weight
    );
  }

  async search(query: string, limit = 10): Promise<MemoryEntry[]> {
    const entities = this.searchWithRelevance(query, limit);
    return entities.map(({ entity }) => ({
      id: entity.id,
      type: entity.type as MemoryEntry["type"],
      content: `${entity.name}: ${entity.content}`,
      source: entity.source_session,
      timestamp: entity.updated_at,
    }));
  }

  async searchByVector(_vector: Float32Array, _limit = 10): Promise<MemoryEntry[]> {
    // Phase 2: implement vector search via sqlite-vec
    // For now, fall back to text search
    return [];
  }

  async getEdges(entryId: number): Promise<MemoryEdge[]> {
    const rels = this.getRelations(entryId);
    return rels.map((r) => ({
      id: r.id,
      source_id: r.source_id,
      target_id: r.target_id,
      relation: r.relation_type as MemoryEdge["relation"],
      weight: r.weight,
      timestamp: r.created_at,
    }));
  }

  async getRelated(entryId: number, depth = 1): Promise<MemoryEntry[]> {
    const neighbors = this.getNeighbors(entryId);
    return neighbors.map(({ entity }) => ({
      id: entity.id,
      type: entity.type as MemoryEntry["type"],
      content: `${entity.name}: ${entity.content}`,
      source: entity.source_session,
      timestamp: entity.updated_at,
    }));
  }
}

// ---- Singleton ----

let defaultStore: MnemosyneStore | null = null;

export function getMnemosyneStore(dbPath?: string): MnemosyneStore {
  if (!defaultStore) {
    defaultStore = new MnemosyneStore(dbPath);
  }
  return defaultStore;
}

export function closeMnemosyneStore(): void {
  if (defaultStore) {
    defaultStore.close();
    defaultStore = null;
  }
}

function getDefaultDBPath(): string {
  const dir = process.env.HOME ?? "/tmp";
  return path.join(dir, ".coding-agent", "mnemosyne", "memory.db");
}
