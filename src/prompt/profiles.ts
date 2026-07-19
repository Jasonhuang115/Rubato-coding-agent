// Model-specific profile definitions for the Prompt Assembler.
// Each profile defines: max system prompt tokens, caching support,
// system prompt format, and thinking/reasoning format.

import type { ModelProfile } from "./types.js";

// ---- Claude models ----

export const claudeProfile: ModelProfile = {
  maxSystemPromptTokens: 8000,
  supportsPromptCaching: true,
  systemPromptFormat: "system",
  thinkingFormat: "thinking_delta",
};

// ---- DeepSeek models ----

export const deepseekProfile: ModelProfile = {
  maxSystemPromptTokens: 3000,
  supportsPromptCaching: false,
  systemPromptFormat: "system",
  thinkingFormat: "reasoning_content",
};

// ---- OpenAI models ----

export const openaiProfile: ModelProfile = {
  maxSystemPromptTokens: 6000,
  supportsPromptCaching: false,
  systemPromptFormat: "system",
  thinkingFormat: "none",
};

// ---- Qwen / Ollama / local models ----

export const localProfile: ModelProfile = {
  maxSystemPromptTokens: 2000,
  supportsPromptCaching: false,
  systemPromptFormat: "system",
  thinkingFormat: "none",
};

// ---- Default (unknown provider) ----

export const defaultProfile: ModelProfile = {
  maxSystemPromptTokens: 3000,
  supportsPromptCaching: false,
  systemPromptFormat: "system",
  thinkingFormat: "none",
};

// ---- Provider → Profile mapping ----

export function getProfileForProvider(providerName: string): ModelProfile {
  const normalized = providerName.toLowerCase();

  if (normalized === "claude" || normalized === "anthropic") {
    return claudeProfile;
  }
  if (normalized === "deepseek") {
    return deepseekProfile;
  }
  if (normalized === "openai" || normalized === "gpt" || normalized === "groq") {
    return openaiProfile;
  }
  if (normalized === "ollama" || normalized === "qwen" || normalized === "llama" || normalized === "mistral") {
    return localProfile;
  }

  return defaultProfile;
}
