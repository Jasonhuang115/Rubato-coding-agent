import fs from "fs";
import path from "path";
import type {
  ObservationProposal,
  SourceEvent,
} from "../memory-files/extractor.js";
import { getRubatoHome } from "../memory-files/outcome.js";
import { projectMemoryId } from "../memory-files/paths.js";
import { learnFromObservationProposals } from "../memory-files/runtime.js";
import {
  loadSession,
  verifySession,
  type StoredSessionRecord,
} from "../runtime/session/storage.js";
import type { ToolDefinition } from "../shared/core-types.js";
import type {
  EvidencePolarity,
  UserMemoryScope,
  UserSignal,
} from "../memory-files/observation.js";

export const memoryProposeTool: ToolDefinition = {
  name: "MemoryPropose",
  description:
    "Propose one structured user-memory observation tied to an exact " +
    "user-authored event in the current root session. The deterministic " +
    "memory reducer validates provenance, risk, and publication policy.",
  inputSchema: {
    type: "object",
    properties: {
      source_event_id: {
        type: "string",
        description: "Exact event_id of a user-authored message in this session",
      },
      logical_key: {
        type: "string",
        description: "Stable semantic key, not a generated title",
      },
      value: {
        type: "string",
        description: "Atomic proposed value grounded in the source event",
      },
      scope: {
        type: "string",
        enum: ["global", "project", "domain", "surface"],
      },
      scope_value: {
        type: "string",
        description: "Required for domain/surface; project is forced to the current project",
      },
      signal: {
        type: "string",
        enum: [
          "approval",
          "remember",
          "correction",
          "explicit_preference",
          "explicit_constraint",
          "explicit_goal",
          "choice",
          "habit",
          "inference",
        ],
      },
      polarity: {
        type: "string",
        enum: ["support", "oppose"],
      },
      proposed_weight: {
        type: "number",
        description: "May lower but never raise the configured evidence weight",
      },
    },
    required: [
      "source_event_id",
      "logical_key",
      "value",
      "scope",
      "signal",
    ],
  },
  type: "write",
  requiresApproval: false,
  async handler(input, ctx) {
    if (ctx.depth !== 0) {
      return {
        content: "Only the root agent may propose durable user memory.",
        isError: true,
      };
    }
    try {
      const sourceEventId = requiredString(input.source_event_id, "source_event_id");
      const source = findCurrentUserEvent(
        ctx.sessionId,
        ctx.workingDir,
        sourceEventId,
      );
      if (!source) {
        throw new Error(
          "source_event_id is not a verified user-authored message in the current session",
        );
      }
      const scope = parseScope(input, ctx.workingDir);
      if (scope.kind === "global" && !authorizesGlobalScope(source.content)) {
        throw new Error(
          "global scope requires the user to explicitly say this applies across/all projects",
        );
      }
      const proposal: ObservationProposal = {
        sourceEventId,
        logicalKey: requiredString(input.logical_key, "logical_key"),
        value: requiredString(input.value, "value"),
        scope,
        signal: parseSignal(input.signal),
        polarity: parsePolarity(input.polarity),
        ...(typeof input.proposed_weight === "number"
          ? { proposedWeight: input.proposed_weight }
          : {}),
      };
      const learned = learnFromObservationProposals(
        [source],
        [proposal],
        {
          workingDir: ctx.workingDir,
          sessionId: ctx.sessionId,
          enabled:
            ctx.config.memory?.enabled !== false &&
            ctx.config.memory?.learningEnabled !== false,
          autoPublishExplicitLowRisk:
            ctx.config.memory?.autoPublishExplicitLowRisk !== false,
        },
      );
      if (learned.observed === 0) {
        return {
          content:
            "Memory proposal did not pass the evidence gate: " +
            (learned.skipped.join("; ") || "learning is paused or duplicate"),
          isError: true,
        };
      }
      return {
        content: [
          `Accepted ${learned.observed} user observation.`,
          learned.publishedReleaseIds.length > 0
            ? `Published release(s): ${learned.publishedReleaseIds.join(", ")}.`
            : "No formal release was published.",
          learned.needsReview > 0
            ? `${learned.needsReview} candidate(s) require review.`
            : "No review is pending.",
        ].join(" "),
      };
    } catch (error) {
      return {
        content: `Memory proposal rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  },
};

function findCurrentUserEvent(
  sessionId: string,
  workingDir: string,
  eventId: string,
): SourceEvent | null {
  const rubatoHome = getRubatoHome();
  const projectId = projectMemoryId(workingDir);
  const directories = [
    path.join(rubatoHome, "projects", projectId, "sessions"),
    path.join(rubatoHome, "sessions"),
  ];
  for (const directory of directories) {
    const filePath = path.join(directory, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) continue;
    const verification = verifySession(sessionId, directory);
    if (!verification.valid) continue;
    const record = loadSession(sessionId, directory)
      .find((item) => item.event_id === eventId);
    const source = record ? sourceEventFromRecord(record, sessionId) : null;
    if (source) return source;
  }
  return null;
}

function sourceEventFromRecord(
  record: StoredSessionRecord,
  sessionId: string,
): SourceEvent | null {
  if (record.type !== "message") return null;
  const message = record.data as { role?: unknown; content?: unknown };
  if (message?.role !== "user") return null;
  const content = userText(message.content);
  if (!content) return null;
  return {
    id: record.event_id,
    actor: "user",
    content,
    sessionId,
    observedAt: new Date(record.timestamp).toISOString(),
    eventSeq: record.seq,
    eventHash: record.hash,
  };
}

function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return [(block as { text: string }).text];
    }
    return [];
  }).join("\n").trim();
}

function parseScope(
  input: Record<string, unknown>,
  workingDir: string,
): UserMemoryScope {
  const kind = input.scope;
  if (kind === "global") return { kind };
  if (kind === "project") {
    return { kind, value: projectMemoryId(workingDir) };
  }
  if (kind === "domain" || kind === "surface") {
    return {
      kind,
      value: requiredString(input.scope_value, "scope_value"),
    };
  }
  throw new Error("invalid scope");
}

function parseSignal(value: unknown): UserSignal {
  const allowed: UserSignal[] = [
    "approval",
    "remember",
    "correction",
    "explicit_preference",
    "explicit_constraint",
    "explicit_goal",
    "choice",
    "habit",
    "inference",
  ];
  if (!allowed.includes(value as UserSignal)) throw new Error("invalid signal");
  return value as UserSignal;
}

function parsePolarity(value: unknown): EvidencePolarity {
  if (value === undefined || value === "support") return "support";
  if (value === "oppose") return "oppose";
  throw new Error("invalid polarity");
}

function authorizesGlobalScope(text: string): boolean {
  return /(?:所有|全部|任何)(?:项目|工程)|全局|跨项目|across all projects|every project/i
    .test(text);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}
