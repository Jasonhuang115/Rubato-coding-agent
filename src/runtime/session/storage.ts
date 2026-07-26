// Session storage — JSONL persistence for session records
// Supports project-scoped storage (when projectHash is provided) with
// fallback to legacy flat ~/.rubato/sessions/ for sub-agents.

import fs from "fs";
import path from "path";
import { warnRecoverable } from "../../shared/diagnostics.js";
import type { SessionMeta, SessionRecord } from "../../shared/core-types.js";
import { redactValue } from "../../agent/subagents/redaction.js";

function getSessionDir(projectHash?: string): string {
  if (projectHash) {
    return path.join(process.env.HOME ?? "/tmp", ".rubato", "projects", projectHash, "sessions");
  }
  return path.join(process.env.HOME ?? "/tmp", ".rubato", "sessions");
}

export class SessionStore {
  private dir: string;
  private filePath: string;
  private initialized = false;
  private records: SessionRecord[] = [];

  constructor(sessionId: string, projectHash?: string) {
    this.dir = getSessionDir(projectHash);
    this.filePath = path.join(this.dir, `${sessionId}.jsonl`);
  }

  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.closeSync(fs.openSync(this.filePath, "a"));
    this.initialized = true;
  }

  append(record: SessionRecord): void {
    const safeRecord = redactValue(record) as SessionRecord;
    this.records.push(safeRecord);
    if (this.initialized) {
      fs.appendFileSync(this.filePath, JSON.stringify(safeRecord) + "\n", "utf-8");
    }
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
    this.initialized = false;
  }

  getRecords(): ReadonlyArray<SessionRecord> {
    return this.records;
  }

  getFilePath(): string {
    return this.filePath;
  }
}

// ---- Session loader (reads back JSONL) ----

export function loadSession(sessionId: string, baseDir?: string): SessionRecord[] {
  const dir = baseDir ?? path.join(process.env.HOME ?? "/tmp", ".rubato", "sessions");
  const filePath = path.join(dir, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const records: SessionRecord[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(redactValue(JSON.parse(trimmed)) as SessionRecord);
    } catch (error) {
      warnRecoverable(`session:${sessionId}:malformed-record`, error);
    }
  }

  return records;
}

export function listSessions(projectHash?: string): string[] {
  const dir = getSessionDir(projectHash);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(".jsonl", ""));
}
