/**
 * Explicit, one-time migration bridge for the legacy Mnemosyne SQLite store.
 *
 * Importing this module has no database side effects. better-sqlite3 is loaded
 * dynamically, and the supplied database is opened read-only, only when
 * migrateLegacyMnemosyne() is called.
 */

import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";

export interface LegacyMnemosyneCandidate {
  schema: "rubato.memory.legacy-candidate/v1";
  candidate_id: string;
  state: "pending";
  operation: "CREATE";
  digest: string;
  created_at: string;
  source: {
    kind: "mnemosyne_entity";
    database_path_digest: string;
    entity_id: number;
    entity_type: string;
    legacy_source: string;
    source_session: string;
    protected: boolean;
    legacy_created_at?: string;
    legacy_updated_at?: string;
  };
  proposed: {
    logical_key: string;
    kind: "note" | "convention" | "lesson" | "workflow";
    scope: "global";
    status: "candidate";
    origin: "migrated";
    application: "reference";
    authority: "user_explicit" | "agent_derived";
    title: string;
    body: string;
    tags: string[];
  };
}

export interface LegacyMnemosyneMigrationResult {
  databasePathDigest: string;
  scanned: number;
  eligible: number;
  created: number;
  skipped: number;
  candidateIds: string[];
  createdFiles: string[];
}

interface LegacyEntityRow {
  id: number;
  type: string;
  name: string;
  content: string;
  source_session: string;
  source: string;
  protected: number;
  tags: string;
  created_at: number | null;
  updated_at: number | null;
}

interface SQLiteStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
}

interface ReadonlySQLiteDatabase {
  prepare(sql: string): SQLiteStatement;
  close(): void;
}

interface SQLiteConstructor {
  new (
    filename: string,
    options: { readonly: true; fileMustExist: true }
  ): ReadonlySQLiteDatabase;
}

interface TableColumn {
  name: string;
}

const CANDIDATE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;

export function legacyMnemosyneDigest(
  dbPath: string,
  entityId: number
): string {
  if (!Number.isInteger(entityId) || entityId < 0) {
    throw new Error("Legacy Mnemosyne entity id must be a non-negative integer");
  }
  const resolvedPath = path.resolve(dbPath);
  return createHash("sha256")
    .update(resolvedPath)
    .update("\0")
    .update(String(entityId))
    .digest("hex");
}

export async function migrateLegacyMnemosyne(
  dbPath: string,
  candidatesDir: string
): Promise<LegacyMnemosyneMigrationResult> {
  if (!dbPath.trim()) throw new Error("Legacy Mnemosyne dbPath is required");
  if (!candidatesDir.trim()) {
    throw new Error("Legacy Mnemosyne candidatesDir is required");
  }

  // Keep this import inside the explicit migration call. Do not replace it
  // with a top-level import: normal file-memory operation must not load SQLite.
  // The package is optional because fresh file-memory installations do not
  // need a database driver at all.
  let sqliteModule: { default: unknown };
  try {
    sqliteModule = await import("better-sqlite3");
  } catch {
    throw new Error(
      "Legacy migration requires the optional better-sqlite3 package. " +
      "Install it explicitly before calling migrateLegacyMnemosyne().",
    );
  }
  const Database = sqliteModule.default as unknown as SQLiteConstructor;
  const resolvedDbPath = path.resolve(dbPath);
  const databasePathDigest = createHash("sha256")
    .update(resolvedDbPath)
    .digest("hex");
  const db = new Database(resolvedDbPath, {
    readonly: true,
    fileMustExist: true,
  });

  try {
    const columns = readEntityColumns(db);
    const scanned = countEntities(db, columns);
    const rows = readEligibleEntities(db, columns);

    if (rows.length > 0) {
      fs.mkdirSync(candidatesDir, { recursive: true, mode: 0o700 });
    }

    const candidateIds: string[] = [];
    const createdFiles: string[] = [];
    let skipped = 0;

    for (const row of rows) {
      const digest = legacyMnemosyneDigest(resolvedDbPath, row.id);
      const candidateId = `legacy_mnemosyne_${digest}`;
      const fileName = `${digest}.json`;
      if (!CANDIDATE_FILE_PATTERN.test(fileName)) {
        throw new Error("Unsafe legacy migration candidate filename");
      }
      const filePath = path.join(candidatesDir, fileName);
      candidateIds.push(candidateId);
      if (fs.existsSync(filePath)) {
        skipped++;
        continue;
      }

      const candidate = toCandidate(
        row,
        digest,
        databasePathDigest,
        new Date().toISOString()
      );
      atomicWriteJson(filePath, candidate);
      createdFiles.push(filePath);
    }

    return {
      databasePathDigest,
      scanned,
      eligible: rows.length,
      created: createdFiles.length,
      skipped,
      candidateIds,
      createdFiles,
    };
  } finally {
    db.close();
  }
}

function readEntityColumns(db: ReadonlySQLiteDatabase): Set<string> {
  const rows = db.prepare("PRAGMA table_info(entities)").all() as TableColumn[];
  return new Set(rows.map((row) => row.name));
}

function countEntities(
  db: ReadonlySQLiteDatabase,
  columns: Set<string>
): number {
  if (!columns.has("id")) return 0;
  const row = db.prepare("SELECT COUNT(*) AS count FROM entities").get() as
    { count?: unknown } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

function readEligibleEntities(
  db: ReadonlySQLiteDatabase,
  columns: Set<string>
): LegacyEntityRow[] {
  const required = ["id", "name", "content"];
  if (required.some((column) => !columns.has(column))) return [];
  if (!columns.has("source") && !columns.has("protected")) return [];

  const select = [
    "id",
    columns.has("type") ? "type" : "'note' AS type",
    "name",
    "content",
    columns.has("source_session")
      ? "source_session"
      : "'' AS source_session",
    columns.has("source") ? "source" : "'' AS source",
    columns.has("protected") ? "protected" : "0 AS protected",
    columns.has("tags") ? "tags" : "'' AS tags",
    columns.has("created_at") ? "created_at" : "NULL AS created_at",
    columns.has("updated_at") ? "updated_at" : "NULL AS updated_at",
  ].join(", ");

  const manualClause = columns.has("source")
    ? "LOWER(COALESCE(source, '')) = 'manual'"
    : "0";
  const protectedClause = columns.has("protected")
    ? "COALESCE(protected, 0) = 1"
    : "0";
  const nonSeederClauses: string[] = [];
  if (columns.has("source")) {
    nonSeederClauses.push("LOWER(COALESCE(source, '')) <> 'seeder'");
  }
  const nonSeeder = nonSeederClauses.length > 0
    ? nonSeederClauses.join(" AND ")
    : "1";

  const rows = db.prepare(
    `SELECT ${select}
     FROM entities
     WHERE (${manualClause} OR ${protectedClause})
       AND ${nonSeeder}
     ORDER BY id ASC`
  ).all() as LegacyEntityRow[];

  return rows.filter((row) =>
    Number.isInteger(row.id)
    && row.id >= 0
    && typeof row.name === "string"
    && typeof row.content === "string"
  );
}

function toCandidate(
  row: LegacyEntityRow,
  digest: string,
  databasePathDigest: string,
  createdAt: string
): LegacyMnemosyneCandidate {
  const source = typeof row.source === "string" ? row.source : "";
  const title = row.name.trim() || `Legacy memory ${row.id}`;
  const body = row.content.trim() || title;
  return {
    schema: "rubato.memory.legacy-candidate/v1",
    candidate_id: `legacy_mnemosyne_${digest}`,
    state: "pending",
    operation: "CREATE",
    digest,
    created_at: createdAt,
    source: {
      kind: "mnemosyne_entity",
      database_path_digest: databasePathDigest,
      entity_id: row.id,
      entity_type: row.type || "note",
      legacy_source: source,
      source_session: row.source_session || "",
      protected: row.protected === 1,
      ...timestampField("legacy_created_at", row.created_at),
      ...timestampField("legacy_updated_at", row.updated_at),
    },
    proposed: {
      logical_key: `legacy.mnemosyne.${digest.slice(0, 32)}`,
      kind: legacyKind(row.type),
      scope: "global",
      status: "candidate",
      origin: "migrated",
      application: "reference",
      authority:
        source.toLocaleLowerCase() === "manual"
          ? "user_explicit"
          : "agent_derived",
      title,
      body,
      tags: parseLegacyTags(row.tags),
    },
  };
}

function timestampField(
  key: "legacy_created_at" | "legacy_updated_at",
  value: number | null
): Partial<Record<typeof key, string>> {
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? { [key]: date.toISOString() }
    : {};
}

function legacyKind(
  type: string
): LegacyMnemosyneCandidate["proposed"]["kind"] {
  if (type === "config") return "convention";
  if (type === "error") return "lesson";
  if (type === "deploy" || type === "test") return "workflow";
  return "note";
}

function parseLegacyTags(value: string): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(
    value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
  )].slice(0, 50);
}

function atomicWriteJson(
  filePath: string,
  candidate: LegacyMnemosyneCandidate
): void {
  const temporary = `${filePath}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify(candidate, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary, { force: true });
    }
  }
}
