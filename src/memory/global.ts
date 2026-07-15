// Global Memory — cross-project knowledge graph
// Stores user preferences, common patterns, and lessons learned
// Path: ~/.coding-agent/global/memory.db

import { MnemosyneStore } from "./store.js";
import path from "path";

let globalStore: MnemosyneStore | null = null;

export function getGlobalStore(): MnemosyneStore {
  if (!globalStore) {
    const dir = process.env.HOME ?? "/tmp";
    const dbPath = path.join(dir, ".coding-agent", "global", "memory.db");
    globalStore = new MnemosyneStore(dbPath);
  }
  return globalStore;
}

export function closeGlobalStore(): void {
  if (globalStore) {
    globalStore.close();
    globalStore = null;
  }
}

// ---- Global memory operations ----

/** Record a user preference (tech stack, naming, tool choices) */
export function recordPreference(
  key: string,
  value: string,
  sessionId: string
): number {
  const store = getGlobalStore();
  return store.upsertEntity(
    key,
    "config",
    value,
    sessionId,
    0.9
  );
}

/** Record a lesson learned across projects */
export function recordLesson(
  title: string,
  lesson: string,
  sessionId: string,
  tags: string[] = []
): number {
  const store = getGlobalStore();
  const content = tags.length > 0 ? `${lesson}\nTags: ${tags.join(", ")}` : lesson;
  return store.upsertEntity(
    title,
    "note",
    content,
    sessionId,
    0.8
  );
}

/** Record a recurring error pattern and its fix */
export function recordErrorPattern(
  errorSignature: string,
  fix: string,
  sessionId: string
): number {
  const store = getGlobalStore();
  const errorId = store.upsertEntity(
    errorSignature,
    "error",
    "",
    sessionId,
    0.7
  );
  const fixId = store.upsertEntity(
    fix,
    "concept",
    "",
    sessionId,
    0.7
  );
  store.addRelation(errorId, fixId, "FIXED_BY", 1.0, errorSignature);
  return errorId;
}

/** Search global memory for relevant patterns */
export function searchGlobal(query: string, limit = 5): Array<{
  content: string;
  relevance: number;
}> {
  const store = getGlobalStore();
  const results = store.searchWithRelevance(query, limit);
  return results.map(({ entity, relevance }) => ({
    content: `${entity.name}: ${entity.content}`,
    relevance,
  }));
}

/** Get user preferences as key-value pairs */
export function getUserPreferences(): Array<{ key: string; value: string }> {
  const store = getGlobalStore();
  const configs = store.getByType("config", 100);
  return configs.map((c) => ({ key: c.name, value: c.content }));
}

/** Get recent lessons learned (cross-project) */
export function getRecentLessons(limit = 10): Array<{ title: string; lesson: string }> {
  const store = getGlobalStore();
  const notes = store.getByType("note", limit);
  return notes.map((n) => ({ title: n.name, lesson: n.content }));
}
