// Session storage — append-only, hash-chained JSONL session records.
// Sessions are always project-scoped under the canonical project SHA-256.

import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { warnRecoverable } from "../../shared/diagnostics.js";
import type { SessionMeta, SessionRecord } from "../../shared/core-types.js";
import { redactValue } from "../../agent/subagents/redaction.js";
import { getRubatoHome } from "../../shared/rubato-home.js";

export type SessionEventType = SessionRecord["type"] | "session_closed";

const SESSION_EVENT_TYPES = new Set<SessionEventType>([
  "session_meta",
  "message",
  "tool_event",
  "compaction",
  "session_closed",
]);

export interface StoredSessionRecord {
  type: SessionEventType;
  timestamp: number;
  data: unknown;
  event_id: string;
  seq: number;
  prev_hash: string | null;
  hash: string;
}

export interface SessionVerificationResult {
  valid: boolean;
  closed: boolean;
  recordCount: number;
  lastHash?: string;
  error?: string;
}

function getSessionDir(projectHash: string): string {
  return path.join(getRubatoHome(), "projects", projectHash, "sessions");
}

export class SessionStore {
  private dir: string;
  private filePath: string;
  private initialized = false;
  private closed = false;
  private nextSeq = 0;
  private previousHash: string | null = null;
  private records: StoredSessionRecord[] = [];

  constructor(sessionId: string, projectHash: string) {
    if (!/^[a-f0-9]{64}$/.test(projectHash)) {
      throw new Error("SessionStore requires a canonical SHA-256 project ID.");
    }
    this.dir = getSessionDir(projectHash);
    this.filePath = path.join(this.dir, `${sessionId}.jsonl`);
  }

  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.closeSync(fs.openSync(this.filePath, "a"));
    repairIncompleteTail(this.filePath);
    const existing = readStrictSessionFile(this.filePath);
    if (existing.length > 0) {
      const verification = verifyRecords(existing);
      if (!verification.valid) {
        throw new Error(
          `Cannot append to invalid session chain "${this.filePath}": ${verification.error ?? "verification failed"}`,
        );
      }
      if (verification.closed) {
        throw new Error(`Cannot append to closed session "${this.filePath}"`);
      }
      this.records = existing;
      this.nextSeq = existing.length;
      this.previousHash = existing.at(-1)?.hash ?? null;
    }
    this.initialized = true;
  }

  append(record: SessionRecord): StoredSessionRecord | undefined {
    return this.appendEvent(record);
  }

  private appendEvent(
    record: Omit<StoredSessionRecord, "event_id" | "seq" | "prev_hash" | "hash">,
  ): StoredSessionRecord | undefined {
    if (this.closed) {
      throw new Error(`Cannot append to closed session "${this.filePath}"`);
    }
    const safeRecord = redactValue(record) as Pick<StoredSessionRecord, "type" | "timestamp" | "data">;
    const unsigned = {
      type: safeRecord.type,
      timestamp: safeRecord.timestamp,
      data: safeRecord.data,
      event_id: randomUUID(),
      seq: this.nextSeq,
      prev_hash: this.previousHash,
    };
    const stored: StoredSessionRecord = {
      ...unsigned,
      hash: hashRecord(unsigned),
    };
    this.records.push(stored);
    if (this.initialized) {
      fs.appendFileSync(this.filePath, JSON.stringify(stored) + "\n", "utf-8");
    }
    this.nextSeq++;
    this.previousHash = stored.hash;
    return stored;
  }

  writeMeta(meta: SessionMeta): StoredSessionRecord | undefined {
    return this.append({
      type: "session_meta",
      timestamp: Date.now(),
      data: meta,
    });
  }

  writeMessage(message: unknown): StoredSessionRecord | undefined {
    return this.append({
      type: "message",
      timestamp: Date.now(),
      data: message,
    });
  }

  writeToolEvent(event: unknown): StoredSessionRecord | undefined {
    return this.append({
      type: "tool_event",
      timestamp: Date.now(),
      data: event,
    });
  }

  writeCompaction(summary: unknown): StoredSessionRecord | undefined {
    return this.append({
      type: "compaction",
      timestamp: Date.now(),
      data: summary,
    });
  }

  close(): void {
    if (!this.initialized || this.closed) {
      return;
    }
    this.appendEvent({
      type: "session_closed",
      timestamp: Date.now(),
      data: { event_count: this.nextSeq },
    });
    this.closed = true;
    this.initialized = false;
  }

  getRecords(): ReadonlyArray<StoredSessionRecord> {
    return this.records;
  }

  getFilePath(): string {
    return this.filePath;
  }

}

// ---- Session loader (reads back JSONL) ----

export function loadSession(sessionId: string, baseDir: string): StoredSessionRecord[] {
  const filePath = path.join(baseDir, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const records: StoredSessionRecord[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(redactValue(JSON.parse(trimmed)) as StoredSessionRecord);
    } catch (error) {
      warnRecoverable(`session:${sessionId}:malformed-record`, error);
    }
  }

  return records;
}

export function verifySession(
  sessionId: string,
  baseDir: string,
): SessionVerificationResult {
  const filePath = path.join(baseDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) {
    return {
      valid: false,
      closed: false,
      recordCount: 0,
      error: `Session file not found: ${filePath}`,
    };
  }

  try {
    return verifyRecords(readStrictSessionFile(filePath));
  } catch (error) {
    return {
      valid: false,
      closed: false,
      recordCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function hashRecord(record: Omit<StoredSessionRecord, "hash">): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function readStrictSessionFile(filePath: string): StoredSessionRecord[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const records: StoredSessionRecord[] = [];
  const lines = content.split("\n");
  let lineNumber = 0;
  for (const [index, line] of lines.entries()) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as StoredSessionRecord);
    } catch (error) {
      if (index === lines.length - 1 && !content.endsWith("\n")) {
        warnRecoverable(`session:${path.basename(filePath)}:incomplete-tail`, error);
        break;
      }
      throw new Error(
        `Malformed JSONL record at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return records;
}

function repairIncompleteTail(filePath: string): void {
  const content = fs.readFileSync(filePath, "utf8");
  if (!content || content.endsWith("\n")) return;
  const newline = content.lastIndexOf("\n");
  const tail = content.slice(newline + 1).trim();
  if (!tail) return;
  try {
    JSON.parse(tail);
  } catch (error) {
    fs.truncateSync(filePath, newline + 1);
    warnRecoverable(`session:${path.basename(filePath)}:truncated-tail`, error);
  }
}

function verifyRecords(records: StoredSessionRecord[]): SessionVerificationResult {
  let previousHash: string | null = null;
  let closed = false;
  const eventIds = new Set<string>();

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!isStoredSessionRecord(record)) {
      return invalidResult(records, closed, `Record ${index} is missing chain metadata`);
    }
    if (record.seq !== index) {
      return invalidResult(records, closed, `Record ${index} has seq ${record.seq}; expected ${index}`);
    }
    if (record.prev_hash !== previousHash) {
      return invalidResult(records, closed, `Record ${index} has an invalid prev_hash`);
    }
    if (eventIds.has(record.event_id)) {
      return invalidResult(records, closed, `Record ${index} reuses event_id "${record.event_id}"`);
    }
    eventIds.add(record.event_id);

    const { hash, ...unsigned } = record;
    const expectedHash = hashRecord(unsigned);
    if (hash !== expectedHash) {
      return invalidResult(records, closed, `Record ${index} has an invalid hash`);
    }

    if (record.type === "session_closed") {
      if (index !== records.length - 1) {
        return invalidResult(records, true, "session_closed must be the final record");
      }
      const data = record.data as { event_count?: unknown } | null;
      if (!data || data.event_count !== index) {
        return invalidResult(records, true, "session_closed has an invalid event_count");
      }
      closed = true;
    }
    previousHash = hash;
  }

  return {
    valid: true,
    closed,
    recordCount: records.length,
    ...(previousHash ? { lastHash: previousHash } : {}),
  };
}

function invalidResult(
  records: StoredSessionRecord[],
  closed: boolean,
  error: string,
): SessionVerificationResult {
  return {
    valid: false,
    closed,
    recordCount: records.length,
    error,
  };
}

function isStoredSessionRecord(value: unknown): value is StoredSessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredSessionRecord>;
  return (
    SESSION_EVENT_TYPES.has(record.type as SessionEventType) &&
    typeof record.timestamp === "number" &&
    typeof record.event_id === "string" &&
    record.event_id.length > 0 &&
    typeof record.seq === "number" &&
    Number.isInteger(record.seq) &&
    (record.prev_hash === null || typeof record.prev_hash === "string") &&
    typeof record.hash === "string" &&
    /^[a-f0-9]{64}$/.test(record.hash)
  );
}
