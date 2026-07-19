import { describe, expect, it } from "vitest";
import { getRequiredDelegation } from "../src/agent/delegation-policy.js";
import type { ToolDefinition } from "../src/shared/core-types.js";

const agentTool = {
  name: "Agent",
  description: "delegate",
  inputSchema: { type: "object", properties: {} },
  type: "write",
  handler: async () => ({ content: "" }),
} satisfies ToolDefinition;

describe("required delegation policy", () => {
  it("routes broad Chinese and English project exploration", () => {
    expect(getRequiredDelegation("探索一下这个项目，说说你的评价", 0, [agentTool])?.subagentType).toBe("explore");
    expect(getRequiredDelegation("Review this codebase architecture", 0, [agentTool])?.subagentType).toBe("explore");
  });

  it("does not route simple lookups or nested agents", () => {
    expect(getRequiredDelegation("读取 README.md", 0, [agentTool])).toBeNull();
    expect(getRequiredDelegation("探索一下这个项目", 1, [agentTool])).toBeNull();
  });

  it("honors explicit opt-out and requires the Agent tool", () => {
    expect(getRequiredDelegation("探索项目，但不要使用 subagent", 0, [agentTool])).toBeNull();
    expect(getRequiredDelegation("Explore this project without spawning a subagent", 0, [agentTool])).toBeNull();
    expect(getRequiredDelegation("探索一下这个项目", 0, [])).toBeNull();
  });
});
