// Context system tests
import { describe, it, expect } from "vitest";
import { ContextChain } from "../src/context/sources.js";
import { microCompact, snipContent, snipLines } from "../src/context/compression.js";
import { buildSystemPrompt } from "../src/context/system-prompt.js";
import type { ContextSource, ContextBlock, AgentContext, ToolDefinition } from "../src/core-types.js";

function mockCtx(): AgentContext {
  return {
    workingDir: "/tmp/test",
    sessionId: "test-session",
    readGuard: {
      hasRead: () => false,
      markAsRead: () => {},
      serialize: () => ({ files: {} }),
    },
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
  };
}

class TestSource implements ContextSource {
  readonly name: string;
  readonly priority: number;
  private block: ContextBlock | null;

  constructor(name: string, priority: number, block: ContextBlock | null) {
    this.name = name;
    this.priority = priority;
    this.block = block;
  }

  async fetch(): Promise<ContextBlock | null> {
    return this.block;
  }
}

describe("ContextChain", () => {
  it("collects context blocks sorted by priority", async () => {
    const chain = new ContextChain();
    chain.register(
      new TestSource("low", 50, {
        content: "low priority",
        priority: 50,
        source: "low",
      })
    );
    chain.register(
      new TestSource("high", 10, {
        content: "high priority",
        priority: 10,
        source: "high",
      })
    );

    const results = await chain.fetchAll("test query", mockCtx());

    expect(results).toHaveLength(2);
    expect(results[0].source).toBe("high"); // Lower priority number = first
    expect(results[1].source).toBe("low");
  });

  it("skips null blocks", async () => {
    const chain = new ContextChain();
    chain.register(new TestSource("valid", 10, { content: "data", priority: 10, source: "valid" }));
    chain.register(new TestSource("null-source", 20, null));

    const results = await chain.fetchAll("query", mockCtx());
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("valid");
  });

  it("handles failing sources gracefully", async () => {
    const chain = new ContextChain();
    chain.register({
      name: "bad",
      priority: 10,
      async fetch() {
        throw new Error("boom");
      },
    });
    chain.register(
      new TestSource("good", 20, { content: "ok", priority: 20, source: "good" })
    );

    const results = await chain.fetchAll("query", mockCtx());
    expect(results).toHaveLength(2);
    // The failing source is still included with error info
    const badResult = results.find((r) => r.source === "bad");
    expect(badResult).toBeDefined();
    expect(badResult!.content).toContain("failed");
  });

  it("removes sources", async () => {
    const chain = new ContextChain();
    chain.register(new TestSource("a", 10, { content: "a", priority: 10, source: "a" }));
    chain.register(new TestSource("b", 20, { content: "b", priority: 20, source: "b" }));

    chain.remove("a");
    const results = await chain.fetchAll("query", mockCtx());
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("b");
  });
});

describe("MicroCompact", () => {
  it("compresses messages when over target count", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Message ${i}: doing work on /path/to/file${i}.ts`,
    }));

    const target = 10;
    const compressed = microCompact(messages, target);

    expect(compressed.length).toBeLessThan(messages.length);
    // First message should be the summary
    expect(compressed[0].content).toContain("[Earlier conversation");
  });

  it("keeps messages when under target count", () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
    }));

    const compressed = microCompact(messages, 10);
    expect(compressed).toHaveLength(5);
  });
});

describe("Snip", () => {
  it("truncates long content", () => {
    const longContent = "x".repeat(100_000);
    const snipped = snipContent(longContent, 1000);

    expect(snipped.length).toBeLessThan(longContent.length);
    expect(snipped).toContain("truncated");
  });

  it("keeps short content intact", () => {
    const short = "hello world";
    const snipped = snipContent(short, 1000);
    expect(snipped).toBe(short);
  });

  it("truncates lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const result = snipLines(lines, 20);

    expect(result).toContain("truncated");
    // Should contain some lines from the head and tail
    expect(result).toContain("line 0");
    expect(result).toContain("line 99");
  });
});

describe("SystemPrompt", () => {
  it("includes tool descriptions", () => {
    const tools: ToolDefinition[] = [
      {
        name: "TestTool",
        description: "A test tool for testing",
        inputSchema: { type: "object", properties: {} },
        type: "read",
        handler: async () => ({ content: "" }),
      },
    ];

    const prompt = buildSystemPrompt(mockCtx(), tools);
    expect(prompt).toContain("TestTool");
    expect(prompt).toContain("A test tool for testing");
    expect(prompt).toContain("/tmp/test");
  });
});
