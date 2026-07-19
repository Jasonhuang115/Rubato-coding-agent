// CompactionController — context compaction orchestration
// Extracted from loop.ts. Handles:
//   - Token estimation for messages + system prompt
//   - Dynamic compaction threshold per model
//   - Auto-compaction trigger (token-based)
//   - compactViaSubagent call with fallback to microCompact
//   - Post-compact restoration (recent files injection)
//   - Micro-compact before requests

import type { Message, AgentContext, AgentConfig } from "../shared/core-types.js";
import { microCompact } from "../context/compression.js";
import { compactViaSubagent } from "../context/compression.js";
import { microCompactBeforeRequest } from "../context/micro-compact.js";
import type { ReadGuardState } from "../shared/core-types.js";

// ---- Configuration ----

const AUTOCOMPACT_BUFFER = 20_000;
const COMPACT_KEEP_RECENT = 120;
const MAX_COMPACTION_FAILURES = 3;

// ---- Public API ----

export interface CompactionResult {
  /** Whether compaction was performed. */
  compacted: boolean;
  /** Compaction reason (for yielding to the agent loop). */
  reason?: string;
  /** Updated messages (replaced if compacted). */
  messages: Message[];
  /** Whether auto-compaction should be disabled going forward. */
  disableAutoCompact: boolean;
}

export interface CompactionOptions {
  messages: Message[];
  systemTokens: number;
  model: string;
  forceCompact?: boolean;
  skipCompaction?: boolean;
  ctx: AgentContext;
  config: AgentConfig;
  readGuard: ReadGuardState;
  consecutiveFailures: number;
}

/**
 * Check if compaction is needed and execute if so.
 * Returns updated messages and whether compaction was performed.
 */
export async function checkAndCompact(
  options: CompactionOptions,
): Promise<CompactionResult> {
  const {
    messages, systemTokens, model, forceCompact, skipCompaction,
    ctx, config, readGuard, consecutiveFailures,
  } = options;

  if (skipCompaction) {
    return { compacted: false, messages, disableAutoCompact: false };
  }

  const approxTokens = estimateMessageTokens(messages) + systemTokens;
  const threshold = getAutoCompactThreshold(model);

  if (!forceCompact && approxTokens <= threshold) {
    return { compacted: false, messages, disableAutoCompact: false };
  }

  const reason = forceCompact
    ? "User requested compaction"
    : `~${Math.round(approxTokens / 1000)}K / ${Math.round(threshold / 1000)}K tokens (${model})`;

  try {
    const compacted = await compactViaSubagent(messages, ctx, config, COMPACT_KEEP_RECENT);

    // Post-compact restoration: inject recently accessed files
    const snapshot = readGuard.serialize();
    const recentFiles = Object.entries(snapshot.files)
      .sort(([, a], [, b]) => b.timestamp - a.timestamp)
      .slice(0, 3)
      .map(([fp]) => fp);
    if (recentFiles.length > 0) {
      compacted.push({
        role: "user",
        content: `[Recently accessed files after compaction: ${recentFiles.join(", ")}. You may want to re-read these if you need their current content.]`,
      });
    }

    return {
      compacted: true,
      reason,
      messages: compacted,
      disableAutoCompact: false,
    };
  } catch {
    // Compaction failure: track and fall back to string-based
    const newFailures = consecutiveFailures + 1;
    if (newFailures >= MAX_COMPACTION_FAILURES) {
      return {
        compacted: true,
        reason: `Compaction failed ${newFailures} times — disabling auto-compaction.`,
        messages: microCompact(messages, COMPACT_KEEP_RECENT),
        disableAutoCompact: true,
      };
    }

    return {
      compacted: true,
      reason: `Compaction failed (${newFailures}/${MAX_COMPACTION_FAILURES}) — falling back to string-based.`,
      messages: microCompact(messages, COMPACT_KEEP_RECENT),
      disableAutoCompact: false,
    };
  }
}

export interface MicroCompactResult {
  /** Whether any tool results were cleared. */
  cleared: boolean;
  /** Number of stale results cleared. */
  count: number;
  /** Updated messages. */
  messages: Message[];
}

/**
 * Run pre-request micro-compaction to clear stale tool results.
 * Lightweight, no LLM cost.
 */
export function runMicroCompact(messages: Message[]): MicroCompactResult {
  const mcResult = microCompactBeforeRequest(messages);
  if (mcResult.cleared > 0) {
    return { cleared: true, count: mcResult.cleared, messages: mcResult.messages };
  }
  return { cleared: false, count: 0, messages };
}

// ---- Token estimation (CJK-aware) ----

/** Rough token count for a single string. CJK (~1.5 tokens/char), ASCII (~0.25 tokens/char). */
export function roughTokenEstimate(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Ext-A
      (code >= 0x3000 && code <= 0x303f) ||   // CJK punctuation
      (code >= 0xff00 && code <= 0xffef)      // Fullwidth forms
    ) {
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return tokens;
}

/** Estimate tokens for a message array. Pads by 4/3 for safety. */
export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += roughTokenEstimate(msg.content);
      continue;
    }
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          total += roughTokenEstimate(block.text);
          break;
        case "tool_result":
          total += roughTokenEstimate(block.content ?? "");
          break;
        case "tool_use":
          total += roughTokenEstimate(block.name + JSON.stringify(block.input));
          break;
      }
    }
  }
  return Math.ceil(total * (4 / 3));
}

// ---- Dynamic compaction threshold ----

function getEffectiveContextWindow(model: string): number {
  const CONTEXT_WINDOWS: Record<string, number> = {
    "deepseek-chat": 1_000_000,
    "deepseek-reasoner": 1_000_000,
    "deepseek-v4-pro": 1_000_000,
    "claude-sonnet-4-20250514": 200_000,
    "claude-opus-4-20250514": 200_000,
    "gpt-4o": 128_000,
    "gpt-4-turbo": 128_000,
  };
  return CONTEXT_WINDOWS[model] ?? 128_000;
}

function getAutoCompactThreshold(model: string): number {
  return getEffectiveContextWindow(model) - AUTOCOMPACT_BUFFER;
}
