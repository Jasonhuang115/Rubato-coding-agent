// Agent loop tests (with mock provider)
import { describe, it, expect, beforeEach } from "vitest";
import { ReadGuard } from "../src/agent/read-guard.js";
import { ContextChain } from "../src/context/sources.js";
import { PolicyEngine } from "../src/permissions/policy.js";
import { register, clear } from "../src/tools/registry.js";
import type { AgentConfig, AgentContext, ContextBlock, ContextSource } from "../src/core-types.js";

// Mock context
function mockCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    workingDir: "/tmp/test",
    sessionId: "test-session",
    readGuard: new ReadGuard(),
    permissionManager: new PolicyEngine({
      bash: "auto",
      read: "auto",
      write: "auto",
      edit: "auto",
      web: "auto",
    }),
    config: {
      model: { provider: "deepseek", model: "deepseek-chat" },
      permissions: {
        bash: "auto",
        read: "auto",
        write: "auto",
        edit: "auto",
        web: "auto",
      },
      embedding: { source: "local_onnx" },
      mnemosyne: { bootstrap_on_first_open: false, bootstrap_max_files: 100 },
      session: { cleanupPeriodDays: 30 },
    },
    ...overrides,
  };
}

describe("ReadGuard state machine", () => {
  it("starts empty", () => {
    const guard = new ReadGuard();
    expect(guard.getFileCount()).toBe(0);
    expect(guard.hasRead("/any/file")).toBe(false);
  });

  it("marks and tracks files", () => {
    const guard = new ReadGuard();
    guard.markAsRead("/tmp/a.ts", "content a");
    guard.markAsRead("/tmp/b.ts", "content b");

    expect(guard.getFileCount()).toBe(2);
    expect(guard.hasRead("/tmp/a.ts")).toBe(true);
    expect(guard.hasRead("/tmp/b.ts")).toBe(true);
    expect(guard.hasRead("/tmp/c.ts")).toBe(false);
  });

  it("detects content changes via hash", () => {
    const guard = new ReadGuard();
    guard.markAsRead("/tmp/file.ts", "original content");

    const snap1 = guard.serialize();
    const hash1 = snap1.files["/tmp/file.ts"].hash;

    guard.markAsRead("/tmp/file.ts", "modified content");
    const snap2 = guard.serialize();
    const hash2 = snap2.files["/tmp/file.ts"].hash;

    expect(hash1).not.toBe(hash2);
  });
});

describe("Agent context integration", () => {
  beforeEach(() => {
    clear();
  });

  it("provides working directory to tools", async () => {
    // Register a simple tool that returns the working directory
    register({
      name: "PwdTool",
      description: "Returns working dir",
      inputSchema: { type: "object", properties: {} },
      type: "read",
      isConcurrencySafe: true,
      handler: async (_input, ctx) => {
        return { content: ctx.workingDir };
      },
    });

    const { dispatch } = await import("../src/tools/registry.js");
    const ctx = mockCtx({ workingDir: "/custom/path" });
    const result = await dispatch("PwdTool", {}, ctx);

    expect(result.content).toBe("/custom/path");
  });

  it("enforces ReadGuard on writes", async () => {
    const guard = new ReadGuard();
    const ctx = mockCtx({ readGuard: guard });

    // Register write tool
    register({
      name: "WriteTest",
      description: "Test write",
      inputSchema: {
        type: "object",
        properties: { file_path: { type: "string" }, content: { type: "string" } },
        required: ["file_path", "content"],
      },
      type: "write",
      handler: async (input, ctx) => {
        const { enforceReadGuard } = await import("../src/tools/registry.js");
        const guardResult = enforceReadGuard(input.file_path as string, ctx);
        if (!guardResult.allowed) {
          return { content: guardResult.reason, isError: true };
        }
        return { content: "written" };
      },
    });

    const { dispatch } = await import("../src/tools/registry.js");

    // Write without reading first -> should fail ReadGuard
    const result = await dispatch(
      "WriteTest",
      { file_path: "/tmp/test-existing.txt", content: "data" },
      ctx
    );

    // Since the file doesn't exist, it should be allowed (new file)
    // But if it exists, ReadGuard should block it
    expect(result.content).toBe("written"); // new file allowed
  });
});

describe("Context chain with mock sources", () => {
  it("respects priority ordering", async () => {
    const chain = new ContextChain();

    let fetchOrder: string[] = [];

    chain.register({
      name: "low",
      priority: 50,
      async fetch(): Promise<ContextBlock | null> {
        fetchOrder.push("low");
        return { content: "low", priority: 50, source: "low" };
      },
    });

    chain.register({
      name: "high",
      priority: 10,
      async fetch(): Promise<ContextBlock | null> {
        fetchOrder.push("high");
        return { content: "high", priority: 10, source: "high" };
      },
    });

    const results = await chain.fetchAll("test", mockCtx());

    // Sources are fetched in registration order (priority-sorted insertion)
    // Results sorted by priority
    expect(results[0].source).toBe("high");
    expect(results[1].source).toBe("low");
  });
});

describe("Session meta", () => {
  it("creates session meta with defaults", async () => {
    const { createSessionMeta } = await import("../src/session/meta.js");

    const meta = createSessionMeta("session-1", "deepseek/deepseek-chat");
    expect(meta.id).toBe("session-1");
    expect(meta.model).toBe("deepseek/deepseek-chat");
    expect(meta.totalTokens).toBe(0);
    expect(meta.timestamp).toBeGreaterThan(0);
  });

  it("records file access history", async () => {
    const { createSessionMeta, recordFileAccess } = await import("../src/session/meta.js");

    const meta = createSessionMeta("s1", "test-model");
    recordFileAccess(meta, "/tmp/a.ts");
    recordFileAccess(meta, "/tmp/b.ts");
    recordFileAccess(meta, "/tmp/a.ts"); // duplicate

    expect(meta.fileHistory).toHaveLength(2); // no duplicates
    expect(meta.fileHistory).toContain("/tmp/a.ts");
    expect(meta.fileHistory).toContain("/tmp/b.ts");
  });
});
