// Context system tests
import { describe, it, expect } from "vitest";
import { ContextChain } from "../src/context/sources.js";
import { microCompact } from "../src/context/compression.js";
import { microCompactBeforeRequest } from "../src/context/micro-compact.js";
import type { ContextSource, ContextBlock, AgentContext } from "../src/shared/core-types.js";

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
      session: { cleanupPeriodDays: 30 },
    },
    depth: 0,
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
  it("compresses older user turns when over the keep-turns budget", () => {
    const messages = Array.from({ length: 24 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Message ${i}: doing work on /path/to/file${i}.ts`,
    }));

    const compressed = microCompact(messages, 10);

    expect(compressed.length).toBeLessThan(messages.length);
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

  it("bounds heavyweight tool results accumulated across many model turns", () => {
    const messages = Array.from({ length: 14 }, (_, index): import("../src/shared/core-types.js").Message[] => [
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: `read-${index}`,
          name: "Read",
          input: { file_path: `/project/file-${index}.ts` },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: `read-${index}`,
          content: `full source ${index} ${"x".repeat(100)}`,
        }],
      },
    ]).flat();

    const compacted = microCompactBeforeRequest(messages);
    expect(compacted.cleared).toBe(9);

    const liveResults = compacted.messages.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.filter((block) =>
          block.type === "tool_result" &&
          block.content !== "[Old tool result content cleared]"),
    );
    expect(liveResults).toHaveLength(5);

    // Running the compactor again without new results is a no-op.
    expect(microCompactBeforeRequest(compacted.messages).cleared).toBe(0);
  });
});
