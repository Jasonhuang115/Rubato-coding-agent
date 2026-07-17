// SessionManager — project-scoped session lifecycle
// Manages sessions.json index + JSONL transcripts per project

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { loadSession } from "./storage.js";

// ---- Types ----

export interface SessionRecord {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  firstMessage: string;
  model: string;
  messageCount: number;
  tokenCount: number;
  status: "active" | "ended";
  summary?: string;
}

// ---- Helpers ----

function hashProjectDir(workdir: string): string {
  // Simple hash: absolute path → safe directory name
  const abs = path.resolve(workdir);
  // Replace non-alphanumeric chars with dashes, collapse runs, trim to 64 chars
  return abs
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "root";
}

function getProjectBaseDir(projectHash: string): string {
  return path.join(os.homedir(), ".rubato", "projects", projectHash);
}

function getSessionsDir(projectHash: string): string {
  return path.join(getProjectBaseDir(projectHash), "sessions");
}

function getIndexPath(projectHash: string): string {
  return path.join(getProjectBaseDir(projectHash), "sessions.json");
}

// Atomic write: write to temp file then rename
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + randomUUID().slice(0, 8);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

// ---- SessionManager ----

export class SessionManager {
  readonly projectHash: string;
  private index: SessionRecord[] | null = null;

  constructor(projectDir: string) {
    this.projectHash = hashProjectDir(projectDir);
  }

  // ---- Index management ----

  private ensureDir(): void {
    fs.mkdirSync(getSessionsDir(this.projectHash), { recursive: true });
  }

  private loadIndex(): SessionRecord[] {
    if (this.index !== null) return this.index;
    this.ensureDir();
    const indexPath = getIndexPath(this.projectHash);
    try {
      if (fs.existsSync(indexPath)) {
        const raw = fs.readFileSync(indexPath, "utf-8");
        this.index = JSON.parse(raw) as SessionRecord[];
      } else {
        this.index = [];
      }
    } catch {
      this.index = [];
    }
    return this.index;
  }

  private saveIndex(): void {
    const indexPath = getIndexPath(this.projectHash);
    atomicWriteJson(indexPath, this.index ?? []);
  }

  // ---- CRUD ----

  createSession(firstMessage: string, model: string): SessionRecord {
    const sessions = this.loadIndex();
    const id = randomUUID();
    const record: SessionRecord = {
      id,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      firstMessage: firstMessage.slice(0, 200),
      model,
      messageCount: 0,
      tokenCount: 0,
      status: "active",
    };
    sessions.push(record);
    this.saveIndex();
    return record;
  }

  listSessions(): SessionRecord[] {
    return [...this.loadIndex()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  getSession(id: string): SessionRecord | undefined {
    return this.loadIndex().find((s) => s.id === id || s.id.startsWith(id));
  }

  updateSession(id: string, updates: Partial<SessionRecord>): void {
    const sessions = this.loadIndex();
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx >= 0) {
      sessions[idx] = { ...sessions[idx], ...updates, lastActiveAt: Date.now() };
      this.saveIndex();
    }
  }

  finalizeSession(id: string, tokenCount: number): void {
    const sessions = this.loadIndex();
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx >= 0) {
      sessions[idx] = {
        ...sessions[idx],
        status: "ended",
        tokenCount,
        lastActiveAt: Date.now(),
      };
      this.saveIndex();
    }
  }

  deleteSession(id: string): void {
    const sessions = this.loadIndex();
    this.index = sessions.filter((s) => s.id !== id);
    this.saveIndex();

    // Also remove transcript file
    const sessionPath = this.getSessionPath(id);
    try { fs.unlinkSync(sessionPath); } catch { /* best-effort */ }
  }

  // ---- Resume ----

  /** Load a session's transcript and produce a compact summary */
  loadSessionHistory(sessionId: string): string {
    const records = loadSession(sessionId, getSessionsDir(this.projectHash));
    if (records.length === 0) return "(empty session)";

    const parts: string[] = [];
    let userMessages = 0;
    let toolEvents = 0;

    for (const r of records) {
      if (r.type === "message") {
        const msg = r.data as { role?: string; content?: string };
        if (msg.role === "user" && msg.content) {
          userMessages++;
          if (userMessages <= 10) {
            parts.push(`User: ${(msg.content as string).slice(0, 300)}`);
          }
        }
      } else if (r.type === "tool_event") {
        toolEvents++;
        if (toolEvents <= 10) {
          const te = r.data as { tool?: string; result?: string; isError?: boolean };
          if (te.tool && te.result) {
            const status = te.isError ? "✖" : "✓";
            parts.push(`[${status} ${te.tool}] ${(te.result as string).slice(0, 200)}`);
          }
        }
      } else if (r.type === "session_meta") {
        const meta = r.data as { summary?: string };
        if (meta.summary) {
          parts.unshift(`Summary: ${meta.summary}`);
        }
      }
    }

    if (userMessages > 10) {
      parts.push(`... (${userMessages - 10} more user messages, ${Math.max(0, toolEvents - 10)} more tool events)`);
    }

    return parts.join("\n") || "(no content)";
  }

  resumeSession(id: string): { record: SessionRecord; summary: string } {
    const record = this.getSession(id);
    if (!record) {
      throw new Error(`Session "${id}" not found. Use /sessions to list available sessions.`);
    }
    const summary = this.loadSessionHistory(record.id);
    return { record, summary };
  }

  // ---- Paths ----

  getSessionPath(sessionId: string): string {
    return path.join(getSessionsDir(this.projectHash), `${sessionId}.jsonl`);
  }

  getProjectHash(): string {
    return this.projectHash;
  }

  // ---- Static helpers ----

  static findMostRecent(projectDir: string): SessionRecord | null {
    const mgr = new SessionManager(projectDir);
    const sessions = mgr.listSessions();
    return sessions.length > 0 ? sessions[0] : null;
  }

  static resolveProjectHash(workdir: string): string {
    return hashProjectDir(workdir);
  }
}
