// Session storage — append-only, hash-chained JSONL session records.
// Supports project-scoped storage (when projectHash is provided) with
// fallback to legacy flat ~/.rubato/sessions/ for sub-agents.

import { createHash, randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { warnRecoverable } from "../../shared/diagnostics.js";
import type { SessionMeta, SessionRecord } from "../../shared/core-types.js";
import { redactValue } from "../../agent/subagents/redaction.js";
import { isMemorySessionPurged } from "../../memory-files/release.js";

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

function getRubatoHome(): string {
  return path.resolve(process.env.RUBATO_HOME ?? path.join(os.homedir(), ".rubato"));
}

function getSessionDir(projectHash?: string): string {
  if (projectHash) {
    return path.join(getRubatoHome(), "projects", projectHash, "sessions");
  }
  return path.join(getRubatoHome(), "sessions");
}

export class SessionStore {
  private readonly sessionId: string;
  private readonly projectHash?: string;
  private dir: string;
  private filePath: string;
  private initialized = false;
  private closed = false;
  private persistenceDisabled = false;
  private nextSeq = 0;
  private previousHash: string | null = null;
  private records: StoredSessionRecord[] = [];

  constructor(sessionId: string, projectHash?: string) {
    this.sessionId = sessionId;
    this.projectHash = projectHash;
    this.dir = getSessionDir(projectHash);
    this.filePath = path.join(this.dir, `${sessionId}.jsonl`);
  }

  init(): void {
    if (this.refreshPurgeTombstone()) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.closeSync(fs.openSync(this.filePath, "a"));
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

  append(record: SessionRecord): void {
    this.appendEvent(record);
  }

  private appendEvent(record: Omit<StoredSessionRecord, "event_id" | "seq" | "prev_hash" | "hash">): void {
    if (this.refreshPurgeTombstone()) return;
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
  }

  writeMeta(meta: SessionMeta): void {
    this.append({
      type: "session_meta",
      timestamp: Date.now(),
      data: meta,
    });
  }

  writeMessage(message: unknown): void {
    this.append({
      type: "message",
      timestamp: Date.now(),
      data: message,
    });
  }

  writeToolEvent(event: unknown): void {
    this.append({
      type: "tool_event",
      timestamp: Date.now(),
      data: event,
    });
  }

  writeCompaction(summary: unknown): void {
    this.append({
      type: "compaction",
      timestamp: Date.now(),
      data: summary,
    });
  }

  close(): void {
    if (this.refreshPurgeTombstone() || !this.initialized || this.closed) {
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

  /**
   * A purge may happen while this process still holds a live SessionStore.
   * Re-reading the durable fingerprint before every append prevents that
   * process from recreating a physically deleted transcript.
   */
  private refreshPurgeTombstone(): boolean {
    if (this.persistenceDisabled) return true;
    try {
      if (
        !isMemorySessionPurged(
          getRubatoHome(),
          this.sessionId,
          this.projectHash,
        )
      ) {
        return false;
      }
    } catch (error) {
      // A malformed privacy ledger cannot be treated as permission to write.
      warnRecoverable(
        `session:${this.sessionId}:purge-ledger-fail-closed`,
        error,
      );
    }
    this.persistenceDisabled = true;
    this.initialized = false;
    this.closed = true;
    this.records = [];
    this.nextSeq = 0;
    this.previousHash = null;
    return true;
  }
}

// ---- Session loader (reads back JSONL) ----

export function loadSession(sessionId: string, baseDir?: string): StoredSessionRecord[] {
  const dir = baseDir ?? path.join(getRubatoHome(), "sessions");
  const filePath = path.join(dir, `${sessionId}.jsonl`);

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
  baseDir?: string,
): SessionVerificationResult {
  const dir = baseDir ?? path.join(getRubatoHome(), "sessions");
  const filePath = path.join(dir, `${sessionId}.jsonl`);
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

export const verifySessionChain = verifySession;

export function listSessions(projectHash?: string): string[] {
  const dir = getSessionDir(projectHash);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(".jsonl", ""));
}

function hashRecord(record: Omit<StoredSessionRecord, "hash">): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function readStrictSessionFile(filePath: string): StoredSessionRecord[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const records: StoredSessionRecord[] = [];
  let lineNumber = 0;
  for (const line of content.split("\n")) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as StoredSessionRecord);
    } catch (error) {
      throw new Error(
        `Malformed JSONL record at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return records;
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
