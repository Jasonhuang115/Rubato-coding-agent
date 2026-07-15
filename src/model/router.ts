// Model router — selects provider based on config

import type { ModelProvider, AgentConfig } from "../core-types.js";
import { DeepSeekProvider } from "./deepseek.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { AnthropicProvider } from "./anthropic.js";

export function createProvider(config: AgentConfig["model"]): ModelProvider {
  const provider = config.provider.toLowerCase();

  switch (provider) {
    case "deepseek":
      return new DeepSeekProvider(config.apiKey, config.baseURL);

    case "openai":
    case "groq":
    case "openrouter":
    case "ollama":
    case "vllm":
    case "together":
    case "fireworks": {
      // Resolve baseURL from config or known defaults
      const baseURL =
        config.baseURL ??
        knownBaseURLs[provider] ??
        (() => {
          throw new Error(
            `Unknown baseURL for provider "${provider}". Set baseURL in config.`
          );
        })();
      return new OpenAICompatProvider(provider, baseURL, config.apiKey);
    }

    case "anthropic":
    case "claude":
      return new AnthropicProvider(config.apiKey, config.baseURL);

    default:
      // Default to OpenAI-compatible with the provider name as baseURL hint
      if (config.baseURL) {
        return new OpenAICompatProvider(provider, config.baseURL, config.apiKey);
      }
      throw new Error(
        `Unknown provider "${provider}". Supported: deepseek, openai, anthropic, groq, openrouter, ollama, vllm, together, fireworks. ` +
          `For custom providers, set baseURL in config.`
      );
  }
}

const knownBaseURLs: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
};
