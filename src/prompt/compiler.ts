// Prompt Compiler — compiles model-agnostic prompt layers into provider-native format.
// Different providers require different message structures for optimal performance:
//   - Claude: Uses system message + cache_control breakpoints
//   - OpenAI/DeepSeek: Uses system message
//   - Ollama/Qwen: Injects system prompt as first user message

import type { ModelProfile, LayeredPrompt } from "./types.js";
import { MODEL_PROFILES } from "./types.js";

// ---- Compiled prompt types ----

export interface CompiledPrompt {
  /** The system message (or null if merged into messages). */
  system?: string;
  /** Messages to prepend (for providers without system message support). */
  prefixMessages?: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Compile layered prompts into a format optimal for the given model.
 *
 * For models WITH system prompt support:
 *   - Layers are concatenated: static → capability → dynamic
 *   - Caller adds ephemeral per-turn
 *
 * For models WITHOUT system prompt support (local models):
 *   - Layers are injected as a first user message with role markers
 */
export function compilePrompt(
  layers: LayeredPrompt,
  profile: ModelProfile,
): CompiledPrompt {
  const { systemPromptFormat } = profile;

  if (systemPromptFormat === "first_message") {
    // Local models: inject system prompt as first user message
    const combined = [
      layers.static,
      layers.capability,
      layers.dynamic,
    ].filter(Boolean).join("\n\n");

    return {
      system: undefined,
      prefixMessages: [
        { role: "user", content: combined },
        { role: "assistant", content: "Understood. I'll follow these instructions." },
      ],
    };
  }

  // Standard: all layers as system message
  const system = [
    layers.static,
    layers.capability,
    layers.dynamic,
  ].filter(Boolean).join("\n\n");

  return { system };
}

/**
 * Compile for a specific provider by name.
 */
export function compileForProvider(
  layers: LayeredPrompt,
  providerName: string,
): CompiledPrompt {
  const profile = MODEL_PROFILES[providerName] ?? MODEL_PROFILES.default;
  return compilePrompt(layers, profile);
}

/**
 * Estimate the total tokens for a compiled prompt.
 */
export function estimateCompiledTokens(
  compiled: CompiledPrompt,
  profile: ModelProfile,
): number {
  let tokens = 0;
  const estimate = (text: string) => Math.ceil(text.length / 3);

  if (compiled.system) {
    tokens += estimate(compiled.system);
  }
  if (compiled.prefixMessages) {
    for (const msg of compiled.prefixMessages) {
      tokens += estimate(msg.content);
    }
  }

  // Check against model budget
  if (tokens > profile.maxSystemPromptTokens) {
    // Warn but don't fail — caller should compress or trim
  }

  return tokens;
}
