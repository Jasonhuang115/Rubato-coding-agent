import fs from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { ArtifactStore } from "./artifact-store.js";
import { isPrivateReasoningKey, isSecretKey, redactText } from "./redaction.js";
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

  constructor(private readonly artifacts: ArtifactStore) {
    const previous = this.readExistingState();
    this.traceId = previous?.traceId ?? randomUUID();
    this.sequence = previous?.sequence ?? 0;
  }

  append(input: TraceEventInput): void {
    if (isPrivateReasoningKey(input.type)) return;
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
      ...input,
      traceId: this.traceId,
      spanId,
      parentSpanId,
      sequence: ++this.sequence,
      timestamp: Date.now(),
    }, input.taskId);
    fs.appendFileSync(this.artifacts.tracePath, `${JSON.stringify(event)}\n`, "utf8");
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
      } catch {
        // Skip a partially-written tail event after an abnormal process exit.
      }
    }
    return latest;
  }
}
