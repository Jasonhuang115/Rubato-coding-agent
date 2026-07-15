// Config loader — reads configuration from YAML files and environment

import fs from "fs";
import path from "path";
import YAML from "yaml";
import type { AgentConfig } from "../core-types.js";
import { DEFAULT_PERMISSIONS } from "../permissions/config.js";

const CONFIG_FILE_NAMES = [
  ".coding-agent.yml",
  ".coding-agent.yaml",
  "coding-agent.yml",
  "coding-agent.yaml",
];

export function loadConfig(workingDir: string): AgentConfig {
  // Try to find config file
  let fileConfig: Partial<AgentConfig> = {};

  for (const name of CONFIG_FILE_NAMES) {
    const filePath = path.join(workingDir, name);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        fileConfig = YAML.parse(content) ?? {};
        break;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: Failed to parse config file ${filePath}: ${message}`);
      }
    }
  }

  // Also check home directory
  const homeConfigPath = path.join(
    process.env.HOME ?? "/tmp",
    ".coding-agent",
    "config.yml"
  );
  if (fs.existsSync(homeConfigPath)) {
    try {
      const content = fs.readFileSync(homeConfigPath, "utf-8");
      const homeConfig = YAML.parse(content) ?? {};
      fileConfig = deepMerge(fileConfig, homeConfig);
    } catch {
      // Silently ignore
    }
  }

  // Build final config with defaults
  const config: AgentConfig = {
    model: {
      provider: process.env.CODING_AGENT_PROVIDER ??
        fileConfig.model?.provider ??
        "deepseek",
      model: process.env.CODING_AGENT_MODEL ??
        fileConfig.model?.model ??
        "deepseek-chat",
      baseURL: process.env.CODING_AGENT_BASE_URL ??
        fileConfig.model?.baseURL,
      apiKey: process.env.CODING_AGENT_API_KEY ??
        fileConfig.model?.apiKey,
      maxRetries: fileConfig.model?.maxRetries ?? 3,
    },
    permissions: {
      ...DEFAULT_PERMISSIONS,
      ...fileConfig.permissions,
    },
    embedding: {
      source: (fileConfig.embedding?.source as "local_onnx" | "api") ?? "local_onnx",
      model: fileConfig.embedding?.model,
    },
    mnemosyne: {
      bootstrap_on_first_open: fileConfig.mnemosyne?.bootstrap_on_first_open ?? true,
      bootstrap_max_files: fileConfig.mnemosyne?.bootstrap_max_files ?? 500,
    },
    session: {
      cleanupPeriodDays: fileConfig.session?.cleanupPeriodDays ?? 30,
    },
  };

  return config;
}

// Simple deep merge for configs
function deepMerge<T extends Record<string, unknown>>(base: T, override: T): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    if (
      typeof override[key] === "object" &&
      override[key] !== null &&
      !Array.isArray(override[key]) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        override[key] as Record<string, unknown>
      ) as T[keyof T];
    } else {
      result[key] = override[key];
    }
  }
  return result;
}
