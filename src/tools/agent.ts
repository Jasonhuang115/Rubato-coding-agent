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

// Leave room for task metadata so the entire tool result stays below the
// parent's 4,000-character preview budget in practice.
const RESULT_PREVIEW_LENGTH = 3_500;

export const agentTool: ToolDefinition = {
  name: "Agent",
  description:
    "Create a fresh-context, read-only subagent task. Subagents investigate, research, " +
    "verify, decompose, and return Markdown reports; they cannot edit files, run Bash, or use Git. " +
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
      run_in_background: {
        type: "boolean",
        description: "Deprecated compatibility alias: true=advisory, false=required",
      },
      isolation: {
        type: "string",
        description: "Deprecated compatibility input. Accepted but ignored; no worktree is created.",
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

    const requestedDependency = rawInput.dependency === "advisory" ||
      rawInput.dependency === "required"
      ? rawInput.dependency
      : rawInput.run_in_background === true
        ? "advisory"
        : "required";
    const dependency = ctx.taskRuntime ? "required" : requestedDependency;
    const input: AgentTaskInput = {
      description,
      prompt,
      subagent_type: definition.name,
      dependency,
      model: typeof rawInput.model === "string" ? rawInput.model : undefined,
      timeout_ms: typeof rawInput.timeout_ms === "number" ? rawInput.timeout_ms : undefined,
      coverage: rawInput.coverage === "exhaustive" ? "exhaustive" : "auto",
    };
    const rootSessionId = ctx.taskRuntime?.rootSessionId ?? ctx.sessionId;
    const runtime = processSubagentRegistry.getOrCreate(rootSessionId, ctx.workingDir, ctx.config);
    const depth = (ctx.taskRuntime?.depth ?? ctx.depth ?? 0) + 1;
    const tools = resolveSubagentTools(definition, depth, runtime.limits.maxDepth);
    const submitted = runtime.submit(input, ctx, definition, tools);
    const deprecation = rawInput.isolation === "worktree"
      ? "\nDeprecated: isolation=worktree was ignored; this read-only task did not create a worktree."
      : "";

    if (dependency === "advisory") {
      return {
        content: [
          `Background task queued: ${submitted.task.taskId}`,
          `Status: ${submitted.task.status}`,
          `Report: ${submitted.task.artifacts.report}`,
          `Result: ${submitted.task.artifacts.result}`,
          `Coverage: ${submitted.task.artifacts.coverage}`,
          "The parent may continue and provide an initial answer. Completion will be delivered through the session inbox.",
          deprecation,
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
      content: formatRequiredResult(result, deprecation),
      isError: result.status === "failed" || result.status === "timed_out" ||
        result.status === "cancelled" || result.status === "orphaned",
    };
  },
};

function formatRequiredResult(result: TaskResult, deprecation: string): string {
  let preview = "";
  try {
    preview = fs.readFileSync(result.reportPath, "utf8").slice(0, RESULT_PREVIEW_LENGTH);
  } catch {
    preview = "(report could not be read)";
  }
  return [
    `Task completed: ${result.summary}`,
    `Task ID: ${result.taskId}`,
    `Status: ${result.status}`,
    `Report: ${result.reportPath}`,
    `Result: ${result.resultPath}`,
    `Transcript: ${result.transcriptPath}`,
    `Coverage: ${result.coveragePath}`,
    deprecation,
    "",
    "Report preview:",
    preview,
  ].filter((line) => line !== "").join("\n");
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
