import { createHash } from "crypto";
import {
  classifyUserSignal,
  type ObservationProposal,
  type SourceEvent,
} from "./extractor.js";
import type { UserMemoryScope, UserSignal } from "./observation.js";
import {
  findMemorySafetyIssues,
  findProhibitedSensitiveCategories,
  loadMemoryPolicy,
} from "./policy.js";

export interface FastExtractionOptions {
  projectId: string;
  /**
   * Prohibited sensitive categories. Defaults to POLICY.yml so the durable
   * policy, not a hardcoded list, decides what the fast path refuses to learn.
   */
  prohibitedSensitiveCategories?: ReadonlyArray<string>;
}

export interface FastExtractionResult {
  proposals: ObservationProposal[];
  skipped: Array<{
    eventId: string;
    reason: "not_explicit" | "session_only" | "sensitive" | "ambiguous";
  }>;
}

/**
 * Conservative, zero-model fast path for explicit statements. It recognizes a
 * deliberately small set of stable keys; everything else waits for Dreaming.
 */
export function proposeFastUserObservations(
  events: SourceEvent[],
  options: FastExtractionOptions,
): FastExtractionResult {
  const proposals: ObservationProposal[] = [];
  const skipped: FastExtractionResult["skipped"] = [];
  const prohibited = options.prohibitedSensitiveCategories ??
    loadMemoryPolicy().prohibited_sensitive_categories;

  for (const event of events) {
    if (event.actor !== "user") continue;
    const text = event.content.trim();
    if (isSessionOnlyInstruction(text)) {
      skipped.push({ eventId: event.id, reason: "session_only" });
      continue;
    }
    if (
      findMemorySafetyIssues(text).length > 0 ||
      findProhibitedSensitiveCategories(text, prohibited).matched.length > 0
    ) {
      skipped.push({ eventId: event.id, reason: "sensitive" });
      continue;
    }

    const claims = recognizeClaims(text);
    if (claims.length === 0) {
      skipped.push({
        eventId: event.id,
        reason: classifyUserSignal(text) === "other"
          ? "not_explicit"
          : "ambiguous",
      });
      continue;
    }
    const classified = classifyUserSignal(text);
    const signal = isFastPathSignal(classified)
      ? classified
      : hasStandingLanguage(text)
        ? "explicit_preference"
        : "other";
    if (!isFastPathSignal(signal)) {
      skipped.push({ eventId: event.id, reason: "not_explicit" });
      continue;
    }
    const scope = inferScope(text, options.projectId);
    for (const claim of claims) {
      proposals.push({
        sourceEventId: event.id,
        logicalKey: claim.logicalKey,
        value: claim.value,
        scope: claim.scope ?? scope,
        signal,
        polarity: "support",
      });
    }
  }

  return { proposals, skipped };
}

interface RecognizedClaim {
  logicalKey: string;
  value: string;
  scope?: UserMemoryScope;
}

function recognizeClaims(text: string): RecognizedClaim[] {
  const lower = text.toLocaleLowerCase();
  const claims: RecognizedClaim[] = [];

  if (/(?:详细|展开|解释原因|说明原因|explain in detail|detailed|verbose)/i.test(text)) {
    claims.push({
      logicalKey: "communication.explanation_depth",
      value: "detailed",
      scope: architectureScopeIfPresent(text),
    });
  } else if (/(?:简洁|简短|只给结论|直接给结论|concise|brief|just the answer)/i.test(text)) {
    claims.push({
      logicalKey: "communication.explanation_depth",
      value: "concise",
      scope: architectureScopeIfPresent(text),
    });
  }

  if (/(?:用中文|中文回答|说中文|in chinese)/i.test(text)) {
    claims.push({ logicalKey: "communication.language", value: "zh" });
  } else if (/(?:用英文|英文回答|in english)/i.test(text)) {
    claims.push({ logicalKey: "communication.language", value: "en" });
  }

  if (/(?:不要.{0,12}(?:标题|小标题)|no headings)/i.test(text)) {
    claims.push({ logicalKey: "communication.heading_style", value: "no_headings" });
  } else if (/(?:使用|多用|prefer).{0,12}(?:标题|小标题|headings)/i.test(text)) {
    claims.push({ logicalKey: "communication.heading_style", value: "headings" });
  }

  if (/(?:文件系统|文件夹).{0,30}(?:grep|rg)|(?:grep|rg).{0,30}(?:文件系统|文件夹)/i.test(text)) {
    claims.push({
      logicalKey: "architecture.memory_retrieval",
      value: /(?:放弃|不要|不用|舍弃|without|no)\s*(?:rag)?/i.test(text) ||
        /(?:放弃|不要|不用|舍弃).{0,20}rag/i.test(text)
        ? "filesystem_grep_without_rag"
        : "filesystem_grep",
    });
  } else if (/\b(?:agentic\s+rag|self[- ]evolving\s+rag|rag)\b/i.test(lower)) {
    claims.push({
      logicalKey: "architecture.memory_retrieval",
      value: lower.includes("agentic") ? "agentic_rag" : "rag",
    });
  }

  if (/(?:必须|务必|一定要|always).{0,20}(?:测试|test|build|lint)/i.test(text)) {
    claims.push({
      logicalKey: "workflow.validation",
      value: "validate_before_completion",
    });
  }

  if (
    claims.length === 0 &&
    /(?:请)?记住|记一下|\bremember(?:\s+that)?\b/i.test(text)
  ) {
    const value = stripRememberPrefix(text);
    if (value.length >= 3) {
      claims.push({
        logicalKey: `remembered.note.${shortDigest(value)}`,
        value: value.slice(0, 500),
      });
    }
  }

  return dedupeClaims(claims);
}

function inferScope(text: string, projectId: string): UserMemoryScope {
  if (
    /(?:所有|全部|任何)(?:项目|工程)|全局|跨项目|across all projects|every project/i
      .test(text)
  ) {
    return { kind: "global" };
  }
  if (/(?:命令行|cli|terminal)/i.test(text)) {
    return { kind: "surface", value: "cli" };
  }
  const domain = architectureDomain(text);
  if (domain) return { kind: "domain", value: domain };
  return { kind: "project", value: projectId };
}

function architectureScopeIfPresent(text: string): UserMemoryScope | undefined {
  const domain = architectureDomain(text);
  return domain ? { kind: "domain", value: domain } : undefined;
}

function architectureDomain(text: string): string | undefined {
  if (/(?:架构|技术方案|系统设计|architecture|technical design)/i.test(text)) {
    return "architecture";
  }
  if (/(?:写代码|编码|coding|implementation)/i.test(text)) {
    return "coding";
  }
  return undefined;
}

function isFastPathSignal(signal: UserSignal): boolean {
  return signal === "remember" ||
    signal === "correction" ||
    signal === "explicit_preference" ||
    signal === "explicit_constraint" ||
    signal === "explicit_goal";
}

function isSessionOnlyInstruction(text: string): boolean {
  const local = /(?:这次|本次|当前(?:任务|回答|会话)|暂时|先别记|仅此一次|for now|this time|this session|just this once)/i
    .test(text);
  const standing = /(?:以后|今后|从现在起|总是|一直|默认|长期|记住|always|from now on|going forward|remember)/i
    .test(text);
  return local && !standing;
}

function hasStandingLanguage(text: string): boolean {
  return /(?:以后|今后|从现在起|总是|一直|默认|都要|所有项目|全部项目|全局|长期|always|from now on|going forward|by default|every project)/i
    .test(text);
}

function stripRememberPrefix(text: string): string {
  return text
    .replace(/^(?:请)?(?:记住|记一下|请记得)\s*[:：,，]?\s*/i, "")
    .replace(/^remember(?:\s+that)?\s*[:：,，]?\s*/i, "")
    .trim();
}

function shortDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function dedupeClaims(claims: RecognizedClaim[]): RecognizedClaim[] {
  const result: RecognizedClaim[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    const scope = claim.scope
      ? `${claim.scope.kind}:${claim.scope.value ?? ""}`
      : "";
    const key = `${claim.logicalKey}\u0000${claim.value}\u0000${scope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(claim);
  }
  return result;
}
