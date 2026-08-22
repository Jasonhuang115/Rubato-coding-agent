import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { ArtifactStore } from "./artifact-store.js";
import { isPrivateReasoningKey, isSecretKey, redactText } from "./redaction.js";
import { OpikTraceSink, type OpikEvent } from "./opik-trace-sink.js";
const LARGE_OUTPUT = 30_000;

export interface TraceEventInput {
  type: string;
  sessionId: string;
  taskId?: string;
  agentId?: string;
  spanId?: string;
  parentSpanId?: string;
  [key: string]: unknown;
}

export class TraceSink {
  readonly traceId: string;
  private sequence = 0;
  private readonly taskSpans = new Map<string, string>();
  private readonly taskRuns = new Map<string, string>();
  private readonly opik?: OpikTraceSink;

  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly context: { conversationId?: string; runId?: string } = {},
  ) {
    const previous = this.readExistingState();
    this.traceId = previous?.traceId ?? randomUUID();
    this.sequence = previous?.sequence ?? 0;
    this.opik = OpikTraceSink.fromEnvironment((sequences) => this.persistOpikSequences(sequences));
  }

  get path(): string {
    return this.artifacts.tracePath;
  }

  append(input: TraceEventInput): void {
    if (isPrivateReasoningKey(input.type)) return;
    if (input.type === "task_started" && input.taskId && typeof input.runId === "string") {
      this.taskRuns.set(input.taskId, input.runId);
    }
    const taskRunId = input.taskId ? this.taskRuns.get(input.taskId) : undefined;
    const taskSpan = input.taskId ? this.taskSpans.get(input.taskId) : undefined;
    const parentTaskId = typeof input.parentTaskId === "string" ? input.parentTaskId : undefined;
    const parentTaskSpan = parentTaskId ? this.taskSpans.get(parentTaskId) : undefined;
    const spanId = input.spanId ?? randomUUID();
    const parentSpanId = input.parentSpanId ??
      (input.type === "task_queued" ? parentTaskSpan : taskSpan);
    if (input.type === "task_queued" && input.taskId) {
      this.taskSpans.set(input.taskId, spanId);
    }
    const event = this.sanitize({
      ...this.context,
      ...(taskRunId ? { runId: taskRunId } : {}),
      ...input,
      traceId: this.traceId,
      spanId,
      parentSpanId,
      sequence: ++this.sequence,
      timestamp: Date.now(),
    }, input.taskId);
    fs.appendFileSync(this.artifacts.tracePath, `${JSON.stringify(event)}\n`, "utf8");
    if (event && typeof event === "object") this.opik?.append(event as OpikEvent);
    if ((input.type === "task_terminal" || input.type === "task_attempt_paused") && input.taskId) {
      this.taskRuns.delete(input.taskId);
    }
  }

  async flush(): Promise<void> {
    await this.opik?.flush();
  }

  async replayUnexported(conversationId: string): Promise<void> {
    if (!this.opik) return;
    for (const tracePath of this.artifacts.listTraceFiles()) {
      const exported = readOpikExported(tracePath);
      if (!fs.existsSync(tracePath)) continue;
      const lines = fs.readFileSync(tracePath, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as OpikEvent;
          const runId = typeof event.runId === "string" ? event.runId : event.sessionId;
          const belongs =
            event.conversationId === conversationId ||
            event.sessionId === conversationId;
          if (
            belongs &&
            typeof event.sequence === "number" &&
            event.sequence > (exported[runId] ?? 0)
          ) {
            this.opik.append(event);
          }
        } catch {
          // Ignore a partially-written final trace line after process interruption.
        }
      }
    }
    await this.opik.flush();
  }

  private persistOpikSequences(sequences: Map<string, number>): void {
    const current = readOpikExported(this.artifacts.tracePath);
    for (const [runId, sequence] of sequences) {
      current[runId] = Math.max(current[runId] ?? 0, sequence);
    }
    writeOpikExported(this.artifacts.tracePath, current);
  }

  private sanitize(value: unknown, taskId?: string, key = ""): unknown {
    if (isPrivateReasoningKey(key)) return undefined;
    if (isSecretKey(key)) return "[REDACTED]";
    if (typeof value === "string") {
      const redacted = redactText(value);
      if (redacted.length > LARGE_OUTPUT) {
        return {
          blob: taskId
            ? this.artifacts.writeBlob(taskId, redacted)
            : this.writeRunBlob(redacted),
        };
      }
      return redacted;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item, taskId, key));
    }
    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        const sanitized = this.sanitize(childValue, taskId, childKey);
        if (sanitized !== undefined) output[childKey] = sanitized;
      }
      return output;
    }
    return value;
  }

  private writeRunBlob(content: string): {
    path: string;
    hash: string;
    length: number;
    preview: string;
  } {
    const blobDir = path.join(this.artifacts.runDir, "blobs");
    fs.mkdirSync(blobDir, { recursive: true });
    const hash = createHash("sha256").update(content).digest("hex");
    const blobPath = path.join(blobDir, `${hash.slice(0, 24)}.txt`);
    if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, content, "utf8");
    return { path: blobPath, hash, length: content.length, preview: content.slice(0, 800) };
  }

  private readExistingState(): { traceId: string; sequence: number } | undefined {
    if (!fs.existsSync(this.artifacts.tracePath)) return undefined;
    const lines = fs.readFileSync(this.artifacts.tracePath, "utf8").trim().split("\n");
    let latest: { traceId: string; sequence: number } | undefined;
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as {
          traceId?: unknown;
          sequence?: unknown;
          type?: unknown;
          taskId?: unknown;
          spanId?: unknown;
          runId?: unknown;
        };
        if (typeof event.traceId === "string" && typeof event.sequence === "number") {
          if (!latest || event.sequence > latest.sequence) {
            latest = { traceId: event.traceId, sequence: event.sequence };
          }
        }
        if (
          event.type === "task_queued" &&
          typeof event.taskId === "string" &&
          typeof event.spanId === "string"
        ) {
          this.taskSpans.set(event.taskId, event.spanId);
        }
        if (
          event.type === "task_started" &&
          typeof event.taskId === "string" &&
          typeof event.runId === "string"
        ) {
          this.taskRuns.set(event.taskId, event.runId);
        }
      } catch {
        // Skip a partially-written tail event after an abnormal process exit.
      }
    }
    return latest;
  }
}

function opikExportPath(tracePath: string): string {
  return path.join(path.dirname(tracePath), "opik-exported-seq.json");
}

function readOpikExported(tracePath: string): Record<string, number> {
  const filePath = opikExportPath(tracePath);
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const [runId, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) result[runId] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writeOpikExported(tracePath: string, sequences: Record<string, number>): void {
  const filePath = opikExportPath(tracePath);
  const temp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(sequences, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}
