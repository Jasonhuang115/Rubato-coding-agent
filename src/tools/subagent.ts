import type { AgentTaskInput, ToolDefinition } from "../shared/core-types.js";
import { findDefinition, getAllDefinitions } from "../agent/agent-defs.js";
import {
  getBuiltinDefinition,
  resolveSubagentTools,
} from "../agent/subagent.js";
import { processSubagentRegistry } from "../agent/subagents/registry.js";

export const subagentTool: ToolDefinition = {
  name: "Subagent",
  description:
    "Queue a fresh-context background subagent. The call returns immediately with a unique task ID " +
    "and durable report path. timeout_ms is a generous safety ceiling that prevents a stuck task; " +
    "it is not a work budget and must not be used to shrink the requested scope.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short task description" },
      prompt: {
        type: "string",
        description: "Self-contained objective, scope, constraints, context, and expected evidence",
      },
      subagent_type: {
        type: "string",
        description: "explore | research | general | verify | worker | custom definition",
      },
      model: { type: "string" },
      timeout_ms: {
        type: "number",
        description:
          "Required generous safety timeout in milliseconds. This only stops a permanently stuck task; it is not a target duration.",
      },
      coverage: {
        type: "string",
        enum: ["auto", "exhaustive"],
        description: "Use exhaustive when every-file/every-line inspection is required.",
      },
      isolation: {
        type: "string",
        enum: ["worktree"],
        description: "Run this task in an isolated Git worktree.",
      },
      scope: {
        type: "array",
        items: { type: "string" },
        description: "Expected non-overlapping repository-relative files or directories.",
      },
    },
    required: ["description", "prompt", "timeout_ms"],
  },
  type: "read",
  isConcurrencySafe: false,
  requiresApproval: false,
  async handler(rawInput, ctx) {
    if (ctx.taskRuntime) {
      return { content: "Only the root agent can queue Subagent tasks.", isError: true };
    }
    const description = String(rawInput.description ?? "").trim();
    const prompt = String(rawInput.prompt ?? "").trim();
    const timeoutMs = rawInput.timeout_ms;
    if (!description || !prompt) {
      return { content: "Subagent requires non-empty description and prompt.", isError: true };
    }
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { content: "Subagent requires timeout_ms to be a positive finite number.", isError: true };
    }

    const subagentType = String(rawInput.subagent_type ?? "general");
    if (ctx.mode === "plan") {
      const allowedTypes = new Set(["explore", "research", "general", "verify"]);
      if (!allowedTypes.has(subagentType)) {
        return {
          content: `Plan mode allows only explore, research, general, or verify subagents; received "${subagentType}".`,
          isError: true,
        };
      }
      if (rawInput.isolation !== undefined || rawInput.scope !== undefined) {
        return { content: "Plan mode does not allow worktree isolation or write scopes.", isError: true };
      }
    }

    let definition;
    try {
      definition = getBuiltinDefinition(subagentType);
    } catch {
      definition = await findDefinition(subagentType);
      if (!definition) {
        const definitions = await getAllDefinitions();
        return {
          content: `Unknown subagent type "${subagentType}". Available: ${definitions.map((item) => item.name).join(", ")}.`,
          isError: true,
        };
      }
    }

    const requestedIsolation = rawInput.isolation === "worktree" ? "worktree" : undefined;
    const isolation = requestedIsolation ?? definition.isolation;
    const requestsMutation = definition.tools.includes("*") ||
      definition.tools.some((name) => ["Write", "Edit", "Bash"].includes(name));
    if (ctx.mode === "plan" && requestsMutation) {
      return { content: "Plan mode blocked a subagent definition with mutation tools.", isError: true };
    }
    if (requestsMutation && isolation !== "worktree") {
      return {
        content: `Subagent "${definition.name}" requests mutation tools but is not worktree-isolated.`,
        isError: true,
      };
    }
    const scope = Array.isArray(rawInput.scope)
      ? rawInput.scope.filter((item): item is string =>
          typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
      : undefined;
    if (requestsMutation && !scope?.length) {
      return {
        content: `Subagent "${definition.name}" is a writer and requires a non-empty scope.`,
        isError: true,
      };
    }

    const input: AgentTaskInput = {
      description,
      prompt,
      subagent_type: definition.name,
      model: typeof rawInput.model === "string" ? rawInput.model : undefined,
      timeout_ms: timeoutMs,
      coverage: rawInput.coverage === "exhaustive" ? "exhaustive" : "auto",
      isolation,
      scope,
      mode: ctx.mode,
    };
    const runtime = processSubagentRegistry.getOrCreate(ctx.sessionId, ctx.workingDir, ctx.config);
    const effectiveDefinition = isolation === definition.isolation
      ? definition
      : { ...definition, isolation };
    const tools = resolveSubagentTools(effectiveDefinition, isolation === "worktree");
    const submitted = runtime.submit(input, ctx, effectiveDefinition, tools);

    return {
      content: [
        `Background Subagent dispatched: ${submitted.task.taskId}`,
        `Status: ${submitted.task.status}`,
        `Task directory: ${submitted.task.artifacts.taskDir}`,
        `Report: ${submitted.task.artifacts.report}`,
      ].join("\n"),
    };
  },
};
