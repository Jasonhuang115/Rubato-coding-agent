import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { projectMemoryId } from "./paths.js";
import { memoryPurgeFingerprint } from "./release.js";

export type MemoryControlAction =
  | "correct"
  | "forget"
  | "retire"
  | "undo"
  | "pause_learning"
  | "resume_learning";

export interface AppendMemoryControlEventInput {
  action: MemoryControlAction;
  workingDir: string;
  rootDir: string;
  target?: string;
  value?: string;
  occurredAt?: string;
}

export interface MemoryControlEventBody {
  schema: "rubato.memory.control-event/v1";
  event_id: string;
  project_id: string;
  actor: "user";
  action: MemoryControlAction;
  target_fingerprint?: string;
  value_fingerprint?: string;
  occurred_at: string;
}

export interface MemoryControlEvent extends MemoryControlEventBody {
  seq: number;
  prev_hash: string | null;
  hash: string;
}

const ACTIONS = new Set<MemoryControlAction>([
  "correct",
  "forget",
  "retire",
  "undo",
  "pause_learning",
  "resume_learning",
]);

/**
 * This is a dedicated hash chain for explicit user-control commands. It is not
 * a fake session event: card evidence points to `control:<project_id>` and the
 * exact seq/hash in this independently verifiable file.
 *
 * Raw targets and values are intentionally not duplicated. Domain-separated
 * fingerprints prove which command the event binds while leaving no plaintext
 * copy for hard purge to chase.
 */
export function appendMemoryControlEvent(
  input: AppendMemoryControlEventInput,
): MemoryControlEvent {
  validateInput(input);
  const filePath = controlEventPath(input.rootDir);
  return withFileLock(`${filePath}.lock`, () => {
    const existing = listMemoryControlEvents(input.rootDir);
    const body: MemoryControlEventBody = {
      schema: "rubato.memory.control-event/v1",
      event_id: randomUUID(),
      project_id: projectMemoryId(input.workingDir),
      actor: "user",
      action: input.action,
      ...(input.target
        ? {
            target_fingerprint: targetFingerprint(
              input.action,
              input.target,
            ),
          }
        : {}),
      ...(input.value
        ? {
            value_fingerprint: memoryPurgeFingerprint(
              "value",
              input.value,
            ),
          }
        : {}),
      occurred_at: input.occurredAt ?? new Date().toISOString(),
    };
    const event = chainEvent(body, existing.length, existing.at(-1)?.hash ?? null);
    writeChain([...existing, event], filePath);
    return event;
  });
}

export function listMemoryControlEvents(rootDir: string): MemoryControlEvent[] {
  const filePath = controlEventPath(rootDir);
  if (!fs.existsSync(filePath)) return [];
  const events = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => parseEvent(line, index + 1));
  verifyChain(events);
  return events;
}

/**
 * Rebuilds seq/prev_hash/hash after privacy filtering. Callers that coordinate
 * with another writer should hold `${controlEventPath(rootDir)}.lock`.
 */
export function rewriteMemoryControlEvents(
  events: ReadonlyArray<MemoryControlEventBody>,
  rootDir: string,
): MemoryControlEvent[] {
  const rebuilt: MemoryControlEvent[] = [];
  for (const body of events) {
    validateBody(body);
    rebuilt.push(chainEvent(
      body,
      rebuilt.length,
      rebuilt.at(-1)?.hash ?? null,
    ));
  }
  writeChain(rebuilt, controlEventPath(rootDir));
  return rebuilt;
}

export function controlEventPath(rootDir: string): string {
  return path.join(path.resolve(rootDir), "memory", "control-events.jsonl");
}

function chainEvent(
  body: MemoryControlEventBody,
  seq: number,
  prevHash: string | null,
): MemoryControlEvent {
  const unsigned = {
    ...body,
    seq,
    prev_hash: prevHash,
  };
  return {
    ...unsigned,
    hash: createHash("sha256")
      .update(JSON.stringify(unsigned))
      .digest("hex"),
  };
}

function parseEvent(line: string, lineNumber: number): MemoryControlEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Malformed memory control event on line ${lineNumber}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(raw)) {
    throw new Error(`Memory control event ${lineNumber} must be an object.`);
  }
  const event = raw as unknown as MemoryControlEvent;
  validateBody(event);
  if (
    !Number.isInteger(event.seq) ||
    event.seq < 0 ||
    (event.prev_hash !== null && !isHash(event.prev_hash)) ||
    !isHash(event.hash)
  ) {
    throw new Error(`Memory control event ${lineNumber} has invalid chain fields.`);
  }
  return event;
}

function verifyChain(events: MemoryControlEvent[]): void {
  let previous: string | null = null;
  for (const [index, event] of events.entries()) {
    if (event.seq !== index || event.prev_hash !== previous) {
      throw new Error(`Memory control event chain breaks at seq ${index}.`);
    }
    const { hash, ...unsigned } = event;
    const expected = createHash("sha256")
      .update(JSON.stringify(unsigned))
      .digest("hex");
    if (hash !== expected) {
      throw new Error(`Memory control event hash mismatch at seq ${index}.`);
    }
    previous = hash;
  }
}

function validateInput(input: AppendMemoryControlEventInput): void {
  if (!ACTIONS.has(input.action)) throw new Error("Invalid memory control action.");
  if (!input.rootDir.trim()) throw new Error("Memory control rootDir is required.");
  if (!input.workingDir.trim()) {
    throw new Error("Memory control workingDir is required.");
  }
  if (
    (input.action === "correct" ||
      input.action === "forget" ||
      input.action === "retire") &&
    !input.target?.trim()
  ) {
    throw new Error(`${input.action} requires a target.`);
  }
  if (input.action === "correct" && !input.value?.trim()) {
    throw new Error("correct requires a value.");
  }
  if (input.occurredAt && !validTimestamp(input.occurredAt)) {
    throw new Error("Memory control occurredAt must be a timestamp.");
  }
}

function validateBody(body: MemoryControlEventBody): void {
  if (
    body.schema !== "rubato.memory.control-event/v1" ||
    typeof body.event_id !== "string" ||
    !body.event_id ||
    typeof body.project_id !== "string" ||
    !/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(body.project_id) ||
    body.actor !== "user" ||
    !ACTIONS.has(body.action) ||
    (body.target_fingerprint !== undefined &&
      !isHash(body.target_fingerprint)) ||
    (body.value_fingerprint !== undefined &&
      !isHash(body.value_fingerprint)) ||
    !validTimestamp(body.occurred_at)
  ) {
    throw new Error("Invalid memory control event body.");
  }
}

function targetFingerprint(
  action: MemoryControlAction,
  target: string,
): string {
  if (action === "correct" || action === "forget") {
    return memoryPurgeFingerprint("logical-key", target);
  }
  return createHash("sha256")
    .update(`rubato-memory-control:${action}:v1\0${target}`)
    .digest("hex");
}

function writeChain(events: MemoryControlEvent[], filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp.${randomUUID()}`;
  fs.writeFileSync(
    temporary,
    events.length > 0
      ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
      : "",
    { encoding: "utf8", mode: 0o600 },
  );
  fs.renameSync(temporary, filePath);
}

function withFileLock<T>(lockPath: string, action: () => T): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5) {
        // Tiny bounded contention wait.
      }
    }
  }
  if (descriptor === undefined) {
    throw new Error("Memory control event lock is busy.");
  }
  try {
    return action();
  } finally {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // The chain remains verifiable; a stale lock is operationally recoverable.
    }
  }
}

function validTimestamp(value: string): boolean {
  return Boolean(value.trim()) && Number.isFinite(Date.parse(value));
}

function isHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
