// Session storage — JSONL persistence for session records

import fs from "fs";
import path from "path";
import type { SessionMeta, SessionRecord } from "../core-types.js";

export class SessionStore {
  private dir: string;
  private filePath: string;
  private writeStream: fs.WriteStream | null = null;
  private records: SessionRecord[] = [];

  constructor(sessionId: string, baseDir?: string) {
    this.dir = baseDir ?? path.join(process.env.HOME ?? "/tmp", ".coding-agent", "sessions");
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
  const dir = baseDir ?? path.join(process.env.HOME ?? "/tmp", ".coding-agent", "sessions");
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

export function listSessions(baseDir?: string): string[] {
  const dir = baseDir ?? path.join(process.env.HOME ?? "/tmp", ".coding-agent", "sessions");
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(".jsonl", ""));
}
