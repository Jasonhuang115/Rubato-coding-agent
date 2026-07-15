// Personal Tech Journal — SQLite-backed knowledge base
// Path: ~/.coding-agent/journal/journal.db
// Stores: id, title, content, tags, source_session, created_at

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export interface JournalEntry {
  id?: number;
  title: string;
  content: string;
  tags: string[];
  sourceSession: string;
  projectPath: string; // which project this came from
  type: "tip" | "fix" | "concept" | "snippet" | "resource" | "note";
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  lastAccessedAt: string;
}

export interface SearchResult {
  entry: JournalEntry;
  score: number;
  matchedField: "title" | "content" | "tags";
}

// ---- SQLite Store ----

export class JournalStore {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? getDefaultPath();
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',           -- comma-separated
        source_session TEXT NOT NULL DEFAULT '',
        project_path TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'note'
          CHECK(type IN ('tip','fix','concept','snippet','resource','note')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_journal_tags ON journal_entries(tags);
      CREATE INDEX IF NOT EXISTS idx_journal_type ON journal_entries(type);
      CREATE INDEX IF NOT EXISTS idx_journal_created ON journal_entries(created_at);
    `);
  }

  // ---- CRUD ----

  addEntry(entry: Omit<JournalEntry, "id" | "createdAt" | "updatedAt" | "accessCount" | "lastAccessedAt">): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO journal_entries
         (title, content, tags, source_session, project_path, type, created_at, updated_at, access_count, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        entry.title,
        entry.content,
        entry.tags.join(","),
        entry.sourceSession,
        entry.projectPath,
        entry.type,
        now,
        now,
        now
      );

    return Number(result.lastInsertRowid);
  }

  updateEntry(id: number, updates: Partial<Pick<JournalEntry, "title" | "content" | "tags" | "type">>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.title !== undefined) {
      fields.push("title = ?");
      values.push(updates.title);
    }
    if (updates.content !== undefined) {
      fields.push("content = ?");
      values.push(updates.content);
    }
    if (updates.tags !== undefined) {
      fields.push("tags = ?");
      values.push(updates.tags.join(","));
    }
    if (updates.type !== undefined) {
      fields.push("type = ?");
      values.push(updates.type);
    }

    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    this.db
      .prepare(`UPDATE journal_entries SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  getEntry(id: number): JournalEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM journal_entries WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;

    return row ? rowToEntry(row) : null;
  }

  deleteEntry(id: number): void {
    this.db.prepare(`DELETE FROM journal_entries WHERE id = ?`).run(id);
  }

  // ---- Search ----

  /** Full-text search across title, content, and tags */
  search(query: string, limit = 10): SearchResult[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM journal_entries
         WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
         ORDER BY access_count DESC, updated_at DESC
         LIMIT ?`
      )
      .all(like, like, like, limit) as Record<string, unknown>[];

    return rows.map((row) => {
      const entry = rowToEntry(row);
      const score = calculateScore(entry, query);
      const matchedField = determineMatchField(entry, query);

      // Record access
      this.recordAccess(entry.id!);

      return { entry, score, matchedField };
    });
  }

  /** Search by tags */
  searchByTag(tag: string, limit = 20): JournalEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM journal_entries
         WHERE tags LIKE ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(`%${tag}%`, limit) as Record<string, unknown>[];

    return rows.map(rowToEntry);
  }

  /** Get recent entries */
  getRecent(limit = 10): JournalEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM journal_entries
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[];

    return rows.map(rowToEntry);
  }

  /** Get most frequently accessed entries */
  getPopular(limit = 10): JournalEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM journal_entries
         ORDER BY access_count DESC
         LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[];

    return rows.map(rowToEntry);
  }

  /** Get entries by type */
  getByType(type: JournalEntry["type"], limit = 20): JournalEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM journal_entries
         WHERE type = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(type, limit) as Record<string, unknown>[];

    return rows.map(rowToEntry);
  }

  /** Get entries from a specific project */
  getByProject(projectPath: string, limit = 20): JournalEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM journal_entries
         WHERE project_path = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(projectPath, limit) as Record<string, unknown>[];

    return rows.map(rowToEntry);
  }

  // ---- Access tracking ----

  recordAccess(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE journal_entries
         SET access_count = access_count + 1, last_accessed_at = ?
         WHERE id = ?`
      )
      .run(now, id);
  }

  // ---- Stats ----

  getStats(): { total: number; byType: Record<string, number>; topTags: string[] } {
    const total = (
      this.db.prepare(`SELECT COUNT(*) as c FROM journal_entries`).get() as { c: number }
    ).c;

    const typeRows = this.db
      .prepare(`SELECT type, COUNT(*) as c FROM journal_entries GROUP BY type`)
      .all() as Array<{ type: string; c: number }>;

    const byType: Record<string, number> = {};
    for (const row of typeRows) {
      byType[row.type] = row.c;
    }

    // Top tags
    const allEntries = this.db
      .prepare(`SELECT tags FROM journal_entries`)
      .all() as Array<{ tags: string }>;

    const tagCounts = new Map<string, number>();
    for (const { tags } of allEntries) {
      for (const tag of tags.split(",").filter(Boolean)) {
        tagCounts.set(tag.trim(), (tagCounts.get(tag.trim()) ?? 0) + 1);
      }
    }

    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);

    return { total, byType, topTags };
  }

  // ---- Export ----

  /** Export all entries as markdown */
  exportMarkdown(): string {
    const entries = this.getRecent(1000);
    const lines = ["# Personal Tech Journal", "", `导出时间：${new Date().toISOString()}`, `总条目：${entries.length}`, ""];

    for (const entry of entries) {
      lines.push(`## ${entry.title}`);
      lines.push(`类型：${entry.type} | 标签：${entry.tags.join(", ")} | 来源：${entry.sourceSession}`);
      lines.push("");
      lines.push(entry.content);
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    return lines.join("\n");
  }

  close(): void {
    this.db.close();
  }
}

// ---- Helpers ----

function rowToEntry(row: Record<string, unknown>): JournalEntry {
  return {
    id: row.id as number,
    title: row.title as string,
    content: row.content as string,
    tags: (row.tags as string)?.split(",").filter(Boolean) ?? [],
    sourceSession: row.source_session as string,
    projectPath: row.project_path as string,
    type: row.type as JournalEntry["type"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    accessCount: row.access_count as number,
    lastAccessedAt: row.last_accessed_at as string,
  };
}

function calculateScore(entry: JournalEntry, query: string): number {
  const lower = query.toLowerCase();
  let score = 0;

  if (entry.title.toLowerCase().includes(lower)) score += 3;
  if (entry.content.toLowerCase().includes(lower)) score += 1;
  if (entry.tags.some((t) => t.toLowerCase().includes(lower))) score += 2;
  score += Math.min(entry.accessCount * 0.1, 1); // access boost

  return score;
}

function determineMatchField(
  entry: JournalEntry,
  query: string
): SearchResult["matchedField"] {
  const lower = query.toLowerCase();
  if (entry.title.toLowerCase().includes(lower)) return "title";
  if (entry.tags.some((t) => t.toLowerCase().includes(lower))) return "tags";
  return "content";
}

// ---- Singleton ----

let defaultStore: JournalStore | null = null;

export function getJournalStore(): JournalStore {
  if (!defaultStore) {
    defaultStore = new JournalStore();
  }
  return defaultStore;
}

export function closeJournalStore(): void {
  if (defaultStore) {
    defaultStore.close();
    defaultStore = null;
  }
}

function getDefaultPath(): string {
  const dir = process.env.HOME ?? "/tmp";
  return path.join(dir, ".coding-agent", "journal", "journal.db");
}
