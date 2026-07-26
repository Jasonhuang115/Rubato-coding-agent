import type {
  AgentConfig,
  CompleteTaskInput,
  CoverageManifest,
  StreamRenderer,
  SubagentDefinition,
  SubagentRuntimeContext,
  SubagentTaskStatus,
  ToolDefinition,
} from "../../shared/core-types.js";
import { agentLoop } from "../loop.js";
import { TraceSink } from "./trace-sink.js";
import {
  makesExhaustiveClaim,
  ObservableCoverageTracker,
} from "./coverage.js";

export interface TaskRunnerInput {
  rootSessionId: string;
  parentSessionId: string;
  parentTaskId?: string;
  taskId: string;
  agentId: string;
  depth: number;
  prompt: string;
  definition: SubagentDefinition;
  config: AgentConfig;
  workingDir: string;
  tools: ToolDefinition[];
  coverageRequired: boolean;
  abortSignal: AbortSignal;
  trace: TraceSink;
  onActivity: (activity: string, toolName?: string) => void;
}

export interface TaskRunnerOutput {
  status: SubagentTaskStatus;
  summary: string;
  report: string;
  completion?: CompleteTaskInput;
  coverage?: CoverageManifest;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  error?: string;
}

export class TaskRunner {
  async run(input: TaskRunnerInput): Promise<TaskRunnerOutput> {
    const runtimeContext: SubagentRuntimeContext = {
      rootSessionId: input.rootSessionId,
      taskId: input.taskId,
      agentId: input.agentId,
      parentTaskId: input.parentTaskId,
      depth: input.depth,
      completionSubmitted: false,
      onActivity: input.onActivity,
    };
    const coverageTracker = new ObservableCoverageTracker(
      input.workingDir,
      input.prompt,
      input.coverageRequired,
    );
    runtimeContext.coverage = coverageTracker;
    let completion: CompleteTaskInput | undefined;
    let lastText = "";
    let allText = "";
    let doneReason = "unknown";
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls = 0;
    let error: string | undefined;
    const toolStartedAt = new Map<string, number>();
    const toolCallsById = new Map<string, {
      name: string;
      input: Record<string, unknown>;
    }>();
    const toolEvidence: Array<{
      name: string;
      input: Record<string, unknown>;
      output: string;
      isError: boolean;
    }> = [];

    input.trace.append({
      type: "task_runner_started",
      sessionId: input.rootSessionId,
      taskId: input.taskId,
      agentId: input.agentId,
      parentTaskId: input.parentTaskId,
      depth: input.depth,
    });

    try {
      for await (const event of agentLoop({
        config: input.config,
        workingDir: input.workingDir,
        prompt: input.prompt,
        renderer: NOOP_RENDERER,
        sessionId: input.agentId,
        tools: input.tools,
        depth: input.depth,
        maxTurns: input.definition.maxTurns ?? input.config.subagents?.maxTurns,
        roleSystemPrompt: input.definition.systemPrompt,
        contextProfile: input.definition.name === "compact" ? "compact" : "subagent",
        completionRetryTurns: input.definition.name === "compact" ? 0 : 1,
        abortSignal: input.abortSignal,
        taskRuntime: runtimeContext,
      })) {
        switch (event.type) {
          case "turn_start":
            lastText = "";
            input.onActivity(`model turn ${event.turn}`);
            input.trace.append({
              type: "turn_started",
              sessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              turn: event.turn,
            });
            break;
          case "text":
            lastText += event.text;
            allText += event.text;
            input.onActivity("model streaming");
            input.trace.append({
              type: "model_output",
              sessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              text: event.text,
            });
            break;
          case "tool_call":
            toolCalls++;
            input.onActivity("tool running", event.name);
            toolStartedAt.set(event.id, Date.now());
            toolCallsById.set(event.id, { name: event.name, input: event.input });
            input.trace.append({
              type: "tool_started",
              sessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              scope: "subagent",
              toolId: event.id,
              tool: event.name,
              input: event.input,
            });
            break;
          case "tool_result":
            input.onActivity("tool completed", event.name);
            {
              const startedAt = toolStartedAt.get(event.id);
              toolStartedAt.delete(event.id);
              const call = toolCallsById.get(event.id);
              if (call) {
                coverageTracker.recordToolResult(
                  call.name,
                  call.input,
                  event.result,
                  event.isError,
                );
                toolEvidence.push({
                  name: call.name,
                  input: call.input,
                  output: event.result,
                  isError: event.isError,
                });
              }
            input.trace.append({
              type: "tool_completed",
              sessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              scope: "subagent",
              toolId: event.id,
              tool: event.name,
              output: event.result,
              isError: event.isError,
              security: event.security,
              startedAt,
              durationMs: startedAt === undefined ? undefined : Date.now() - startedAt,
            });
            }
            break;
          case "completion_retry":
            input.trace.append({
              type: "completion_retry_requested",
              sessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              attempt: event.attempt,
            });
            break;
          case "turn_end":
            inputTokens += event.usage?.input ?? 0;
            outputTokens += event.usage?.output ?? 0;
            input.trace.append({
              type: "turn_ended",
              sessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              usage: event.usage,
            });
            break;
          case "task_completion":
            completion = event.completion;
            input.trace.append({
              type: "complete_task",
              sessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              status: completion.status,
              summary: completion.summary,
            });
            break;
          case "error":
            error = event.message;
            input.trace.append({
              type: "runner_error",
              sessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              error,
              retryable: event.retryable,
            });
            break;
          case "done":
            doneReason = event.reason;
            input.trace.append({
              type: "task_runner_stopped",
              sessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              stopReason: event.reason,
            });
            break;
          default:
            break;
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      doneReason = input.abortSignal.aborted ? "cancelled" : "failed";
    }

    const usage = { inputTokens, outputTokens, toolCalls };
    if (completion?.coverage) {
      coverageTracker.applyDeclaration(completion.coverage);
    }
    const coverage = coverageTracker.snapshot();
    if (completion) {
      const exhaustiveGate = coverage.required ||
        completion.coverage?.exhaustive === true ||
        makesExhaustiveClaim(`${completion.summary}\n${completion.report_markdown}`);
      if (completion.status === "completed" && exhaustiveGate && !coverage.complete) {
        return {
          status: "partial",
          summary:
            "Subagent submitted completed, but runtime coverage evidence was incomplete; downgraded to partial.",
          report: appendCoverageGap(completion.report_markdown, coverage),
          completion: { ...completion, status: "partial" },
          coverage,
          usage,
        };
      }
      return {
        status: completion.status,
        summary: completion.summary,
        report: completion.report_markdown,
        completion,
        coverage,
        usage,
      };
    }

    const cancelled = input.abortSignal.aborted || doneReason === "cancelled" || doneReason === "user_interrupt";
    const failed = doneReason === "stream_failed" || doneReason === "max_retries" ||
      doneReason === "circuit_breaker" || doneReason === "failed";
    const fallback = buildRecoveredReport({
      allText,
      lastText,
      doneReason,
      error,
      coverage,
      toolEvidence,
    });
    return {
      status: cancelled ? "cancelled" : failed ? "failed" : "partial",
      summary: cancelled
        ? "Task cancelled before completion."
        : failed
          ? "Task failed before CompleteTask was submitted."
          : "Subagent ended without CompleteTask; preserved as a partial result.",
      report: fallback,
      coverage,
      usage,
      error,
    };
  }
}

function buildRecoveredReport(input: {
  allText: string;
  lastText: string;
  doneReason: string;
  error?: string;
  coverage: CoverageManifest;
  toolEvidence: Array<{
    name: string;
    input: Record<string, unknown>;
    output: string;
    isError: boolean;
  }>;
}): string {
  const accumulated = input.allText.trim() || input.lastText.trim();
  const maxNotes = 64_000;
  const notes = accumulated
    ? accumulated.length <= maxNotes
      ? accumulated
      : `${accumulated.slice(0, maxNotes)}\n\n[Additional accumulated model text omitted: ${accumulated.length - maxNotes} characters]`
    : "(The model produced no narrative notes.)";
  const evidence = input.toolEvidence.slice(-200).map((item) => {
    const target = summarizeToolInput(item.input);
    const normalized = item.output.replace(/\s+/g, " ").trim();
    const preview = normalized.slice(0, 500) || "(empty result)";
    return `- ${item.isError ? "FAILED " : ""}\`${item.name}\` ${target}: ${preview}${normalized.length > 500 ? " …" : ""}`;
  });
  const files = input.coverage.files.map((file) =>
    `- \`${file.path}\` — ${file.status}` +
    `${file.line_count === undefined ? "" : `, ${file.line_count} lines`}` +
    `${file.content_hash ? `, sha256 ${file.content_hash}` : ""}` +
    `${file.reason ? ` (${file.reason})` : ""}`);

  return [
    "# Recovered partial subagent report",
    "",
    "The subagent did not successfully call `CompleteTask` after the runtime finalization retry.",
    `Stop reason: \`${input.doneReason}\`.`,
    input.error ? `Runtime error: ${input.error}` : "",
    "",
    "## Accumulated agent notes",
    "",
    notes,
    "",
    "## Observable tool evidence",
    "",
    evidence.length > 0 ? evidence.join("\n") : "(No completed tool calls were recorded.)",
    "",
    "## Coverage inventory",
    "",
    `discovered=${input.coverage.discovered}, inspected=${input.coverage.inspected}, excluded=${input.coverage.excluded}, failed=${input.coverage.failed}, discovery_complete=${input.coverage.discovery_complete}, complete=${input.coverage.complete}`,
    "",
    files.length > 0 ? files.join("\n") : "(No files were observed.)",
    "",
    "## Remaining uncertainty",
    "",
    input.coverage.gate_satisfied
      ? "The task did not require exhaustive coverage, but its intended synthesis was not formally submitted."
      : input.coverage.notes.join(" "),
  ].filter((line) => line !== "").join("\n");
}

function appendCoverageGap(report: string, coverage: CoverageManifest): string {
  return [
    report.trim(),
    "",
    "## Runtime coverage gate",
    "",
    "The submitted `completed` status was downgraded to `partial` because observable coverage was not closed.",
    `discovered=${coverage.discovered}, inspected=${coverage.inspected}, excluded=${coverage.excluded}, failed=${coverage.failed}, discovery_complete=${coverage.discovery_complete}`,
    ...coverage.notes.map((note) => `- ${note}`),
  ].join("\n");
}

function summarizeToolInput(input: Record<string, unknown>): string {
  const candidate = input.file_path ?? input.path ?? input.pattern ?? input.query;
  if (typeof candidate === "string") return `\`${candidate.slice(0, 300)}\``;
  const serialized = JSON.stringify(input);
  return serialized === "{}" ? "" : `\`${serialized.slice(0, 300)}\``;
}

const NOOP_RENDERER: StreamRenderer = {
  renderUserMessage() {},
  renderAssistantMessage() {},
  renderThinking() {},
  renderSystemMessage() {},
  renderToolUse() {},
  renderToolResult() {},
  renderError() {},
  renderWarning() {},
  clear() {},
  flush() {},
};
