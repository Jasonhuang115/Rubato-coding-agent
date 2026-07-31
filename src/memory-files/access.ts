import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

export type MemoryAccessAction = "search" | "read";

export interface MemoryAccessEvent {
  schema: "rubato.memory.access/v1";
  event_id: string;
  recorded_at: string;
  session_id: string;
  action: MemoryAccessAction;
  release_id: string;
  memory_ids: string[];
}

export interface MemoryAccessSummary {
  memory_id: string;
  access_count: number;
  search_count: number;
  read_count: number;
  last_accessed_at: string;
}

interface LocatedMemoryPath {
  memoryRoot: string;
  releaseId: string;
  cardId?: string;
  isCatalog: boolean;
}

/**
 * Record grep/read telemetry without touching a card, confidence score, or
 * release. Access is usage evidence only; it is never belief evidence.
 */
export function recordMemoryFileAccess(input: {
  sessionId: string;
  action: MemoryAccessAction;
  filePath: string;
  output?: string;
}): MemoryAccessEvent | null {
  const located = locateVerifiedMemoryPath(input.filePath);
  if (!located || !input.sessionId.trim()) return null;
  const ids = new Set<string>();
  if (located.cardId) ids.add(located.cardId);
  for (const id of extractMemoryIds(input.output ?? "")) ids.add(id);
  if (ids.size === 0) return null;

  const event: MemoryAccessEvent = {
    schema: "rubato.memory.access/v1",
    event_id: `access_${randomUUID()}`,
    recorded_at: new Date().toISOString(),
    session_id: input.sessionId.trim().slice(0, 200),
    action: input.action,
    release_id: located.releaseId,
    memory_ids: [...ids].sort(),
  };
  const filePath = path.join(located.memoryRoot, "access.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return event;
}

export function listMemoryAccessEvents(memoryRoot: string): MemoryAccessEvent[] {
  const filePath = path.join(path.resolve(memoryRoot), "access.jsonl");
  if (!fs.existsSync(filePath)) return [];
  const events: MemoryAccessEvent[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<MemoryAccessEvent>;
      if (
        parsed.schema !== "rubato.memory.access/v1" ||
        typeof parsed.event_id !== "string" ||
        typeof parsed.recorded_at !== "string" ||
        typeof parsed.session_id !== "string" ||
        (parsed.action !== "search" && parsed.action !== "read") ||
        typeof parsed.release_id !== "string" ||
        !Array.isArray(parsed.memory_ids) ||
        parsed.memory_ids.some((id) => typeof id !== "string")
      ) {
        continue;
      }
      events.push(parsed as MemoryAccessEvent);
    } catch {
      // Ignore a partial final append. Access telemetry is not a truth source.
    }
  }
  return events;
}

export function sessionMemoryAccess(
  memoryRoot: string,
  sessionId: string,
): { searched: string[]; read: string[] } {
  const searched = new Set<string>();
  const read = new Set<string>();
  for (const event of listMemoryAccessEvents(memoryRoot)) {
    if (event.session_id !== sessionId) continue;
    const target = event.action === "read" ? read : searched;
    event.memory_ids.forEach((id) => target.add(id));
  }
  return {
    searched: [...searched].sort(),
    read: [...read].sort(),
  };
}

export function summarizeMemoryAccess(
  events: MemoryAccessEvent[],
): MemoryAccessSummary[] {
  const summaries = new Map<string, MemoryAccessSummary>();
  for (const event of events) {
    for (const id of event.memory_ids) {
      const previous = summaries.get(id);
      const next: MemoryAccessSummary = previous ?? {
        memory_id: id,
        access_count: 0,
        search_count: 0,
        read_count: 0,
        last_accessed_at: event.recorded_at,
      };
      next.access_count++;
      if (event.action === "read") next.read_count++;
      else next.search_count++;
      if (event.recorded_at > next.last_accessed_at) {
        next.last_accessed_at = event.recorded_at;
      }
      summaries.set(id, next);
    }
  }
  return [...summaries.values()].sort((left, right) =>
    right.access_count - left.access_count ||
    left.memory_id.localeCompare(right.memory_id));
}

function locateVerifiedMemoryPath(filePath: string): LocatedMemoryPath | null {
  const absolute = path.resolve(filePath);
  const parts = absolute.split(path.sep);
  const memoryIndex = parts.lastIndexOf("memory");
  const releasesIndex = parts.lastIndexOf("releases");
  if (
    memoryIndex < 0 ||
    releasesIndex <= memoryIndex ||
    releasesIndex + 2 >= parts.length
  ) {
    return null;
  }
  const releaseId = parts[releasesIndex + 1];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(releaseId)) return null;
  const relative = parts.slice(releasesIndex + 2);
  const cardMatch = relative.join("/").match(
    /^cards\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\.md$/u,
  );
  const isCatalog = relative.join("/") === "catalog.tsv";
  const isCardsDirectory = relative.join("/") === "cards";
  if (!cardMatch && !isCatalog && !isCardsDirectory) return null;
  return {
    memoryRoot: parts.slice(0, memoryIndex + 1).join(path.sep) || path.sep,
    releaseId,
    ...(cardMatch ? { cardId: cardMatch[1] } : {}),
    isCatalog,
  };
}

function extractMemoryIds(output: string): string[] {
  const ids = new Set<string>();
  for (const match of output.matchAll(
    /(?:^|[\\/])cards[\\/]([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\.md(?=[:\s]|$)/gmu,
  )) {
    ids.add(match[1]);
  }
  for (const line of output.split(/\r?\n/u)) {
    const catalog = line.match(
      /catalog\.tsv:\d+:([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\t/u,
    );
    if (catalog) ids.add(catalog[1]);
  }
  return [...ids];
}
