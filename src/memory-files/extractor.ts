/**
 * Validation boundary for observations proposed by a foreground or dreaming
 * LLM. The model does not get to invent provenance or authority: proposals are
 * joined back to source events and only user-authored events are accepted.
 */

import {
  isExplicitSignal,
  normalizeLogicalKey,
  normalizeObservationValue,
  normalizeScope,
  scopeKey,
  type EvidencePolarity,
  type ObservationActor,
  type UserMemoryScope,
  type UserObservation,
  type UserSignal,
} from "./observation.js";

export interface SourceEvent {
  id: string;
  actor: ObservationActor;
  content: string;
  sessionId: string;
  observedAt: string;
  eventSeq?: number;
  eventHash?: string;
}

export interface ObservationProposal {
  sourceEventId: string;
  logicalKey: string;
  value: string;
  scope: UserMemoryScope;
  signal: UserSignal;
  polarity?: EvidencePolarity;
  proposedWeight?: number;
}

export interface RejectedObservationProposal {
  proposal: ObservationProposal;
  reason:
    | "missing_source"
    | "non_user_source"
    | "invalid_source"
    | "invalid_proposal"
    | "duplicate";
}

export interface ExtractionResult {
  accepted: UserObservation[];
  rejected: RejectedObservationProposal[];
}

export interface ExtractionOptions {
  idFactory?: (
    source: SourceEvent,
    proposal: ObservationProposal,
    index: number
  ) => string;
}

const REMEMBER_PATTERNS = [
  /(?:请)?记住/,
  /记一下/,
  /请记得/,
  /\bremember(?:\s+that)?\b/i,
  /\bkeep (?:this|that) in mind\b/i,
];

const CORRECTION_PATTERNS = [
  /(?:更正|纠正)(?:一下)?/,
  /不是.+而是/,
  /(?:别|不要)再/,
  /改成/,
  /其实我(?:是|要|想|喜欢|偏好)/,
  /\b(?:actually|correction|instead)\b/i,
  /\b(?:do not|don't|stop) (?:use|doing|saying|assuming)\b/i,
];

const PREFERENCE_PATTERNS = [
  /我(?:更|还是|通常)?(?:喜欢|偏好|希望|习惯|讨厌|不喜欢)/,
  /对我来说.+(?:更好|最好|比较好)/,
  /\bi (?:really )?(?:prefer|like|dislike|hate|want)\b/i,
  /\bmy preference is\b/i,
];

const CONSTRAINT_PATTERNS = [
  /我(?:必须|不能|一定要|绝对不)/,
  /(?:必须|务必|永远不要|一定不要)/,
  /\bi (?:must|cannot|can't)\b/i,
  /\b(?:always|never) (?:do|use|include|mention|send)\b/i,
];

const GOAL_PATTERNS = [
  /我的目标是/,
  /我(?:打算|计划|准备|想要)(?:在|把|完成|实现)/,
  /\bmy goal is\b/i,
  /\bi (?:plan|intend|aim|need) to\b/i,
];

const APPROVAL_PATTERNS = [
  /^(?:确认|批准|同意保存|可以记住|对，就这样)[。.!！]?\s*$/,
  /^(?:approved|confirmed|yes,? (?:save|remember) that)[.!]?\s*$/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Classifies only high-authority signals that are directly visible in text.
 * Behavioural signals remain the extractor's proposal, but cannot masquerade
 * as an explicit statement when the source text does not support that claim.
 */
export function classifyUserSignal(text: string): UserSignal {
  const trimmed = text.trim();
  if (matchesAny(trimmed, APPROVAL_PATTERNS)) return "approval";
  if (matchesAny(trimmed, REMEMBER_PATTERNS)) return "remember";
  if (matchesAny(trimmed, CORRECTION_PATTERNS)) return "correction";
  if (matchesAny(trimmed, PREFERENCE_PATTERNS)) return "explicit_preference";
  if (matchesAny(trimmed, CONSTRAINT_PATTERNS)) return "explicit_constraint";
  if (matchesAny(trimmed, GOAL_PATTERNS)) return "explicit_goal";
  return "other";
}

function resolvedSignal(
  sourceText: string,
  proposedSignal: UserSignal
): UserSignal {
  const classified = classifyUserSignal(sourceText);
  if (classified !== "other") return classified;
  return isExplicitSignal(proposedSignal) ? "inference" : proposedSignal;
}

function defaultId(
  source: SourceEvent,
  proposal: ObservationProposal,
  index: number
): string {
  const raw = `${source.sessionId}_${source.id}_${proposal.logicalKey}_${index}`;
  return `obs_${raw.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120)}`;
}

export function extractUserObservations(
  events: SourceEvent[],
  proposals: ObservationProposal[],
  options: ExtractionOptions = {}
): ExtractionResult {
  const accepted: UserObservation[] = [];
  const rejected: RejectedObservationProposal[] = [];
  const sources = new Map(events.map((event) => [event.id, event]));
  const seen = new Set<string>();
  const idFactory = options.idFactory ?? defaultId;

  proposals.forEach((proposal, index) => {
    const source = sources.get(proposal.sourceEventId);
    if (!source) {
      rejected.push({ proposal, reason: "missing_source" });
      return;
    }
    if (source.actor !== "user") {
      rejected.push({ proposal, reason: "non_user_source" });
      return;
    }
    if (
      source.content.trim().length === 0
      || source.sessionId.trim().length === 0
      || !Number.isFinite(Date.parse(source.observedAt))
    ) {
      rejected.push({ proposal, reason: "invalid_source" });
      return;
    }

    let scope: UserMemoryScope;
    try {
      scope = normalizeScope(proposal.scope);
    } catch {
      rejected.push({ proposal, reason: "invalid_proposal" });
      return;
    }

    const logicalKey = normalizeLogicalKey(proposal.logicalKey);
    const value = proposal.value.trim();
    if (logicalKey.length === 0 || value.length === 0) {
      rejected.push({ proposal, reason: "invalid_proposal" });
      return;
    }

    const resolved = resolvedSignal(source.content, proposal.signal);
    // An explicit sentence does not authorize an unrelated value invented by
    // the proposer. Canonical paraphrases are allowed; otherwise the proposal
    // is downgraded to an inference and cannot independently become active.
    const signal = isExplicitSignal(resolved) &&
      !proposalValueGrounded(source.content, value)
      ? "inference"
      : resolved;
    const polarity = proposal.polarity ?? "support";
    const dedupeKey = [
      source.sessionId,
      logicalKey,
      scopeKey(scope),
      normalizeObservationValue(value),
      polarity,
    ].join("\u001f");
    if (seen.has(dedupeKey)) {
      rejected.push({ proposal, reason: "duplicate" });
      return;
    }
    seen.add(dedupeKey);

    accepted.push({
      id: idFactory(source, proposal, index),
      actor: "user",
      signal,
      logicalKey,
      value,
      scope,
      polarity,
      sessionId: source.sessionId,
      eventId: source.id,
      eventSeq: source.eventSeq,
      eventHash: source.eventHash,
      observedAt: source.observedAt,
      proposedWeight: proposal.proposedWeight,
    });
  });

  return { accepted, rejected };
}

function proposalValueGrounded(sourceText: string, value: string): boolean {
  const source = normalizeObservationValue(sourceText);
  const proposed = normalizeObservationValue(value);
  if (source.includes(proposed)) return true;

  const canonicalPatterns: Record<string, RegExp> = {
    detailed: /(?:详细|展开|解释原因|说明原因|detailed|verbose|explain in detail)/i,
    concise: /(?:简洁|简短|直接给结论|只给结论|concise|brief|just the answer)/i,
    zh: /(?:中文|chinese)/i,
    en: /(?:英文|english)/i,
    headings: /(?:标题|小标题|headings)/i,
    no_headings: /(?:不要|不用|no).{0,12}(?:标题|小标题|headings)/i,
    filesystem_grep: /(?:文件系统|文件夹).{0,30}(?:grep|rg)|(?:grep|rg).{0,30}(?:文件系统|文件夹)/i,
    filesystem_grep_without_rag: /(?:放弃|不要|不用|舍弃|without|no).{0,24}rag/i,
    validate_before_completion: /(?:必须|务必|一定要|always).{0,24}(?:测试|test|build|lint)/i,
  };
  return canonicalPatterns[proposed]?.test(sourceText) ?? false;
}
