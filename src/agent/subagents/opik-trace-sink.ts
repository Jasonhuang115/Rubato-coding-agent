import { createHash } from "node:crypto";
import { Opik, type Span, type Trace } from "opik";
import { warnRecoverable } from "../../shared/diagnostics.js";
import { isPrivateReasoningKey } from "./redaction.js";

const REMOTE_TEXT_LIMIT = 8_000;

export interface OpikEvent {
  type: string;
  sessionId: string;
  conversationId?: string;
  runId?: string;
  taskId?: string;
  toolId?: string;
  tool?: string;
  spanId?: string;
  sequence?: number;
  timestamp?: number;
  [key: string]: unknown;
}

interface OpikClientLike {
  trace(data: Parameters<Opik["trace"]>[0]): Trace;
  flush(options?: { silent?: boolean }): Promise<void>;
}

export class OpikTraceSink {
  private readonly traces = new Map<string, Trace>();
  private readonly spans = new Map<string, Span>();
  private readonly maxSequenceByRun = new Map<string, number>();

  constructor(
    private readonly client: OpikClientLike,
    private readonly persistSequences?: (sequences: Map<string, number>) => void,
  ) {}

  static fromEnvironment(
    persistSequences?: (sequences: Map<string, number>) => void,
  ): OpikTraceSink | undefined {
    if (!/^(1|true|yes|on)$/i.test(process.env.OPIK_ENABLED ?? "")) return undefined;
    try {
      const client = new Opik({
        ...(process.env.OPIK_API_KEY ? { apiKey: process.env.OPIK_API_KEY } : {}),
        ...(process.env.OPIK_URL_OVERRIDE ? { apiUrl: process.env.OPIK_URL_OVERRIDE } : {}),
        ...(process.env.OPIK_WORKSPACE ? { workspaceName: process.env.OPIK_WORKSPACE } : {}),
        projectName: process.env.OPIK_PROJECT_NAME ?? "rubato",
        batchDelayMs: 300,
      });
      return new OpikTraceSink(client, persistSequences);
    } catch (error) {
      warnRecoverable("opik:initialize", error);
      return undefined;
    }
  }

  append(rawEvent: OpikEvent): void {
    if (isPrivateReasoningKey(rawEvent.type)) return;
    try {
      const event = remoteSafe(rawEvent) as OpikEvent;
      const runId = typeof event.runId === "string" ? event.runId : event.sessionId;
      if (typeof event.sequence === "number") {
        this.maxSequenceByRun.set(
          runId,
          Math.max(this.maxSequenceByRun.get(runId) ?? 0, event.sequence),
        );
      }
      switch (event.type) {
        case "root_session_started":
          this.startTrace(`root:${runId}`, event, "rubato.root_run", {
            input: pick(event, ["prompt"]),
            tags: ["rubato", "root"],
          });
          break;
        case "task_started":
          this.startTrace(`task:${event.taskId}`, event, "rubato.subagent_attempt", {
            tags: ["rubato", "subagent"],
          });
          break;
        case "root_turn_started":
          this.startSpan(`turn:${runId}:${String(event.turn)}`, `root:${runId}`, event, "model.turn", "llm");
          break;
        case "tool_started": {
          const traceKey = event.scope === "root" ? `root:${runId}` : `task:${event.taskId}`;
          this.startSpan(`tool:${event.toolId}`, traceKey, event, String(event.tool ?? "tool"), "tool");
          break;
        }
        case "tool_completed":
          this.endSpan(`tool:${event.toolId}`, event);
          break;
        case "root_turn_completed":
          this.endSpan(`turn:${runId}:${String(event.turn)}`, event);
          break;
        case "root_turn_failed":
          this.endSpan(`turn:${runId}:${String(event.turn)}`, event, true);
          break;
        case "task_attempt_paused":
          this.endTrace(`task:${event.taskId}`, event, true);
          break;
        case "task_terminal":
          this.endTrace(`task:${event.taskId}`, event, event.status === "failed");
          break;
        case "root_session_ended":
          this.endTrace(`root:${runId}`, event, failureReason(event.reason));
          break;
        default:
          break;
      }
    } catch (error) {
      warnRecoverable("opik:append", error);
    }
  }

  async flush(timeoutMs = 2_000): Promise<void> {
    try {
      await withTimeout(this.client.flush({ silent: true }), timeoutMs);
      if (this.maxSequenceByRun.size > 0) {
        this.persistSequences?.(new Map(this.maxSequenceByRun));
      }
    } catch (error) {
      warnRecoverable("opik:flush", error);
    }
  }

  private startTrace(
    key: string,
    event: OpikEvent,
    name: string,
    extra: { input?: unknown; tags?: string[] },
  ): void {
    this.traces.get(key)?.end();
    const trace = this.client.trace({
      ...(isUuid(event.spanId) ? { id: event.spanId } : {}),
      name,
      threadId: event.conversationId ?? event.sessionId,
      startTime: new Date(Number(event.timestamp ?? Date.now())),
      input: extra.input as Parameters<Opik["trace"]>[0]["input"],
      metadata: pick(event, ["runId", "taskId", "agentId", "model", "provider", "attempt"]),
      tags: extra.tags,
    });
    this.traces.set(key, trace);
  }

  private endTrace(key: string, event: OpikEvent, failed = false): void {
    const trace = this.traces.get(key);
    if (!trace) return;
    trace.update({
      output: pick(event, ["status", "reason", "usage", "failureKind"]),
      endTime: new Date(Number(event.timestamp ?? Date.now())),
      ...(failed ? { errorInfo: errorInfo(event) } : {}),
    });
    trace.end();
    this.traces.delete(key);
  }

  private startSpan(
    key: string,
    traceKey: string,
    event: OpikEvent,
    name: string,
    type: "llm" | "tool",
  ): void {
    const trace = this.traces.get(traceKey);
    if (!trace) return;
    const span = trace.span({
      ...(isUuid(event.spanId) ? { id: event.spanId } : {}),
      name,
      type,
      startTime: new Date(Number(event.timestamp ?? Date.now())),
      input: pick(event, ["input", "turn"]),
      metadata: pick(event, ["toolId", "taskId", "scope"]),
    });
    this.spans.set(key, span);
  }

  private endSpan(key: string, event: OpikEvent, failed = false): void {
    const span = this.spans.get(key);
    if (!span) return;
    span.update({
      output: pick(event, ["output", "modelOutput", "usage", "stopReason", "isError"]),
      endTime: new Date(Number(event.timestamp ?? Date.now())),
      ...(failed || event.isError ? { errorInfo: errorInfo(event) } : {}),
    });
    span.end();
    this.spans.delete(key);
  }
}

function pick(value: OpikEvent, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function errorInfo(event: OpikEvent): { message: string; exceptionType: string; traceback: string } {
  const message = typeof event.error === "string"
    ? event.error
    : String(event.failureKind ?? event.reason ?? "Agent run failed");
  return { message, exceptionType: String(event.failureKind ?? "AgentError"), traceback: "" };
}

function failureReason(reason: unknown): boolean {
  return new Set(["circuit_breaker", "max_retries", "stream_failed", "user_interrupt"])
    .has(String(reason ?? ""));
}

function remoteSafe(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (/path|directory|worktree|report/i.test(key) && value.startsWith("/")) {
      return "[LOCAL_PATH]";
    }
    if (value.length <= REMOTE_TEXT_LIMIT) return value;
    return {
      hash: createHash("sha256").update(value).digest("hex"),
      length: value.length,
      preview: value.slice(0, 800),
    };
  }
  if (Array.isArray(value)) return value.map((item) => remoteSafe(item, key));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (isPrivateReasoningKey(childKey)) continue;
      result[childKey] = remoteSafe(childValue, childKey);
    }
    return result;
  }
  return value;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Opik flush exceeded ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}
