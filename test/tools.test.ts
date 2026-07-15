// Tool system tests
import { describe, it, expect, beforeEach } from "vitest";
import { register, getTool, getAllTools, clear } from "../src/tools/registry.js";
import { ReadGuard } from "../src/agent/read-guard.js";
import type { AgentContext } from "../src/core-types.js";
import type { PermissionManager, PermissionResult } from "../src/core-types.js";

// Minimal mock context for testing
function mockCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    workingDir: "/tmp/test",
    sessionId: "test-session",
    readGuard: new ReadGuard(),
    permissionManager: {
      check: () => ({ allowed: true }),
    },
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

describe("Tool Registry", () => {
  beforeEach(() => {
    clear();
  });

  it("registers and retrieves tools", () => {
    const tool = {
      name: "TestTool",
      description: "A test tool",
      inputSchema: { type: "object" as const, properties: {} },
      type: "read" as const,
      handler: async () => ({ content: "ok" }),
    };

    register(tool);
    expect(getTool("TestTool")).toBe(tool);
    expect(getAllTools()).toHaveLength(1);
  });

  it("throws on duplicate registration", () => {
    const tool = {
      name: "Dup",
      description: "x",
      inputSchema: { type: "object" as const, properties: {} },
      type: "read" as const,
      handler: async () => ({ content: "ok" }),
    };

    register(tool);
    expect(() => register(tool)).toThrow("already registered");
  });

  it("clears all tools", () => {
    register({
      name: "T1",
      description: "x",
      inputSchema: { type: "object" as const, properties: {} },
      type: "read" as const,
      handler: async () => ({ content: "ok" }),
    });
    clear();
    expect(getAllTools()).toHaveLength(0);
  });
});

describe("ReadGuard", () => {
  it("tracks read files", () => {
    const guard = new ReadGuard();
    guard.markAsRead("/tmp/test/file.ts", "content here");
    expect(guard.hasRead("/tmp/test/file.ts")).toBe(true);
    expect(guard.hasRead("/tmp/other.ts")).toBe(false);
  });

  it("serializes state", () => {
    const guard = new ReadGuard();
    guard.markAsRead("/tmp/test/a.ts", "aaa");
    guard.markAsRead("/tmp/test/b.ts", "bbb");

    const snapshot = guard.serialize();
    expect(Object.keys(snapshot.files)).toHaveLength(2);
    expect(snapshot.files["/tmp/test/a.ts"]).toBeDefined();
    expect(snapshot.files["/tmp/test/b.ts"]).toBeDefined();
  });

  it("returns file list", () => {
    const guard = new ReadGuard();
    guard.markAsRead("/tmp/f1.ts", "a");
    guard.markAsRead("/tmp/f2.ts", "b");

    expect(guard.getFiles()).toEqual(["/tmp/f1.ts", "/tmp/f2.ts"]);
    expect(guard.getFileCount()).toBe(2);
  });
});

describe("Read tool", () => {
  it("rejects non-existent files", async () => {
    const { readTool } = await import("../src/tools/read.js");
    const result = await readTool.handler(
      { file_path: "/nonexistent/file.txt" },
      mockCtx()
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("reads existing files", async () => {
    const fs = await import("fs");
    const tmpPath = "/tmp/coding-agent-test-read.txt";
    fs.writeFileSync(tmpPath, "hello\nworld\n");

    const { readTool } = await import("../src/tools/read.js");
    const ctx = mockCtx();
    const result = await readTool.handler({ file_path: tmpPath }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("hello");
    expect(result.content).toContain("world");
    expect(ctx.readGuard.hasRead(tmpPath)).toBe(true);

    fs.unlinkSync(tmpPath);
  });
});

describe("Write tool", () => {
  it("writes new files", async () => {
    const tmpPath = "/tmp/coding-agent-test-write-new.txt";

    // Clean up first
    try { (await import("fs")).unlinkSync(tmpPath); } catch {}

    const { writeTool } = await import("../src/tools/write.js");
    const result = await writeTool.handler(
      { file_path: tmpPath, content: "new content" },
      mockCtx()
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("File written");

    const fs = await import("fs");
    expect(fs.readFileSync(tmpPath, "utf-8")).toBe("new content");
    fs.unlinkSync(tmpPath);
  });

  it("enforces ReadGuard for existing files", async () => {
    const fs = await import("fs");
    const tmpPath = "/tmp/coding-agent-test-write-guard.txt";
    fs.writeFileSync(tmpPath, "existing content");

    const { writeTool } = await import("../src/tools/write.js");
    const ctx = mockCtx(); // ReadGuard has not read this file
    const result = await writeTool.handler(
      { file_path: tmpPath, content: "new content" },
      ctx
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("ReadGuard");

    fs.unlinkSync(tmpPath);
  });
});

describe("Edit tool", () => {
  it("replaces text in files", async () => {
    const fs = await import("fs");
    const tmpPath = "/tmp/coding-agent-test-edit.txt";
    fs.writeFileSync(tmpPath, "hello world\nfoo bar\n");

    const { editTool } = await import("../src/tools/edit.js");
    const ctx = mockCtx();
    ctx.readGuard.markAsRead(tmpPath, "hello world\nfoo bar\n");

    const result = await editTool.handler(
      {
        file_path: tmpPath,
        old_string: "hello world",
        new_string: "goodbye world",
      },
      ctx
    );

    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(tmpPath, "utf-8")).toBe("goodbye world\nfoo bar\n");
    fs.unlinkSync(tmpPath);
  });

  it("rejects non-matching strings", async () => {
    const fs = await import("fs");
    const tmpPath = "/tmp/coding-agent-test-edit-nomatch.txt";
    fs.writeFileSync(tmpPath, "hello world\n");
    fs.unlinkSync(tmpPath); // clean up after — wait no, we need it

    // Rewrite
    fs.writeFileSync(tmpPath, "hello world\n");

    const { editTool } = await import("../src/tools/edit.js");
    const ctx = mockCtx();
    ctx.readGuard.markAsRead(tmpPath, "hello world\n");

    const result = await editTool.handler(
      {
        file_path: tmpPath,
        old_string: "not in file",
        new_string: "replacement",
      },
      ctx
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
    fs.unlinkSync(tmpPath);
  });
});

describe("Todo tool", () => {
  it("updates todo list", async () => {
    const { todoWriteTool, clearTodos } = await import("../src/tools/todo.js");
    const ctx = mockCtx();

    const result = await todoWriteTool.handler(
      {
        todos: [
          { content: "task 1", status: "pending", activeForm: "doing task 1" },
          { content: "task 2", status: "completed", activeForm: "doing task 2" },
        ],
      },
      ctx
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Todo list updated");
    expect(result.content).toContain("task 1");
    expect(result.content).toContain("task 2");

    clearTodos(ctx.sessionId);
  });
});
