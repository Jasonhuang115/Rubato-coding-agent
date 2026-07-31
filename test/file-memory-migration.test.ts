import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type MigrationModule = typeof import("../src/memory-files/migration.js");

async function loadMigration(): Promise<MigrationModule> {
  return import("../src/memory-files/migration.js");
}

function fileDigest(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createLegacyDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = DELETE");
  db.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      source_session TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'auto',
      protected INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 1,
      created_at INTEGER,
      updated_at INTEGER,
      embedding BLOB,
      feedback_score REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE feedback_log (
      id INTEGER PRIMARY KEY,
      memory_id INTEGER,
      score_delta REAL,
      context TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO entities (
      id, type, name, content, source_session, source, protected, tags,
      confidence, created_at, updated_at, embedding, feedback_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const at = Date.parse("2026-01-01T00:00:00.000Z");
  insert.run(
    1,
    "note",
    "Manual preference",
    "Use concise answers",
    "session-manual",
    "manual",
    0,
    "style, concise",
    0.99,
    at,
    at,
    Buffer.from("must-not-migrate"),
    42
  );
  insert.run(
    2,
    "config",
    "Protected convention",
    "Use pnpm in this project",
    "session-protected",
    "auto",
    1,
    "pnpm,workflow",
    0.75,
    at,
    at,
    Buffer.from("must-not-migrate"),
    -9
  );
  insert.run(
    3,
    "concept",
    "Seeder project scan",
    "Generated from package.json",
    "seeder",
    "seeder",
    1,
    "generated",
    1,
    at,
    at,
    Buffer.from("seed-vector"),
    100
  );
  insert.run(
    4,
    "error",
    "Automatic extraction",
    "An unprotected automatic observation",
    "session-auto",
    "auto",
    0,
    "auto",
    1,
    at,
    at,
    Buffer.from("auto-vector"),
    100
  );
  db.prepare(
    "INSERT INTO feedback_log (id, memory_id, score_delta, context) VALUES (?, ?, ?, ?)"
  ).run(1, 1, 99, JSON.stringify({ secretFeedback: true }));
  db.close();
}

describe("explicit legacy Mnemosyne migration", () => {
  let root = "";
  let dbPath = "";
  let candidatesDir = "";
  let previousRubatoHome: string | undefined;

  beforeEach(() => {
    previousRubatoHome = process.env.RUBATO_HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-migration-"));
    dbPath = path.join(root, "legacy.db");
    candidatesDir = path.join(root, "pending-candidates");
    process.env.RUBATO_HOME = root;
  });

  afterEach(() => {
    if (previousRubatoHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousRubatoHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not open or create a default memory.db merely by importing", async () => {
    const defaultDb = path.join(root, "memory.db");
    fs.writeFileSync(defaultDb, "not a sqlite database", "utf8");
    const before = fs.readFileSync(defaultDb, "utf8");

    const migration = await loadMigration();

    expect(typeof migration.migrateLegacyMnemosyne).toBe("function");
    expect(fs.readFileSync(defaultDb, "utf8")).toBe(before);
    expect(fs.existsSync(candidatesDir)).toBe(false);
  });

  it("migrates only manual or protected non-seeder rows as pending candidates", async () => {
    createLegacyDatabase(dbPath);
    const beforeDigest = fileDigest(dbPath);
    const { migrateLegacyMnemosyne } = await loadMigration();

    const result = await migrateLegacyMnemosyne(dbPath, candidatesDir);

    expect(result).toMatchObject({
      scanned: 4,
      eligible: 2,
      created: 2,
      skipped: 0,
    });
    expect(result.candidateIds).toHaveLength(2);
    expect(result.createdFiles).toHaveLength(2);
    expect(fileDigest(dbPath)).toBe(beforeDigest);

    const files = fs.readdirSync(candidatesDir);
    expect(files).toHaveLength(2);
    expect(files.every((file) => /^[a-f0-9]{64}\.json$/.test(file))).toBe(true);

    const candidates = files.map((file) =>
      JSON.parse(
        fs.readFileSync(path.join(candidatesDir, file), "utf8")
      ) as Record<string, unknown>
    );
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        schema: "rubato.memory.legacy-candidate/v1",
        state: "pending",
        operation: "CREATE",
        source: expect.objectContaining({
          entity_id: 1,
          legacy_source: "manual",
        }),
        proposed: expect.objectContaining({
          title: "Manual preference",
          body: "Use concise answers",
          status: "candidate",
          origin: "migrated",
          authority: "user_explicit",
          tags: ["style", "concise"],
        }),
      }),
      expect.objectContaining({
        source: expect.objectContaining({
          entity_id: 2,
          legacy_source: "auto",
          protected: true,
        }),
        proposed: expect.objectContaining({
          title: "Protected convention",
          kind: "convention",
          authority: "agent_derived",
        }),
      }),
    ]));

    for (const file of files) {
      const serialized = fs.readFileSync(
        path.join(candidatesDir, file),
        "utf8"
      );
      expect(serialized).not.toContain("embedding");
      expect(serialized).not.toContain("feedback");
      expect(serialized).not.toContain("must-not-migrate");
      expect(serialized).not.toContain("secretFeedback");
      expect(fs.statSync(path.join(candidatesDir, file)).mode & 0o777)
        .toBe(0o600);
    }
  });

  it("is idempotent by the digest of database path and entity id", async () => {
    createLegacyDatabase(dbPath);
    const {
      legacyMnemosyneDigest,
      migrateLegacyMnemosyne,
    } = await loadMigration();

    const first = await migrateLegacyMnemosyne(dbPath, candidatesDir);
    const second = await migrateLegacyMnemosyne(dbPath, candidatesDir);

    expect(first.created).toBe(2);
    expect(second).toMatchObject({
      eligible: 2,
      created: 0,
      skipped: 2,
    });
    expect(second.candidateIds).toEqual(first.candidateIds);
    expect(fs.readdirSync(candidatesDir)).toHaveLength(2);
    expect(legacyMnemosyneDigest(dbPath, 1))
      .not.toBe(legacyMnemosyneDigest(dbPath, 2));
    expect(first.candidateIds[0])
      .toBe(`legacy_mnemosyne_${legacyMnemosyneDigest(dbPath, 1)}`);
  });

  it("does not create a database or candidate directory for a missing path", async () => {
    const { migrateLegacyMnemosyne } = await loadMigration();
    const missing = path.join(root, "missing.db");

    await expect(
      migrateLegacyMnemosyne(missing, candidatesDir)
    ).rejects.toThrow();
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(candidatesDir)).toBe(false);
  });
});
