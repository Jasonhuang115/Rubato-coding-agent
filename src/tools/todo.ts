// Todo tool — manages the agent's task list

import type { ToolDefinition, AgentContext } from "../core-types.js";

// In-memory todo store (per session)
const todos = new Map<string, TodoItem[]>();

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

export const todoWriteTool: ToolDefinition = {
  name: "TodoWrite",
  description:
    "Create and update a task list for the current session. " +
    "Send the full list each call; it replaces the previous one. " +
    "Keep one item in-progress at a time. " +
    "Used to track progress on multi-step tasks.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
            activeForm: { type: "string" },
          },
          required: ["content", "status", "activeForm"],
        },
        description: "The complete todo list (replaces previous state)",
      },
    },
    required: ["todos"],
  },
  type: "write",
  requiresApproval: false,
  isConcurrencySafe: false,
  async handler(input, ctx) {
    const items = input.todos as TodoItem[];
    const sessionId = ctx.sessionId;

    // Validate
    const inProgressCount = items.filter(
      (t) => t.status === "in_progress"
    ).length;
    if (inProgressCount > 1) {
      return {
        content:
          `Warning: ${inProgressCount} items are in_progress. ` +
          `It's recommended to keep only one item in_progress at a time.`,
        isError: false,
      };
    }

    todos.set(sessionId, items);

    const counts = {
      pending: items.filter((t) => t.status === "pending").length,
      in_progress: items.filter((t) => t.status === "in_progress").length,
      completed: items.filter((t) => t.status === "completed").length,
    };

    const lines = items.map((t) => {
      const icon =
        t.status === "completed"
          ? "✓"
          : t.status === "in_progress"
          ? "●"
          : "○";
      return `  ${icon} ${t.content} [${t.status}]`;
    });

    return {
      content:
        `Todo list updated (${items.length} items: ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed):\n\n` +
        lines.join("\n"),
    };
  },
};

export function getTodos(sessionId: string): TodoItem[] {
  return todos.get(sessionId) ?? [];
}

export function clearTodos(sessionId: string): void {
  todos.delete(sessionId);
}
