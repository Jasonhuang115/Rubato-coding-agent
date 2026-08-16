import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectMemorySource,
  UserMemorySource,
} from "../src/context/agent-memory.js";
import {
  MEMORY_INDEX_MAX_BYTES,
  MemoryStore,
  migrateLegacyMemoryData,
} from "../src/memory/store.js";
import { SecurityRuntime } from "../src/security/runtime.js";
import type { AgentContext } from "../src/shared/core-types.js";
import { memoryTool } from "../src/tools/memory.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";

const PROJECT_ID = "a".repeat(64);
const originalRubatoHome = process.env.RUBATO_HOME;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-agent-memory-"));
  process.env.RUBATO_HOME = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (originalRubatoHome === undefined) delete process.env.RUBATO_HOME;
  else process.env.RUBATO_HOME = originalRubatoHome;
});

describe("agent-managed memory store", () => {
  it("keeps project and user memory physically isolated", () => {
    const store = new MemoryStore({ projectId: PROJECT_ID, rootDir: root });
    store.create("project", "MEMORY.md", "# Project\n- API rationale → api.md\n");
    store.create("user", "MEMORY.md", "# User\n- Prefers concise reviews\n");

    expect(store.view("project", "MEMORY.md").content).toContain("API rationale");
    expect(store.view("project", "MEMORY.md").content).not.toContain("concise reviews");
    expect(store.view("user", "MEMORY.md").content).toContain("concise reviews");
    expect(store.root("project")).toContain(`/projects/${PROJECT_ID}/memory`);
    expect(store.root("user")).toBe(path.join(fs.realpathSync(root), "user-memory"));
  });

  it("supports create, view, replace, insert, rename, and delete", () => {
    const store = new MemoryStore({ projectId: PROJECT_ID, rootDir: root });
    store.create("project", "decisions/api.md", "# API\n- omit id\n");
    const first = store.view("project", "decisions/api.md");
    const replaced = store.replace(
      "project",
      "decisions/api.md",
      "omit id",
      "omit unstable internal id",
      first.hash!,
    );
    const inserted = store.insert(
      "project",
      "decisions/api.md",
      2,
      "- revisit when detail lookup exists",
      replaced.hash!,
    );
    const renamed = store.rename(
      "project",
      "decisions/api.md",
      "decisions/submission-api.md",
      inserted.hash!,
    );
    expect(store.view("project", "decisions/submission-api.md").content)
      .toContain("revisit when detail lookup exists");
    store.delete("project", "decisions/submission-api.md", renamed.hash!);
    expect(store.view("project", "decisions/submission-api.md").kind).toBe("missing");
  });

  it("rejects stale edits, traversal, encoded paths, symlinks, roots, and credentials", () => {
    const store = new MemoryStore({ projectId: PROJECT_ID, rootDir: root });
    store.create("project", "MEMORY.md", "# Index\n");
    const stale = store.view("project", "MEMORY.md").hash!;
    const current = store.replace("project", "MEMORY.md", "Index", "Project", stale);
    expect(() => store.replace("project", "MEMORY.md", "Project", "Other", stale))
      .toThrow(/conflict/i);
    expect(current.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => store.create("project", "../escape.md", "bad")).toThrow(/traversal/i);
    expect(() => store.create("project", "%2e%2e/escape.md", "bad")).toThrow(/encoded/i);
    expect(() => store.delete("project", ".", store.view("project").hash!)).toThrow(/root/i);
    expect(() => store.create("user", "secret.md", "api_key=abcdefghijklmnop"))
      .toThrow(/sensitive/i);

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rubato-memory-outside-"));
    const projectRoot = store.root("project");
    fs.symlinkSync(outside, path.join(projectRoot, "linked"));
    expect(() => store.create("project", "linked/escape.md", "bad")).toThrow(/symbolic/i);
    expect(fs.existsSync(path.join(outside, "escape.md"))).toBe(false);
    expect(fs.existsSync(path.join(outside, "nested"))).toBe(false);
    expect(() => store.create("project", "linked/nested/escape.md", "bad"))
      .toThrow(/symbolic/i);
    expect(fs.existsSync(path.join(outside, "nested"))).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("warns after an oversized startup index while preserving the write", () => {
    const store = new MemoryStore({ projectId: PROJECT_ID, rootDir: root });
    const result = store.create(
      "project",
      "MEMORY.md",
      `# Index\n${"- topic\n".repeat(300)}`,
    );
    expect(result.warnings[0]).toContain("startup index limit");
    expect(fs.statSync(path.join(store.root("project"), "MEMORY.md")).size)
      .toBeGreaterThan(0);
  });
});

describe("memory context and tool runtime", () => {
  it("injects bounded, separately labelled indexes but not topic bodies", async () => {
    const store = new MemoryStore({ projectId: PROJECT_ID, rootDir: root });
    store.create("project", "MEMORY.md", `# Project\n${"p".repeat(MEMORY_INDEX_MAX_BYTES + 100)}`);
    store.create("project", "details.md", "TOPIC BODY MUST STAY ON DEMAND");
    store.create("user", "MEMORY.md", "# User\n- concise reviews\n");
    const ctx = context("default");
    const project = await new ProjectMemorySource().fetch("task", ctx);
    const user = await new UserMemorySource().fetch("task", ctx);
    expect(project?.content).toContain("Project Memory (mid-term)");
    expect(project?.content).not.toContain("TOPIC BODY MUST STAY ON DEMAND");
    expect(Buffer.byteLength(project?.content ?? "")).toBeLessThan(MEMORY_INDEX_MAX_BYTES + 2_000);
    expect(user?.content).toContain("User Memory (long-term)");
  });

  it("runs without confirmation and enforces read-only Plan Mode", async () => {
    const ctx = context("default");
    const confirm = vi.fn(async () => "deny_once" as const);
    const runtime = new ToolRuntime({
      securityRuntime: new SecurityRuntime(ctx.config.permissions),
      workingDir: ctx.workingDir,
      onConfirmTool: confirm,
      tools: [memoryTool],
    });
    const created = await runtime.execute("Memory", {
      namespace: "project",
      command: "create",
      path: "MEMORY.md",
      file_text: "# Project\n",
    }, ctx);
    expect(created.isError).toBe(false);
    expect(confirm).not.toHaveBeenCalled();

    ctx.mode = "plan";
    const viewed = await runtime.execute("Memory", {
      namespace: "project", command: "view", path: "MEMORY.md",
    }, ctx);
    expect(viewed.isError).toBe(false);
    const blocked = await runtime.execute("Memory", {
      namespace: "project", command: "create", path: "other.md", file_text: "x",
    }, ctx);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("Memory.view only");
  });

  it("rejects subagents and disabled namespaces", async () => {
    const ctx = context("default");
    ctx.depth = 1;
    expect((await memoryTool.handler({
      namespace: "project", command: "view", path: ".",
    }, ctx)).isError).toBe(true);
    ctx.depth = 0;
    ctx.config.memory!.projectEnabled = false;
    expect((await memoryTool.handler({
      namespace: "project", command: "view", path: ".",
    }, ctx)).isError).toBe(true);
  });
});

describe("legacy memory cleanup", () => {
  it("deletes only the retired memory-data root and is idempotent", () => {
    fs.mkdirSync(path.join(root, "memory", "global", "releases"), { recursive: true });
    fs.writeFileSync(path.join(root, "memory", "global", "CURRENT"), "old");
    fs.mkdirSync(path.join(root, "projects", PROJECT_ID, "sessions"), { recursive: true });
    const session = path.join(root, "projects", PROJECT_ID, "sessions", "keep.jsonl");
    fs.writeFileSync(session, "keep\n");

    expect(migrateLegacyMemoryData(root).removed).toBe(true);
    expect(fs.existsSync(path.join(root, "memory"))).toBe(false);
    expect(fs.readFileSync(session, "utf8")).toBe("keep\n");
    expect(fs.existsSync(path.join(root, "user-memory"))).toBe(true);
    expect(migrateLegacyMemoryData(root).removed).toBe(false);
  });
});

function context(mode: "default" | "plan"): AgentContext {
  const permissions = {
    bash: "confirm", read: "confirm", write: "confirm", edit: "confirm", web: "confirm",
  } as const;
  const security = new SecurityRuntime(permissions);
  return {
    workingDir: root,
    projectId: PROJECT_ID,
    sessionId: "session-1",
    mode,
    depth: 0,
    readGuard: { hasRead: () => true, markAsRead: () => {}, serialize: () => ({ files: {} }) },
    permissionManager: security.policyEngine,
    config: {
      model: { provider: "test", model: "test" },
      permissions,
      memory: { enabled: true, projectEnabled: true, userEnabled: true },
      session: { cleanupPeriodDays: 30 },
    },
  };
}
