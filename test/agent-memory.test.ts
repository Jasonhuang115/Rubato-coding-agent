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
import { extractMemories, shouldExtractMemories } from "../src/memory/extraction.js";
import { SecurityRuntime } from "../src/security/runtime.js";
import type { AgentContext, ModelProvider } from "../src/shared/core-types.js";
import { memoryTool } from "../src/tools/memory.js";
import { ToolRuntime } from "../src/runtime/tool-runtime.js";
import { messagesToDiscard, compactCutFrom, microCompact } from "../src/context/compression.js";
import { wouldCompact } from "../src/runtime/compaction-controller.js";

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

  it("supports create, view, replace, insert, rename, and delete without hashes", () => {
    const store = new MemoryStore({ projectId: PROJECT_ID, rootDir: root });
    store.create("project", "decisions/api.md", "# API\n- omit id\n");
    store.replace("project", "decisions/api.md", "omit id", "omit unstable internal id");
    store.insert("project", "decisions/api.md", 2, "- revisit when detail lookup exists");
    store.rename("project", "decisions/api.md", "decisions/submission-api.md");
    expect(store.view("project", "decisions/submission-api.md").content)
      .toContain("revisit when detail lookup exists");
    store.delete("project", "decisions/submission-api.md");
    expect(store.view("project", "decisions/submission-api.md").kind).toBe("missing");
  });

  it("rejects traversal, encoded paths, symlinks, roots, credentials, and extra user files", () => {
    const store = new MemoryStore({ projectId: PROJECT_ID, rootDir: root });
    store.create("project", "MEMORY.md", "# Index\n");
    expect(() => store.replace("project", "MEMORY.md", "missing", "Other"))
      .toThrow(/not found/i);
    store.replace("project", "MEMORY.md", "Index", "Project");
    expect(() => store.create("project", "../escape.md", "bad")).toThrow(/traversal/i);
    expect(() => store.create("project", "%2e%2e/escape.md", "bad")).toThrow(/encoded/i);
    expect(() => store.delete("project", ".")).toThrow(/root/i);
    expect(() => store.create("project", "secret.md", "api_key=abcdefghijklmnop"))
      .toThrow(/sensitive/i);
    expect(() => store.create("user", "secret.md", "not a secret")).toThrow(/MEMORY.md/i);
    expect(() => store.rename("user", "MEMORY.md", "other.md")).toThrow(/MEMORY.md/i);

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
  it("injects a project index and a resident user portrait", async () => {
    const store = new MemoryStore({ projectId: PROJECT_ID, rootDir: root });
    store.create("project", "MEMORY.md", `# Project\n${"p".repeat(MEMORY_INDEX_MAX_BYTES + 100)}`);
    store.create("project", "details.md", "TOPIC BODY MUST STAY ON DEMAND");
    store.create("user", "MEMORY.md", "# User\n- concise reviews\n");
    const ctx = context("default");
    const project = await new ProjectMemorySource().fetch("task", ctx);
    const user = await new UserMemorySource().fetch("task", ctx);
    expect(project?.content).toContain("Project Memory (mid-term)");
    expect(project?.content).not.toContain("TOPIC BODY MUST STAY ON DEMAND");
    expect(project?.content).toContain(store.root("project"));
    expect(Buffer.byteLength(project?.content ?? "")).toBeLessThan(MEMORY_INDEX_MAX_BYTES + 2_000);
    expect(user?.content).toContain("User Memory (long-term)");
    expect(user?.content).toContain("concise reviews");
    expect(user?.content).toContain(`${store.root("user")}/MEMORY.md`);
  });

  it("runs without confirmation and allows writes in Plan Mode", async () => {
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
    const written = await runtime.execute("Memory", {
      namespace: "project", command: "create", path: "other.md", file_text: "x",
    }, ctx);
    expect(written.isError).toBe(false);
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

describe("memory extraction before compaction", () => {
  it("shares the compaction cut point so extraction sees the discarded slice", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const,
      content: `msg ${index}`,
    }));
    const cut = compactCutFrom(messages, 4);
    expect(messagesToDiscard(messages, 4)).toEqual(messages.slice(0, cut));
    const compacted = microCompact(messages, 4);
    expect(compacted[0].content).toContain("Earlier conversation");
  });

  it("writes project memory then lets compaction proceed even if later rounds fail", async () => {
    const store = new MemoryStore({ projectId: PROJECT_ID, rootDir: root });
    store.create("project", "MEMORY.md", "# Index\n");
    const ctx = context("default");
    let calls = 0;
    const provider: ModelProvider = {
      name: "test",
      supportsPromptCaching: () => false,
      countTokens: async () => 1,
      async *chat() {
        calls += 1;
        if (calls === 1) {
          yield { type: "tool_use_start", id: "t1", name: "Memory" };
          yield {
            type: "tool_use_end",
            id: "t1",
            input: {
              namespace: "project",
              command: "create",
              path: "decisions.md",
              file_text: "# Why omit source\nInternal pipeline only.\n",
            },
          };
          yield {
            type: "message_stop",
            stopReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 10 },
          };
          return;
        }
        throw new Error("provider down");
      },
    };

    const result = await extractMemories({
      discarded: [{ role: "user", content: "Do not distinguish upload source." }],
      ctx,
      config: ctx.config,
      provider,
    });
    expect(result.wrote).toBe(true);
    expect(result.warning).toMatch(/failed|provider down/i);
    expect(store.view("project", "decisions.md").content).toContain("Internal pipeline");
  });

  it("does not treat a no-op extraction as a write", async () => {
    const ctx = context("default");
    const provider: ModelProvider = {
      name: "test",
      supportsPromptCaching: () => false,
      countTokens: async () => 1,
      async *chat() {
        yield { type: "text_delta", text: "NO_MEMORY_UPDATES" };
        yield {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const result = await extractMemories({
      discarded: [{ role: "user", content: "hello" }],
      ctx,
      config: ctx.config,
      provider,
    });
    expect(result.wrote).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("skips extraction for subagents, disabled memory, and the same compaction cycle", () => {
    expect(shouldExtractMemories({
      isRoot: false, extractedThisCycle: false, memoryEnabled: true, willCompact: true,
    })).toBe(false);
    expect(shouldExtractMemories({
      isRoot: true, extractedThisCycle: false, memoryEnabled: false, willCompact: true,
    })).toBe(false);
    expect(shouldExtractMemories({
      isRoot: true, extractedThisCycle: true, memoryEnabled: true, willCompact: true,
    })).toBe(false);
    expect(shouldExtractMemories({
      isRoot: true, extractedThisCycle: false, memoryEnabled: true, willCompact: true,
    })).toBe(true);
  });

  it("skips extraction when compaction would not run", () => {
    expect(wouldCompact({
      messages: [{ role: "user", content: "short" }],
      systemTokens: 10,
      model: "gpt-4o",
    })).toBe(false);
    expect(wouldCompact({
      messages: [{ role: "user", content: "short" }],
      systemTokens: 10,
      model: "gpt-4o",
      forceCompact: true,
    })).toBe(true);
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
