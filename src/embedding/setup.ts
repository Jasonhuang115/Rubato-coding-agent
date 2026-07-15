// Embedding infrastructure — ONNX model download + sqlite-vec schema
// Phase 1: Scaffold only. Phase 2: Full Mnemosyne integration.

import fs from "fs";
import path from "path";

const MODEL_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".coding-agent",
  "models"
);

const MODEL_NAME = "all-MiniLM-L6-v2";
const MODEL_URL =
  "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx";

export async function setupEmbeddingInfrastructure(): Promise<{
  ready: boolean;
  reason?: string;
}> {
  // Phase 1: Check if the model exists, but don't auto-download
  // Phase 2: Auto-download with progress, use @xenova/transformers

  const modelDir = path.join(MODEL_DIR, MODEL_NAME);
  const modelPath = path.join(modelDir, "model.onnx");

  if (fs.existsSync(modelPath)) {
    return { ready: true };
  }

  return {
    ready: false,
    reason:
      `Embedding model not found at ${modelPath}. ` +
      `In Phase 2, the model will be auto-downloaded from ${MODEL_URL}. ` +
      `Mnemosyne features are disabled for now.`,
  };
}

export function getModelDir(): string {
  return path.join(MODEL_DIR, MODEL_NAME);
}

// ---- sqlite-vec schema (for Phase 2 Mnemosyne) ----

export const MEMORY_SCHEMA_SQL = `
-- Mnemosyne memory graph schema (Phase 2)
-- Phase 1: Schema is defined but tables are created lazily

CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,  -- 'fact', 'feedback', 'reference', 'project'
  content TEXT NOT NULL,
  source TEXT,         -- session_id that created this entry
  timestamp INTEGER NOT NULL,
  embedding BLOB       -- 384-dim float32 vector (all-MiniLM-L6-v2)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
  embedding float[384]
);

CREATE TABLE IF NOT EXISTS memory_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES memory_entries(id),
  target_id INTEGER NOT NULL REFERENCES memory_entries(id),
  relation TEXT NOT NULL,  -- 'relates_to', 'contradicts', 'extends', 'depends_on'
  weight REAL DEFAULT 1.0,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);
CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_entries(source);
CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_id);
`;

export function getMemoryDBPath(): string {
  const dir = path.join(process.env.HOME ?? "/tmp", ".coding-agent");
  return path.join(dir, "mnemosyne.db");
}
