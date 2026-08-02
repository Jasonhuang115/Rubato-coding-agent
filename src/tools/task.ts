import type { AgentContext, ToolDefinition } from "../shared/core-types.js";
import { processSubagentRegistry } from "../agent/subagents/registry.js";

export const taskTool: ToolDefinition = {
  name: "Task",
  description: "Inspect, wait for, cancel, or clean up managed subagent tasks in the current root session.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "wait", "watch", "cancel", "cleanup", "pin", "unpin", "stats", "prune"],
      },
      task_id: { type: "string" },
      timeout_ms: { type: "number" },
      cascade: { type: "boolean" },
    },
    required: ["action"],
  },
  type: "read",
  isConcurrencySafe: false,
  async handler(input, ctx: AgentContext) {
    if (ctx.taskRuntime) {
      return { content: "Task management is available only to the root Agent.", isError: true };
    }
    const runtime = processSubagentRegistry.get(ctx.sessionId);
    const action = String(input.action ?? "");
    if (ctx.mode === "plan" && !new Set(["list", "get", "wait", "watch", "stats"]).has(action)) {
      return { content: `Task action "${action}" is blocked in Plan mode.`, isError: true };
    }
    if (!runtime) {
      return {
        content: action === "list" ? "[]" : "No subagent runtime exists for this session.",
        isError: action !== "list",
      };
    }
    const taskId = typeof input.task_id === "string" ? input.task_id : undefined;
    if (action === "list") return { content: JSON.stringify(runtime.list(), null, 2) };
    if (action === "stats") return { content: JSON.stringify(runtime.artifactStats(), null, 2) };
    if (action === "prune") return { content: JSON.stringify(runtime.pruneArtifacts(), null, 2) };
    if (!taskId) return { content: `Task action "${action}" requires task_id.`, isError: true };

    switch (action) {
      case "get": {
        const task = runtime.get(taskId);
        return task
          ? { content: JSON.stringify(task, null, 2) }
          : { content: `Unknown task: ${taskId}`, isError: true };
      }
      case "wait":
      case "watch": {
        try {
          const result = await runtime.wait(
            taskId,
            typeof input.timeout_ms === "number" ? input.timeout_ms : undefined,
          );
          return { content: JSON.stringify(result, null, 2) };
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true };
        }
      }
      case "cancel":
        await runtime.cancel(taskId, input.cascade !== false);
        return { content: `Cancellation requested for ${taskId}.` };
      case "cleanup":
        try {
          await runtime.cleanup(taskId);
          return { content: `Cleaned artifacts and runtime state for ${taskId}.` };
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true };
        }
      case "pin":
        runtime.pin(taskId, true);
        return { content: `Pinned ${taskId}.` };
      case "unpin":
        runtime.pin(taskId, false);
        return { content: `Unpinned ${taskId}.` };
      default:
        return { content: `Unknown Task action: ${action}`, isError: true };
    }
  },
};
