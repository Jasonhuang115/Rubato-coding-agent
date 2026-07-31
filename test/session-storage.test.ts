import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionStore,
  loadSession,
  verifySession,
} from "../src/runtime/session/storage.js";
import { SessionManager } from "../src/runtime/session/manager.js";
import {
  purgeMemories,
  readCurrentReleaseId,
} from "../src/memory-files/release.js";
import { resolveMemoryScopePaths } from "../src/memory-files/paths.js";

describe("hash-chained session storage", () => {
  let tempDir: string;
  let previousRubatoHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-session-store-"));
    previousRubatoHome = process.env.RUBATO_HOME;
    process.env.RUBATO_HOME = path.join(tempDir, ".rubato");
  });

  afterEach(() => {
    if (previousRubatoHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousRubatoHome;
    makeWritable(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds chain metadata and seals the session with session_closed", () => {
    const store = new SessionStore("session-1", "project-1");
    store.init();
    store.writeMessage({ role: "user", content: "hello" });
    store.writeToolEvent({ tool: "Read", result: "ok" });
    store.close();
    store.close();

    const records = loadSession(
      "session-1",
      path.dirname(store.getFilePath()),
    );
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2]);
    expect(records[0].prev_hash).toBeNull();
    expect(records[1].prev_hash).toBe(records[0].hash);
    expect(records[2].prev_hash).toBe(records[1].hash);
    expect(new Set(records.map((record) => record.event_id)).size).toBe(3);
    expect(records.every((record) => /^[a-f0-9]{64}$/.test(record.hash))).toBe(true);
    expect(records[2]).toMatchObject({
      type: "session_closed",
      data: { event_count: 2 },
    });

    expect(verifySession("session-1", path.dirname(store.getFilePath()))).toMatchObject({
      valid: true,
      closed: true,
      recordCount: 3,
      lastHash: records[2].hash,
    });
  });

  it("detects a modified record", () => {
    const store = new SessionStore("session-2", "project-1");
    store.init();
    store.writeMessage({ role: "user", content: "original" });
    store.close();

    const lines = fs.readFileSync(store.getFilePath(), "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]) as {
      data: { content: string };
    };
    first.data.content = "tampered";
    lines[0] = JSON.stringify(first);
    fs.writeFileSync(store.getFilePath(), `${lines.join("\n")}\n`, "utf8");

    const result = verifySession("session-2", path.dirname(store.getFilePath()));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("invalid hash");
  });

  it("continues an open valid chain but refuses a closed chain", () => {
    const first = new SessionStore("session-3", "project-1");
    first.init();
    first.writeMessage({ role: "user", content: "first" });

    const resumed = new SessionStore("session-3", "project-1");
    resumed.init();
    resumed.writeMessage({ role: "assistant", content: "second" });
    resumed.close();

    const records = loadSession("session-3", path.dirname(resumed.getFilePath()));
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2]);
    expect(() => new SessionStore("session-3", "project-1").init()).toThrow(
      "Cannot append to closed session",
    );
  });

  it("does not recreate a live session after a privacy tombstone", () => {
    const projectId = "project-privacy";
    const sessionId = "session-purged-live";
    const store = new SessionStore(sessionId, projectId);
    store.init();
    store.writeMessage({ role: "user", content: "forget this value" });
    const sessionPath = store.getFilePath();
    expect(fs.existsSync(sessionPath)).toBe(true);

    const paths = resolveMemoryScopePaths({
      rootDir: process.env.RUBATO_HOME,
      scope: "project",
      projectId,
    });
    purgeMemories(paths, {
      baseReleaseId: readCurrentReleaseId(paths),
      sessionIds: [sessionId],
    });
    fs.unlinkSync(sessionPath);

    store.writeMessage({ role: "assistant", content: "late write" });
    store.close();
    expect(fs.existsSync(sessionPath)).toBe(false);
    expect(store.getRecords()).toEqual([]);
  });
});

describe("SessionManager project IDs and legacy compatibility", () => {
  let tempDir: string;
  let previousRubatoHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-session-manager-"));
    previousRubatoHome = process.env.RUBATO_HOME;
    process.env.RUBATO_HOME = path.join(tempDir, ".rubato");
  });

  afterEach(() => {
    if (previousRubatoHome === undefined) delete process.env.RUBATO_HOME;
    else process.env.RUBATO_HOME = previousRubatoHome;
    makeWritable(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses a stable SHA-256 project ID under RUBATO_HOME", () => {
    const workspace = path.join(tempDir, "workspace");
    const expected = createHash("sha256")
      .update(path.resolve(workspace))
      .digest("hex");
    const manager = new SessionManager(workspace);

    expect(manager.getProjectHash()).toBe(expected);
    const created = manager.createSession("hello", "test-model");
    expect(
      fs.existsSync(
        path.join(process.env.RUBATO_HOME!, "projects", expected, "sessions.json"),
      ),
    ).toBe(true);
    const catalogPath = path.join(
      process.env.RUBATO_HOME!,
      "projects",
      expected,
      "session-catalog.tsv",
    );
    expect(fs.existsSync(catalogPath)).toBe(true);
    expect(fs.readFileSync(catalogPath, "utf8")).toContain(
      `session_id\tcreated_at\tlast_active_at\tstatus`,
    );
    expect(fs.readFileSync(catalogPath, "utf8")).toContain(created.id);
    expect(created.firstMessage).toBe("hello");
  });

  it("discovers and reads sessions from the legacy slug directory", () => {
    const workspace = path.join(tempDir, "legacy workspace");
    const legacyId = legacyProjectId(workspace);
    const legacyBase = path.join(process.env.RUBATO_HOME!, "projects", legacyId);
    const legacySessions = path.join(legacyBase, "sessions");
    fs.mkdirSync(legacySessions, { recursive: true });
    fs.writeFileSync(
      path.join(legacyBase, "sessions.json"),
      JSON.stringify([
        {
          id: "legacy-session",
          createdAt: 10,
          lastActiveAt: 20,
          firstMessage: "legacy",
          model: "old-model",
          messageCount: 1,
          tokenCount: 2,
          status: "ended",
        },
      ]),
      "utf8",
    );
    fs.writeFileSync(
      path.join(legacySessions, "legacy-session.jsonl"),
      `${JSON.stringify({
        type: "message",
        timestamp: 10,
        data: { role: "user", content: "from the old directory" },
      })}\n`,
      "utf8",
    );

    const manager = new SessionManager(workspace);
    expect(manager.listSessions().map((record) => record.id)).toContain("legacy-session");
    expect(manager.getSessionPath("legacy-session")).toBe(
      path.join(legacySessions, "legacy-session.jsonl"),
    );
    expect(manager.loadSessionHistory("legacy-session")).toContain("from the old directory");

    manager.deleteSession("legacy-session");
    expect(fs.existsSync(path.join(legacySessions, "legacy-session.jsonl"))).toBe(false);
    expect(new SessionManager(workspace).getSession("legacy-session")).toBeUndefined();
  });

  it("discovers the former truncated SHA-256 project directory", () => {
    const workspace = path.join(tempDir, "truncated workspace");
    const legacyId = createHash("sha256")
      .update(path.resolve(workspace))
      .digest("hex")
      .slice(0, 16);
    const legacyBase = path.join(process.env.RUBATO_HOME!, "projects", legacyId);
    fs.mkdirSync(path.join(legacyBase, "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(legacyBase, "sessions.json"),
      JSON.stringify([{
        id: "truncated-session",
        createdAt: 10,
        lastActiveAt: 20,
        firstMessage: "legacy sha",
        model: "old-model",
        messageCount: 1,
        tokenCount: 2,
        status: "ended",
      }]),
      "utf8",
    );

    const manager = new SessionManager(workspace);
    expect(manager.getProjectHash()).toHaveLength(64);
    expect(manager.listSessions().map((record) => record.id))
      .toContain("truncated-session");
  });
});

function legacyProjectId(workdir: string): string {
  return path.resolve(workdir)
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "root";
}

function makeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) makeWritable(target);
    try {
      fs.chmodSync(target, entry.isDirectory() ? 0o755 : 0o644);
    } catch {
      // Best-effort cleanup for immutable release fixtures.
    }
  }
  try {
    fs.chmodSync(root, 0o755);
  } catch {
    // Best-effort cleanup.
  }
}
