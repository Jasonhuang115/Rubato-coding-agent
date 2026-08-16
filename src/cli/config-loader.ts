// Config loader — reads configuration from YAML files and environment

import fs from "fs";
import path from "path";
import YAML from "yaml";
import type { AgentConfig } from "../shared/core-types.js";
import { DEFAULT_PERMISSIONS } from "../permissions/config.js";
import { warnRecoverable } from "../shared/diagnostics.js";

const CONFIG_FILE_NAMES = [
  ".rubato.yml",
  ".rubato.yaml",
  "rubato.yml",
  "rubato.yaml",
];

// ---- .env file loading ----

const ENV_FILE_NAMES = [".env", ".env.local"];

type ConfigFileInput = Partial<AgentConfig>;
let warnedLegacyMemoryConfig = false;

/**
 * Load .env files from working directory and home directory.
 * Does NOT override already-set environment variables (shell wins).
 */
export function loadEnvFiles(workingDir: string): void {
  const paths: string[] = [];

  // Working directory .env files
  for (const name of ENV_FILE_NAMES) {
    paths.push(path.join(workingDir, name));
  }

  // Home directory .env
  const home = process.env.HOME ?? "/tmp";
  for (const name of ENV_FILE_NAMES) {
    paths.push(path.join(home, ".rubato", name));
  }

  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseEnvFile(content);
      for (const [key, value] of Object.entries(parsed)) {
        // Only set if not already in environment (shell/cli takes priority)
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // Silently skip unreadable .env files
    }
  }
}

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.substring(0, eqIdx).trim();
    let value = trimmed.substring(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Expand $VAR / ${VAR} references
    value = value.replace(/\$\{?(\w+)\}?/g, (_, name) => {
      return process.env[name] ?? "";
    });

    if (key) {
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig(workingDir: string): AgentConfig {
  // Try to find config file
  let fileConfig: ConfigFileInput = {};

  for (const name of CONFIG_FILE_NAMES) {
    const filePath = path.join(workingDir, name);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        fileConfig = (YAML.parse(content) ?? {}) as ConfigFileInput;
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
    ".rubato",
    "config.yml"
  );
  if (fs.existsSync(homeConfigPath)) {
    try {
      const content = fs.readFileSync(homeConfigPath, "utf-8");
      const homeConfig = (YAML.parse(content) ?? {}) as ConfigFileInput;
      fileConfig = deepMerge(fileConfig, homeConfig);
    } catch (error) {
      warnRecoverable(`config:${homeConfigPath}:load`, error);
    }
  }

  warnLegacyMemoryConfig(fileConfig);

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
    memory: {
      enabled: fileConfig.memory?.enabled ?? true,
      projectEnabled: fileConfig.memory?.projectEnabled ?? true,
      userEnabled: fileConfig.memory?.userEnabled ?? true,
    },
    session: {
      cleanupPeriodDays: fileConfig.session?.cleanupPeriodDays ?? 30,
    },
    worktree: {
      baseRef: fileConfig.worktree?.baseRef === "head" ? "head" : "fresh",
    },
    subagents: {
      maxConcurrent: fileConfig.subagents?.maxConcurrent ?? 4,
      maxWriteConcurrent: fileConfig.subagents?.maxWriteConcurrent ?? 2,
      maxTasksPerSession: fileConfig.subagents?.maxTasksPerSession ?? 32,
      artifactTtlDays: fileConfig.subagents?.artifactTtlDays ?? 30,
      artifactSoftLimitBytes: fileConfig.subagents?.artifactSoftLimitBytes ?? 2 * 1024 * 1024 * 1024,
    },
  };

  return config;
}

function warnLegacyMemoryConfig(config: ConfigFileInput): void {
  if (warnedLegacyMemoryConfig || !config.memory) return;
  const memory = config.memory as unknown as Record<string, unknown>;
  const retired = [
    "learningEnabled",
    "profileMaxTokens",
    "dreamSessionThreshold",
    "dreamCandidateThreshold",
    "dreamMaxAgeHours",
    "autoPublishExplicitLowRisk",
    "utilityLearningRate",
    "utilityMinUses",
    "bootstrapEnabled",
    "dreamAutoRun",
    "dreamMaxRunsPerStart",
  ].filter((key) => key in memory);
  if (retired.length === 0) return;
  warnedLegacyMemoryConfig = true;
  console.warn(
    `Warning: retired memory config ignored: ${retired.join(", ")}. ` +
      "Use enabled, projectEnabled, and userEnabled.",
  );
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
