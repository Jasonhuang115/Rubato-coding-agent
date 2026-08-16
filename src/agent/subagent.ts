// Managed subagent definitions and capability helpers.

import type {
  SubagentDefinition,
  ToolDefinition,
} from "../shared/core-types.js";
import { getTool } from "../tools/registry.js";

const BASIC_READ_TOOLS = ["Read", "Grep", "Glob"];
const WORKER_TOOLS = [...BASIC_READ_TOOLS, "Write", "Edit", "Bash"];

const REPORTING_RULES = [
  "",
  "## Durable report",
  "- You are read-only. Never modify files, invoke a shell, or perform Git operations.",
  "- Every visible assistant text delta is appended to a durable Markdown report.",
  "- Record useful evidence, decisions, corrections, and remaining work as you proceed; do not wait until the end to start reporting.",
  "- Choose headings that fit the task. Avoid filler narration and do not rely on a final message to carry the result.",
  "- For exhaustive/every-line assignments, begin with Glob(path=<exact scope root>, pattern=\"**/*\", include_hidden=true) for each scope root and inspect every discovered source file in full.",
  "- Never claim exhaustive completion while any discovered file is unread, partially read, failed, or outside a closed discovery root.",
  "- Do not paste large raw tool outputs into the report.",
].join("\n");

export const EXPLORE_DEF: SubagentDefinition = {
  name: "explore",
  description: "Read-only project exploration and code location.",
  systemPrompt: [
    "You are a code exploration subagent. Search the project broadly and report grounded findings.",
    "Locate relevant files, symbols, call paths, conventions, and risks.",
    REPORTING_RULES,
  ].join("\n"),
  tools: BASIC_READ_TOOLS,
  readonly: true,
};

export const RESEARCH_DEF: SubagentDefinition = {
  name: "research",
  description: "Read-only project and external-source research.",
  systemPrompt: [
    "You are a research subagent. Collect and reconcile evidence from project files and readonly web sources.",
    "Distinguish sourced facts, project-local observations, and inference.",
    REPORTING_RULES,
  ].join("\n"),
  tools: [...BASIC_READ_TOOLS, "WebFetch", "WebSearch"],
  readonly: true,
};

export const VERIFY_DEF: SubagentDefinition = {
  name: "verify",
  description: "Read-only adversarial review and evidence verification.",
  systemPrompt: [
    "You are a verification subagent. Critically inspect code and claims without executing tests.",
    "Identify unsupported claims, edge cases, test gaps, and evidence with file paths and line references.",
    REPORTING_RULES,
  ].join("\n"),
  tools: BASIC_READ_TOOLS,
  readonly: true,
};

export const GENERAL_DEF: SubagentDefinition = {
  name: "general",
  description: "Complex read-only analysis and synthesis.",
  systemPrompt: [
    "You are a general read-only analysis subagent.",
    REPORTING_RULES,
  ].join("\n"),
  tools: BASIC_READ_TOOLS,
  readonly: true,
};

export const WORKER_DEF: SubagentDefinition = {
  name: "worker",
  description: "Implements a self-contained code change in an isolated Git worktree.",
  systemPrompt: [
    "You are an implementation worker in an isolated Git worktree.",
    "Work only in the current working directory. Do not switch to another checkout or worktree.",
    "Inspect the assigned scope, implement the requested change, and run the required tests.",
    "Commit every deliverable with a descriptive commit message before ending.",
    "Record tests, the commit hash, changed files, and any scope deviation in the durable report as you work.",
    "Do not push or open a pull request unless the task explicitly asks for it.",
    "",
    "## Durable report",
    "- Run git status --porcelain before finishing; it must be empty.",
    "- Every visible assistant text delta is appended to report.md; record progress and evidence continuously.",
    "- If verification is incomplete, state the exact gap before ending.",
  ].join("\n"),
  tools: WORKER_TOOLS,
  readonly: false,
  isolation: "worktree",
};

const BUILTIN_DEFS: Record<string, SubagentDefinition> = {
  explore: EXPLORE_DEF,
  research: RESEARCH_DEF,
  general: GENERAL_DEF,
  verify: VERIFY_DEF,
  worker: WORKER_DEF,
};

export function getBuiltinDefinition(name: string): SubagentDefinition {
  const definition = BUILTIN_DEFS[name.toLowerCase()];
  if (!definition) {
    throw new Error(
      `Unknown subagent type "${name}". Available: ${Object.keys(BUILTIN_DEFS).join(", ")}`,
    );
  }
  return { ...definition, tools: [...definition.tools] };
}

/**
 * Resolve the exact per-agent capability set. Mutation tools are available
 * only for a worktree-isolated definition; provisioning still happens before
 * the runner is started.
 */
export function resolveSubagentTools(
  definition: SubagentDefinition,
  worktreeReady = definition.isolation === "worktree",
): ToolDefinition[] {
  if (definition.name === "compact") return [];
  const requested = definition.tools.includes("*")
    ? definition.isolation === "worktree" ? WORKER_TOOLS : BASIC_READ_TOOLS
    : definition.tools;
  const isCustom = !Object.hasOwn(BUILTIN_DEFS, definition.name.toLowerCase());
  const safeNames = new Set([
    ...BASIC_READ_TOOLS,
    ...(definition.name === "research" || isCustom ? ["WebFetch", "WebSearch"] : []),
    ...(definition.isolation === "worktree" && worktreeReady
      ? ["Write", "Edit", "Bash"]
      : []),
  ]);
  return requested
    .filter((name) => safeNames.has(name))
    .map((name) => getTool(name))
    .filter((tool): tool is ToolDefinition => tool !== undefined);
}
