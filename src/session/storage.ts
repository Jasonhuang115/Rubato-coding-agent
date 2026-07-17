// Session storage — JSONL persistence for session records
// Supports project-scoped storage (when projectHash is provided) with
// fallback to legacy flat ~/.rubato/sessions/ for sub-agents.

import fs from "fs";
import path from "path";
import type { SessionMeta, SessionRecord } from "../core-types.js";

function getSessionDir(projectHash?: string): string {
  if (projectHash) {
    return path.join(process.env.HOME ?? "/tmp", ".rubato", "projects", projectHash, "sessions");
  }
  return path.join(process.env.HOME ?? "/tmp", ".rubato", "sessions");
}

export class SessionStore {
  private dir: string;
  private filePath: string;
  private writeStream: fs.WriteStream | null = null;
  private records: SessionRecord[] = [];

  constructor(sessionId: string, projectHash?: string) {
    this.dir = getSessionDir(projectHash);
    this.filePath = path.join(this.dir, `${sessionId}.jsonl`);
  }

  init(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    // Open write stream in append mode
    this.writeStream = fs.createWriteStream(this.filePath, { flags: "a" });
  }

  append(record: SessionRecord): void {
    this.records.push(record);
    if (this.writeStream) {
      this.writeStream.write(JSON.stringify(record) + "\n");
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
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
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
      records.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
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
