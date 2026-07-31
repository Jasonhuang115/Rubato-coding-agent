import type { OutcomeVector } from "../memory-files/outcome.js";
import {
  getRubatoHome,
  recordMemoryOutcome,
} from "../memory-files/outcome.js";
import { sessionMemoryAccess } from "../memory-files/access.js";
import type { ToolDefinition } from "../shared/core-types.js";
import path from "path";

export const memoryFeedbackTool: ToolDefinition = {
  name: "MemoryFeedback",
  description:
    "Record outcome evidence for memory cards actually applied in this task. " +
    "This updates utility evidence only; it cannot change whether a user belief is true.",
  inputSchema: {
    type: "object",
    properties: {
      task_tags: {
        type: "array",
        items: { type: "string" },
        description: "Short task categories, for example architecture or testing",
      },
      memory_searched: {
        type: "array",
        items: { type: "string" },
      },
      memory_read: {
        type: "array",
        items: { type: "string" },
      },
      memory_applied: {
        type: "array",
        items: { type: "string" },
        description: "Only stable memory card IDs that actually affected the response",
      },
      skills_used: {
        type: "array",
        items: { type: "string" },
      },
      tests_passed: { type: "boolean" },
      build_passed: { type: "boolean" },
      user_signal: {
        type: "string",
        enum: ["accepted", "corrected", "withdrawn", "unknown"],
      },
      tool_steps: { type: "number" },
      tokens: { type: "number" },
      latency_ms: { type: "number" },
      release_ids: {
        type: "array",
        items: { type: "string" },
      },
      reward: {
        type: "object",
        description: "Five auditable reward components, each from -1 to 1",
        properties: {
          task_utility: { type: "number" },
          personalization: { type: "number" },
          efficiency: { type: "number" },
          retention: { type: "number" },
          safety: { type: "number" },
        },
        required: [
          "task_utility",
          "personalization",
          "efficiency",
          "retention",
          "safety",
        ],
      },
    },
    required: ["task_tags", "memory_applied", "reward"],
  },
  type: "write",
  requiresApproval: false,
  async handler(input, ctx) {
    if (ctx.depth !== 0) {
      return {
        content: "Only the root agent may record memory feedback.",
        isError: true,
      };
    }
    try {
      const observedAccess = sessionMemoryAccess(
        path.join(getRubatoHome(), "memory"),
        ctx.sessionId,
      );
      const outcome = recordMemoryOutcome({
        session_id: ctx.sessionId,
        task_tags: stringArray(input.task_tags),
        memory_searched: union(
          stringArray(input.memory_searched),
          observedAccess.searched,
        ),
        memory_read: union(
          stringArray(input.memory_read),
          observedAccess.read,
        ),
        memory_applied: stringArray(input.memory_applied),
        skills_used: stringArray(input.skills_used),
        tests_passed: optionalBoolean(input.tests_passed),
        build_passed: optionalBoolean(input.build_passed),
        user_signal: parseUserSignal(input.user_signal),
        tool_steps: optionalNumber(input.tool_steps),
        tokens: optionalNumber(input.tokens),
        latency_ms: optionalNumber(input.latency_ms),
        release_ids: stringArray(input.release_ids),
        reward: parseReward(input.reward),
      });
      return {
        content:
          `Recorded outcome ${outcome.event_id}. ` +
          "Belief confidence was not modified.",
      };
    } catch (error) {
      return {
        content: `Memory feedback rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  },
};

function stringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("expected an array of strings");
  }
  return value;
}

function union(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("expected a boolean");
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error("expected a number");
  return value;
}

function parseUserSignal(
  value: unknown,
): "accepted" | "corrected" | "withdrawn" | "unknown" {
  if (
    value === "accepted" ||
    value === "corrected" ||
    value === "withdrawn" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

function parseReward(value: unknown): OutcomeVector {
  if (!value || typeof value !== "object") {
    throw new Error("reward must be an object");
  }
  const reward = value as Record<string, unknown>;
  const number = (name: keyof OutcomeVector): number => {
    const item = reward[name];
    if (typeof item !== "number") throw new Error(`reward.${name} must be a number`);
    return item;
  };
  return {
    task_utility: number("task_utility"),
    personalization: number("personalization"),
    efficiency: number("efficiency"),
    retention: number("retention"),
    safety: number("safety"),
  };
}
