#!/usr/bin/env node
// Offline entry point for the legacy Mnemosyne (SQLite) migration.
//
// This is a separate script on purpose. The CLI's dependency graph is asserted
// to contain no path to migration.ts or better-sqlite3 (test/no-rag-runtime.test.ts),
// so migration cannot be a slash command without weakening that guarantee.
// Running it produces review candidates only; it never publishes memory.
//
//   npm run migrate:legacy -- <path/to/memory.db> [output-candidates-dir]

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [dbPathArgument, outputArgument] = process.argv.slice(2);

if (!dbPathArgument || dbPathArgument === "--help" || dbPathArgument === "-h") {
  console.log(
    "Usage: npm run migrate:legacy -- <path/to/memory.db> [output-candidates-dir]\n\n" +
    "Reads the legacy database read-only and writes review candidates.\n" +
    "Nothing is published: inspect the candidates, then accept them in the CLI.",
  );
  process.exit(dbPathArgument ? 0 : 1);
}

const dbPath = path.resolve(dbPathArgument);
if (!fs.existsSync(dbPath)) {
  console.error(`No legacy database at ${dbPath}`);
  process.exit(1);
}

const candidatesDir = path.resolve(
  outputArgument ?? path.join(projectRoot, "legacy-migration-candidates"),
);
const migrationModule = path.join(projectRoot, "dist", "memory-files", "migration.js");
if (!fs.existsSync(migrationModule)) {
  console.error("Build the project first: npm run build");
  process.exit(1);
}

const { migrateLegacyMnemosyne } = await import(migrationModule);

try {
  const result = await migrateLegacyMnemosyne(dbPath, candidatesDir);
  console.log(`Migrated ${dbPath}`);
  console.log(`Review candidates written to ${candidatesDir}`);
  console.log(JSON.stringify(result, null, 2));
  console.log(
    "\nThese are candidates only. Review them, then use /profile correct or " +
    "/remember in the CLI to publish anything worth keeping.",
  );
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
