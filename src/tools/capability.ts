// Tool Capability — declares capabilities, costs, risks, and side effects for each tool.
// Used by:
//   - Security Runtime: auto-adjust sandbox level based on risk
//   - Planner: select the right tool based on capability
//   - Future Tool Ranking: sort by cost + risk

import type { ToolDefinition } from "../shared/core-types.js";

// ---- Capability types ----

export type FilesystemAccess = "none" | "read" | "write";
export type NetworkAccess = "none" | "external" | "localhost_only";
export type ShellAccess = "none" | "readonly" | "full";
export type GitAccess = "none" | "readonly" | "write";
export type ToolRisk = "safe" | "moderate" | "dangerous" | "destructive";

export interface ToolCapability {
  name: string;
  description: string;

  /** What kind of access does this tool need? */
  abilities: {
    filesystem: FilesystemAccess;
    network: NetworkAccess;
    shell: ShellAccess;
    git: GitAccess;
  };

  /** Cost estimation for budget management. */
  cost: {
    avgTokenInput: number;
    avgTokenOutput: number;
    avgLatencyMs: number;
    isExpensive: boolean;
  };

  /** Risk level for security policy. */
  risk: ToolRisk;

  /** Can this tool be called multiple times with the same result? */
  isIdempotent: boolean;

  /** Does this tool modify external state? */
  hasSideEffects: boolean;
}

// ---- Built-in capability registry ----

/** Map of tool name → capability declaration. */
const CAPABILITIES: Record<string, ToolCapability> = {
  Read: {
    name: "Read",
    description: "Read file contents",
    abilities: { filesystem: "read", network: "none", shell: "none", git: "none" },
    cost: { avgTokenInput: 50, avgTokenOutput: 200, avgLatencyMs: 5, isExpensive: false },
    risk: "safe",
    isIdempotent: true,
    hasSideEffects: false,
  },
  Write: {
    name: "Write",
    description: "Write file contents",
    abilities: { filesystem: "write", network: "none", shell: "none", git: "none" },
    cost: { avgTokenInput: 100, avgTokenOutput: 50, avgLatencyMs: 5, isExpensive: false },
    risk: "moderate",
    isIdempotent: false,
    hasSideEffects: true,
  },
  Edit: {
    name: "Edit",
    description: "Edit file contents",
    abilities: { filesystem: "write", network: "none", shell: "none", git: "none" },
    cost: { avgTokenInput: 150, avgTokenOutput: 50, avgLatencyMs: 5, isExpensive: false },
    risk: "moderate",
    isIdempotent: false,
    hasSideEffects: true,
  },
  Bash: {
    name: "Bash",
    description: "Execute shell commands",
    abilities: { filesystem: "write", network: "external", shell: "full", git: "write" },
    cost: { avgTokenInput: 80, avgTokenOutput: 500, avgLatencyMs: 2000, isExpensive: true },
    risk: "dangerous",
    isIdempotent: false,
    hasSideEffects: true,
  },
  Grep: {
    name: "Grep",
    description: "Search file contents",
    abilities: { filesystem: "read", network: "none", shell: "none", git: "none" },
    cost: { avgTokenInput: 60, avgTokenOutput: 150, avgLatencyMs: 50, isExpensive: false },
    risk: "safe",
    isIdempotent: true,
    hasSideEffects: false,
  },
  Glob: {
    name: "Glob",
    description: "Find files by pattern",
    abilities: { filesystem: "read", network: "none", shell: "none", git: "none" },
    cost: { avgTokenInput: 40, avgTokenOutput: 100, avgLatencyMs: 10, isExpensive: false },
    risk: "safe",
    isIdempotent: true,
    hasSideEffects: false,
  },
  WebFetch: {
    name: "WebFetch",
    description: "Fetch web page content",
    abilities: { filesystem: "none", network: "external", shell: "none", git: "none" },
    cost: { avgTokenInput: 30, avgTokenOutput: 1000, avgLatencyMs: 3000, isExpensive: true },
    risk: "moderate",
    isIdempotent: false,
    hasSideEffects: false,
  },
  WebSearch: {
    name: "WebSearch",
    description: "Search the web",
    abilities: { filesystem: "none", network: "external", shell: "none", git: "none" },
    cost: { avgTokenInput: 50, avgTokenOutput: 800, avgLatencyMs: 4000, isExpensive: true },
    risk: "moderate",
    isIdempotent: false,
    hasSideEffects: false,
  },
  TodoWrite: {
    name: "TodoWrite",
    description: "Manage task list",
    abilities: { filesystem: "none", network: "none", shell: "none", git: "none" },
    cost: { avgTokenInput: 50, avgTokenOutput: 30, avgLatencyMs: 1, isExpensive: false },
    risk: "safe",
    isIdempotent: false,
    hasSideEffects: false,
  },
};

// ---- Query API ----

/** Get capability for a tool. Returns null for unknown tools. */
export function getCapability(toolName: string): ToolCapability | null {
  return CAPABILITIES[toolName] ?? null;
}

/** Get risk level for a tool. Defaults to "moderate" for unknown tools. */
export function getRisk(toolName: string): ToolRisk {
  return CAPABILITIES[toolName]?.risk ?? "moderate";
}

/** Check if a tool can be called concurrently with others of the same type. */
export function isConcurrencySafe(toolName: string): boolean {
  return CAPABILITIES[toolName]?.isIdempotent ?? false;
}

/** Estimate token cost for a tool call. */
export function estimateCost(toolName: string): { input: number; output: number } {
  const cap = CAPABILITIES[toolName];
  return {
    input: cap?.cost.avgTokenInput ?? 50,
    output: cap?.cost.avgTokenOutput ?? 200,
  };
}

/** Get all capabilities for tools that match a risk filter. */
export function filterByRisk(maxRisk: ToolRisk): ToolCapability[] {
  const levels: Record<ToolRisk, number> = { safe: 0, moderate: 1, dangerous: 2, destructive: 3 };
  const max = levels[maxRisk];
  return Object.values(CAPABILITIES).filter((c) => levels[c.risk] <= max);
}
