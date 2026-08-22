// Working context windows used for compaction trigger and post-compact judging.
// Values are product-usable windows, not advertised API maxima.

export const TRIGGER_RATIO = 0.85;
export const WORK_MARGIN_TOKENS = 16_000;
/** Matches the default model output cap in StepExecutor. */
export const DEFAULT_OUTPUT_TOKENS = 16_384;
/** Unchanged this round — subagent still uses the old ceiling. */
export const SUBAGENT_COMPACTION_CEILING = 120_000;
const SUBAGENT_AUTOCOMPACT_BUFFER = 20_000;
const OUTPUT_RESERVE_FLOOR = 20_000;
const OUTPUT_RESERVE_RATIO = 0.08;

/**
 * Longest-prefix-first working windows.
 * Dated IDs (gpt-5.6-sol-2026-…) match the prefix entry.
 */
const MODEL_WORKING_WINDOWS: Array<{ prefix: string; tokens: number }> = [
  { prefix: "gpt-5.6-sol", tokens: 272_000 },
  { prefix: "gpt-5.6", tokens: 272_000 },
  { prefix: "gpt-5", tokens: 272_000 },
  { prefix: "claude-opus-5", tokens: 1_000_000 },
  { prefix: "claude-opus-4", tokens: 200_000 },
  { prefix: "claude-opus", tokens: 200_000 },
  { prefix: "claude-sonnet-4", tokens: 200_000 },
  { prefix: "claude-sonnet", tokens: 200_000 },
  { prefix: "claude-haiku", tokens: 200_000 },
  { prefix: "gpt-4.1", tokens: 1_000_000 },
  { prefix: "gpt-4o", tokens: 128_000 },
  { prefix: "gpt-4-turbo", tokens: 128_000 },
  { prefix: "gpt-4", tokens: 128_000 },
  { prefix: "o3", tokens: 200_000 },
  { prefix: "o1", tokens: 200_000 },
  { prefix: "deepseek-v4", tokens: 256_000 },
  { prefix: "deepseek", tokens: 256_000 },
  { prefix: "llama", tokens: 128_000 },
  { prefix: "mixtral", tokens: 128_000 },
];

const PREFIXES_BY_LENGTH = [...MODEL_WORKING_WINDOWS].sort(
  (a, b) => b.prefix.length - a.prefix.length,
);

export interface WindowResolution {
  tokens: number | null;
  source: "config" | "table" | "unresolved";
  warning?: string;
}

export function resolveWorkingContextWindow(
  model: string,
  override?: number,
): WindowResolution {
  if (typeof override === "number" && override > 0) {
    return { tokens: override, source: "config" };
  }
  const lower = model.toLowerCase();
  for (const entry of PREFIXES_BY_LENGTH) {
    if (lower.startsWith(entry.prefix)) {
      return { tokens: entry.tokens, source: "table" };
    }
  }
  return {
    tokens: null,
    source: "unresolved",
    warning:
      `Unknown model "${model}": set model.contextWindow in .rubato.yml. ` +
      "Auto-compaction is skipped until a working window is configured.",
  };
}

export function outputReserveTokens(window: number, maxTokens?: number): number {
  if (typeof maxTokens === "number" && maxTokens > 0) return maxTokens;
  return Math.max(OUTPUT_RESERVE_FLOOR, Math.floor(window * OUTPUT_RESERVE_RATIO));
}

export interface CompactionBudget {
  window: number | null;
  outputReserve: number;
  usable: number;
  /** Compact when system + conversation exceeds this. */
  trigger: number;
  /** After compact, occupancy must be below this (trigger minus work margin). */
  successCeiling: number;
  windowWarning?: string;
}

export function getCompactionBudget(options: {
  model: string;
  isSubagent?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): CompactionBudget {
  const resolved = resolveWorkingContextWindow(options.model, options.contextWindow);
  if (resolved.tokens == null) {
    return {
      window: null,
      outputReserve: options.maxTokens ?? DEFAULT_OUTPUT_TOKENS,
      usable: Number.POSITIVE_INFINITY,
      trigger: Number.POSITIVE_INFINITY,
      successCeiling: Number.POSITIVE_INFINITY,
      windowWarning: resolved.warning,
    };
  }

  const window = resolved.tokens;
  const reserve = outputReserveTokens(window, options.maxTokens);
  const usable = Math.max(0, window - reserve);

  if (options.isSubagent) {
    const trigger = Math.min(window - SUBAGENT_AUTOCOMPACT_BUFFER, SUBAGENT_COMPACTION_CEILING);
    return {
      window,
      outputReserve: reserve,
      usable,
      trigger,
      successCeiling: successCeilingFor(trigger),
    };
  }

  const trigger = Math.floor(usable * TRIGGER_RATIO);
  return {
    window,
    outputReserve: reserve,
    usable,
    trigger,
    successCeiling: successCeilingFor(trigger),
  };
}

function successCeilingFor(trigger: number): number {
  const margin = Math.min(WORK_MARGIN_TOKENS, Math.max(1, Math.floor(trigger * 0.25)));
  return Math.max(0, trigger - margin);
}

export function systemLeavesNoConversationRoom(
  systemTokens: number,
  budget: CompactionBudget,
): boolean {
  if (budget.window == null) return false;
  if (systemTokens + budget.outputReserve >= budget.window) return true;
  if (systemTokens >= budget.successCeiling) return true;
  return false;
}

export function describeWorkingWindow(model: string, override?: number): string {
  const resolved = resolveWorkingContextWindow(model, override);
  if (resolved.tokens == null) {
    return "unknown (set model.contextWindow)";
  }
  const k = Math.round(resolved.tokens / 1000);
  return `${k}k`;
}
