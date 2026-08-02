import fs from "fs";
import type {
  AgentTaskInput,
  TaskResult,
  ToolDefinition,
} from "../shared/core-types.js";
import { findDefinition, getAllDefinitions } from "../agent/agent-defs.js";
import {
  getBuiltinDefinition,
  resolveSubagentTools,
} from "../agent/subagent.js";
import { processSubagentRegistry } from "../agent/subagents/registry.js";

// Leave a deterministic ceiling for the complete result, including absolute
// artifact paths whose length varies with RUBATO_HOME and the project hash.
const RESULT_MAX_LENGTH = 4_800;

export const agentTool: ToolDefinition = {
  name: "Agent",
  description:
    "Create a fresh-context subagent task. Read-only agents investigate and report; the worker " +
    "implements, tests, and commits in an isolated Git worktree. " +
    "Use dependency='advisory' when the root has other independent work it can do now; the result may " +
    "still be required at final synthesis. Use dependency='required' only when no safe useful next action " +
    "is possible until this result arrives.",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short task description" },
      prompt: {
        type: "string",
        description: "Self-contained objective, scope, constraints, necessary context, and expected output",
      },
      subagent_type: {
        type: "string",
        description: "explore | research | general | verify | custom definition",
      },
      dependency: {
        type: "string",
        enum: ["advisory", "required"],
        description: "Scheduling dependency: advisory=work can continue now; required=immediate next action is blocked",
      },
      model: { type: "string" },
      timeout_ms: { type: "number" },
      coverage: {
        type: "string",
        enum: ["auto", "exhaustive"],
        description:
          "Use exhaustive when the assignment promises every-file/every-line inspection; runtime coverage must close before completed is accepted.",
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
    required: ["description", "prompt", "dependency"],
  },
  // Orchestration is non-mutating with respect to the project workspace.
  type: "read",
  isConcurrencySafe: false,
  requiresApproval: false,
  async handler(rawInput, ctx) {
    const description = String(rawInput.description ?? "").trim();
    const prompt = String(rawInput.prompt ?? "").trim();
    if (!description || !prompt) {
      return { content: "Agent requires non-empty description and prompt.", isError: true };
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
        return {
          content: "Plan mode does not allow worktree isolation or write scopes.",
          isError: true,
        };
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

    const requestedDependency = rawInput.dependency === "advisory"
      ? "advisory"
      : "required";
    const dependency = ctx.taskRuntime ? "required" : requestedDependency;
    const requestedIsolation = rawInput.isolation === "worktree"
      ? "worktree"
      : undefined;
    const isolation = requestedIsolation ?? definition.isolation;
    const requestsMutation = definition.tools.includes("*") ||
      definition.tools.some((name) => ["Write", "Edit", "Bash"].includes(name));
    if (ctx.mode === "plan" && requestsMutation) {
      return { content: "Plan mode blocked a subagent definition with mutation tools.", isError: true };
    }
    if (requestsMutation && isolation !== "worktree") {
      return {
        content:
          `Subagent "${definition.name}" requests mutation tools but is not worktree-isolated. ` +
          "Set isolation=\"worktree\" on the definition or Agent call.",
        isError: true,
      };
    }
    if (requestsMutation && ctx.taskRuntime) {
      return {
        content: "Worktree writers cannot be spawned recursively; delegate this writer from the root Agent.",
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
        content:
          `Subagent "${definition.name}" is a writer and requires a non-empty scope of ` +
          "repository-relative files or directories.",
        isError: true,
      };
    }
    const input: AgentTaskInput = {
      description,
      prompt,
      subagent_type: definition.name,
      dependency,
      model: typeof rawInput.model === "string" ? rawInput.model : undefined,
      timeout_ms: typeof rawInput.timeout_ms === "number" ? rawInput.timeout_ms : undefined,
      coverage: rawInput.coverage === "exhaustive" ? "exhaustive" : "auto",
      isolation,
      scope,
      mode: ctx.mode,
    };
    const rootSessionId = ctx.taskRuntime?.rootSessionId ?? ctx.sessionId;
    const runtime = processSubagentRegistry.getOrCreate(rootSessionId, ctx.workingDir, ctx.config);
    const depth = (ctx.taskRuntime?.depth ?? ctx.depth ?? 0) + 1;
    const effectiveDefinition = isolation === definition.isolation
      ? definition
      : { ...definition, isolation };
    const tools = resolveSubagentTools(
      effectiveDefinition,
      depth,
      runtime.limits.maxDepth,
      isolation === "worktree",
    );
    const submitted = runtime.submit(input, ctx, effectiveDefinition, tools);

    if (dependency === "advisory") {
      return {
        content: [
          `Background task queued: ${submitted.task.taskId}`,
          `Status: ${submitted.task.status}`,
          `Report: ${submitted.task.artifacts.report}`,
          `Result: ${submitted.task.artifacts.result}`,
          `Coverage: ${submitted.task.artifacts.coverage}`,
          "The parent may continue and provide an initial answer. Completion will be delivered through the session inbox.",
        ].filter(Boolean).join("\n"),
      };
    }

    // Keep required tasks visibly alive without flooding the terminal. Detailed
    // activity stays in trace; the interactive UI only redraws one compact line.
    const stopProgress = startRequiredProgressIndicator(
      runtime,
      submitted.task.taskId,
      description,
    );
    let result: TaskResult;
    try {
      result = await submitted.result;
    } finally {
      stopProgress();
    }
    return {
      content: formatRequiredResult(result),
      isError: result.status === "failed" || result.status === "timed_out" ||
        result.status === "cancelled" || result.status === "orphaned",
    };
  },
};

function formatRequiredResult(result: TaskResult): string {
  const metadata = [
    `Task completed: ${result.summary}`,
    `Task ID: ${result.taskId}`,
    `Status: ${result.status}`,
    `Report: ${result.reportPath}`,
    `Result: ${result.resultPath}`,
    `Transcript: ${result.transcriptPath}`,
    `Coverage: ${result.coveragePath}`,
    result.workspace ? `Worktree: ${result.workspace.path}` : "",
    result.workspace ? `Branch: ${result.workspace.branch}` : "",
    result.workspace ? `Base commit: ${result.workspace.baseCommit}` : "",
    result.workspace ? `Head commit: ${result.workspace.headCommit}` : "",
    result.workspace ? `Commits: ${result.workspace.commits.join(", ") || "(none)"}` : "",
    result.workspace ? `Changed files: ${result.workspace.filesChanged.join(", ") || "(none)"}` : "",
    result.workspace ? `Dirty: ${result.workspace.dirty}` : "",
    result.workspace ? `Patch: ${result.workspace.patchPath}` : "",
    "",
    "Report preview:",
  ].filter((line) => line !== "").join("\n");
  const previewBudget = Math.max(
    0,
    RESULT_MAX_LENGTH - metadata.length - 1,
  );
  let preview = "";
  try {
    preview = fs.readFileSync(result.reportPath, "utf8").slice(0, previewBudget);
  } catch {
    preview = "(report could not be read)".slice(0, previewBudget);
  }
  return `${metadata}\n${preview}`;
}

function startRequiredProgressIndicator(
  runtime: ReturnType<typeof processSubagentRegistry.getOrCreate>,
  taskId: string,
  description: string,
): () => void {
  if (!process.stderr.isTTY) return () => {};

  const label = compactLabel(description, 44);
  let stopped = false;

  const render = () => {
    if (stopped) return;
    const task = runtime.get(taskId);
    if (!task || task.endedAt) return;
    const elapsed = formatDuration(Date.now() - (task.startedAt ?? task.createdAt));
    const childSuffix = task.childCount > 0 ? ` · ${task.childCount} 个子任务` : "";
    process.stderr.write(
      `\r\x1b[2K  … Subagent：${label} · ${elapsed}${childSuffix} · Ctrl+C 取消`,
    );
  };

  render();
  const unsubscribe = runtime.subscribe((task) => {
    if (task.taskId === taskId) render();
  });
  // Elapsed time is informational, not an animation. Refreshing every five
  // seconds keeps required work visibly alive without making the terminal
  // look stuck or repainting continuously.
  const timer = setInterval(render, 5_000);
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    process.stderr.write("\r\x1b[2K");
  };
}

function compactLabel(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
