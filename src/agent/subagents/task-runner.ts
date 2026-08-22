import type {
  AgentConfig,
  CoverageManifest,
  StreamRenderer,
  SubagentDefinition,
  SubagentFailureKind,
  SubagentRuntimeContext,
  SubagentTaskStatus,
  ToolDefinition,
} from "../../shared/core-types.js";
import { agentLoop } from "../loop.js";
import { AgentModeController } from "../mode.js";
import { TraceSink } from "./trace-sink.js";
import { ObservableCoverageTracker } from "./coverage.js";

const REPORT_FLUSH_MS = 100;
const REPORT_FLUSH_BYTES = 4 * 1024;

export interface TaskRunnerInput {
  rootSessionId: string;
  taskId: string;
  agentId: string;
  prompt: string;
  definition: SubagentDefinition;
  config: AgentConfig;
  workingDir: string;
  tools: ToolDefinition[];
  coverageRequired: boolean;
  abortSignal: AbortSignal;
  trace: TraceSink;
  appendReport: (content: string) => void;
  registerReportFlusher?: (flush: () => void) => void;
  onActivity: (activity: string, toolName?: string) => void;
  mode?: "default" | "plan";
  reportPath?: string;
  writableWorkspace?: boolean;
  editReport?: SubagentRuntimeContext["editReport"];
  takePlanReminder?: () => string | undefined;
}

export interface TaskRunnerOutput {
  status: SubagentTaskStatus;
  failureKind?: SubagentFailureKind;
  coverage: CoverageManifest;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  error?: string;
}

export class TaskRunner {
  async run(input: TaskRunnerInput): Promise<TaskRunnerOutput> {
    let reportBuffer = "";
    let reportTimer: ReturnType<typeof setTimeout> | undefined;
    let hasReportContent = false;
    const flushReport = () => {
      if (reportTimer) clearTimeout(reportTimer);
      reportTimer = undefined;
      if (!reportBuffer) return;
      input.appendReport(reportBuffer);
      reportBuffer = "";
    };
    const appendReport = (text: string) => {
      if (!text) return;
      if (/\S/.test(text)) hasReportContent = true;
      reportBuffer += text;
      if (Buffer.byteLength(reportBuffer, "utf8") >= REPORT_FLUSH_BYTES) {
        flushReport();
      } else if (!reportTimer) {
        reportTimer = setTimeout(flushReport, REPORT_FLUSH_MS);
        reportTimer.unref?.();
      }
    };
    input.registerReportFlusher?.(flushReport);

    const runtimeContext: SubagentRuntimeContext = {
      rootSessionId: input.rootSessionId,
      taskId: input.taskId,
      agentId: input.agentId,
      reportPath: input.reportPath,
      writableWorkspace: input.writableWorkspace,
      onActivity: input.onActivity,
      onTextDelta: appendReport,
      onTextFlush: flushReport,
      editReport: input.editReport,
      takePlanReminder: input.takePlanReminder,
    };
    const coverageTracker = new ObservableCoverageTracker(
      input.workingDir,
      input.prompt,
      input.coverageRequired,
    );
    runtimeContext.coverage = coverageTracker;
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

    input.trace.append({
      type: "task_runner_started",
      sessionId: input.rootSessionId,
      taskId: input.taskId,
      agentId: input.agentId,
    });

    try {
      const modeController = new AgentModeController();
      if (input.mode === "plan") modeController.enablePlan();
      for await (const event of agentLoop({
        config: input.config,
        workingDir: input.workingDir,
        prompt: input.prompt,
        renderer: NOOP_RENDERER,
        sessionId: input.agentId,
        tools: input.tools,
        roleSystemPrompt: input.definition.systemPrompt,
        contextProfile: input.definition.name === "compact" ? "compact" : "subagent",
        abortSignal: input.abortSignal,
        taskRuntime: runtimeContext,
        modeController,
      })) {
        switch (event.type) {
          case "turn_start":
            input.onActivity(`model turn ${event.turn}`);
            input.trace.append({
              type: "turn_started",
              sessionId: input.rootSessionId,
              taskId: input.taskId,
              agentId: input.agentId,
              turn: event.turn,
            });
            break;
          case "tool_call":
            flushReport();
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
          case "tool_result": {
            input.onActivity("tool completed", event.name);
            const startedAt = toolStartedAt.get(event.id);
            const call = toolCallsById.get(event.id);
            if (call) {
              coverageTracker.recordToolResult(call.name, call.input, event.result, event.isError);
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
            break;
          }
          case "turn_end":
            flushReport();
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
          case "error":
            error = event.message;
            appendReport(`\n\n<!-- Rubato stream interrupted: ${event.message.replace(/-->/g, "--&gt;")} -->\n\n`);
            flushReport();
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
            break;
          default:
            break;
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      doneReason = input.abortSignal.aborted ? "cancelled" : "failed";
    } finally {
      flushReport();
    }

    const coverage = coverageTracker.snapshot();
    const usage = { inputTokens, outputTokens, toolCalls };
    if (input.abortSignal.aborted) {
      return { status: "failed", failureKind: "cancelled", coverage, usage, error };
    }
    if (doneReason === "end_turn" && !hasReportContent) {
      return {
        status: "failed",
        failureKind: "empty_report",
        coverage,
        usage,
        error: "Subagent ended without writing useful report content.",
      };
    }
    if (coverage.required && !coverage.complete) {
      return {
        status: "failed",
        failureKind: "coverage_incomplete",
        coverage,
        usage,
        error: coverage.notes.join(" "),
      };
    }
    if (doneReason === "end_turn") {
      return { status: "finished", coverage, usage };
    }
    return {
      status: "failed",
      failureKind: "model_error",
      coverage,
      usage,
      error: error ?? `Subagent stopped with reason: ${doneReason}`,
    };
  }
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
