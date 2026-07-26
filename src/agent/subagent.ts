// Read-only subagent definitions and compatibility helpers.

import fs from "fs";
import type {
  AgentConfig,
  AgentContext,
  SubagentDefinition,
  SubagentResult,
  ToolDefinition,
} from "../shared/core-types.js";
import { getTool } from "../tools/registry.js";
import { completeTaskTool } from "../tools/complete-task.js";
import { processSubagentRegistry } from "./subagents/registry.js";

const BASIC_READ_TOOLS = ["Read", "Grep", "Glob"];

const COMPLETION_RULES = [
  "",
  "## Completion protocol",
  "- You are read-only. Never modify files, invoke a shell, or perform Git operations.",
  "- Finish by calling CompleteTask exactly once.",
  "- The report must include evidence paths, conclusions, uncertainty, and recommended next steps.",
  "- For blocked status, state the exact missing information and the question the parent should ask.",
  "- Use partial when useful evidence exists but the full assignment could not be completed.",
  "- For exhaustive/every-line assignments, begin with Glob(path=<exact scope root>, pattern=\"**/*\", include_hidden=true) for each scope root. Inspect every discovered source file in full (using ranged Reads when needed), declare justified file exclusions, and include coverage.exhaustive=true plus exact scope_roots in CompleteTask. Treat any Glob incomplete/skipped-path diagnostic as a real coverage gap.",
  "- Never claim exhaustive completion while any discovered file is unread, partially read, failed, or outside a closed discovery root.",
  "- Do not paste large raw tool outputs into the report.",
].join("\n");

export const EXPLORE_DEF: SubagentDefinition = {
  name: "explore",
  description: "Read-only project exploration and code location.",
  systemPrompt: [
    "You are a code exploration subagent. Search the project broadly and report grounded findings.",
    "Locate relevant files, symbols, call paths, conventions, and risks.",
    COMPLETION_RULES,
  ].join("\n"),
  tools: BASIC_READ_TOOLS,
  readonly: true,
  canSpawn: false,
};

export const RESEARCH_DEF: SubagentDefinition = {
  name: "research",
  description: "Read-only project and external-source research.",
  systemPrompt: [
    "You are a research subagent. Collect and reconcile evidence from project files and readonly web sources.",
    "Distinguish sourced facts, project-local observations, and inference.",
    COMPLETION_RULES,
  ].join("\n"),
  tools: [...BASIC_READ_TOOLS, "WebFetch", "WebSearch"],
  readonly: true,
  canSpawn: false,
};

export const VERIFY_DEF: SubagentDefinition = {
  name: "verify",
  description: "Read-only adversarial review and evidence verification.",
  systemPrompt: [
    "You are a verification subagent. Critically inspect code and claims without executing tests.",
    "Identify unsupported claims, edge cases, test gaps, and evidence with file paths and line references.",
    COMPLETION_RULES,
  ].join("\n"),
  tools: BASIC_READ_TOOLS,
  readonly: true,
  canSpawn: false,
};

export const GENERAL_DEF: SubagentDefinition = {
  name: "general",
  description: "Complex read-only analysis, decomposition, and recursive coordination.",
  systemPrompt: [
    "You are a general read-only analysis subagent.",
    "You may delegate only genuinely independent evidence gathering, specialist analysis, or verification.",
    "Do not delegate simple reads, strongly sequential steps, or work you can complete quickly yourself.",
    "Never delegate code modification. Nested tasks must be required and return evidence, conclusions, uncertainty, and next steps.",
    COMPLETION_RULES,
  ].join("\n"),
  tools: [...BASIC_READ_TOOLS, "Agent"],
  readonly: true,
  canSpawn: true,
};

const BUILTIN_DEFS: Record<string, SubagentDefinition> = {
  explore: EXPLORE_DEF,
  research: RESEARCH_DEF,
  general: GENERAL_DEF,
  verify: VERIFY_DEF,
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
 * Enforce the immutable read-only capability boundary. Configuration can
 * remove safe tools, but can never add mutation tools.
 */
export function resolveSubagentTools(
  definition: SubagentDefinition,
  depth: number,
  maxDepth = 3,
): ToolDefinition[] {
  if (definition.name === "compact") return [];
  const requested = definition.tools.includes("*")
    ? BASIC_READ_TOOLS
    : definition.tools;
  const isCustom = !Object.hasOwn(BUILTIN_DEFS, definition.name.toLowerCase());
  const safeNames = new Set([
    ...BASIC_READ_TOOLS,
    ...(definition.name === "research" || isCustom ? ["WebFetch", "WebSearch"] : []),
    ...(definition.name === "general" && definition.canSpawn && depth < maxDepth ? ["Agent"] : []),
  ]);
  const tools = requested
    .filter((name) => safeNames.has(name))
    .map((name) => getTool(name))
    .filter((tool): tool is ToolDefinition => tool !== undefined);
  tools.push(completeTaskTool);
  return tools;
}

export async function spawnSubagent(
  definition: SubagentDefinition,
  task: string,
  parentCtx: AgentContext,
  parentConfig: AgentConfig,
): Promise<SubagentResult> {
  const rootSessionId = parentCtx.taskRuntime?.rootSessionId ?? parentCtx.sessionId;
  const runtime = processSubagentRegistry.getOrCreate(
    rootSessionId,
    parentCtx.workingDir,
    parentConfig,
  );
  const depth = (parentCtx.taskRuntime?.depth ?? parentCtx.depth ?? 0) + 1;
  const submitted = runtime.submit({
    description: `${definition.name} subagent`,
    prompt: task,
    subagent_type: definition.name,
    dependency: "required",
    model: definition.model,
  }, parentCtx, definition, resolveSubagentTools(definition, depth, runtime.limits.maxDepth));
  const result = await submitted.result;
  return {
    status: result.status,
    agentId: result.agentId,
    taskId: result.taskId,
    output: readReportPreview(result.reportPath),
    summary: result.summary,
    usage: result.usage,
    resultPath: result.reportPath,
    transcriptPath: result.transcriptPath,
    coveragePath: result.coveragePath,
    reportPath: result.reportPath,
    resultJsonPath: result.resultPath,
    filesChanged: [],
    workspace: null,
    patch: null,
  };
}

/** @deprecated Worktree isolation is ignored; normal subagents are read-only. */
export async function spawnSubagentInWorktree(
  definition: SubagentDefinition,
  task: string,
  parentCtx: AgentContext,
  parentConfig: AgentConfig,
): Promise<SubagentResult> {
  const result = await spawnSubagent(definition, task, parentCtx, parentConfig);
  result.summary = `${result.summary ?? ""}\nDeprecated isolation=worktree was ignored; no worktree was created.`.trim();
  return result;
}

export interface BackgroundSubagentHandle {
  agentId: string;
  taskId: string;
  readonly status: "running" | "completed" | "failed";
  wait: () => Promise<SubagentResult>;
  cancel: () => void;
}

export function spawnSubagentInBackground(
  definition: SubagentDefinition,
  task: string,
  parentCtx: AgentContext,
  parentConfig: AgentConfig,
): BackgroundSubagentHandle {
  const rootSessionId = parentCtx.taskRuntime?.rootSessionId ?? parentCtx.sessionId;
  const runtime = processSubagentRegistry.getOrCreate(rootSessionId, parentCtx.workingDir, parentConfig);
  const depth = (parentCtx.taskRuntime?.depth ?? parentCtx.depth ?? 0) + 1;
  const submitted = runtime.submit({
    description: `${definition.name} subagent`,
    prompt: task,
    subagent_type: definition.name,
    dependency: "advisory",
    model: definition.model,
  }, parentCtx, definition, resolveSubagentTools(definition, depth, runtime.limits.maxDepth));
  let state: "running" | "completed" | "failed" = "running";
  const resultPromise = runtime.wait(submitted.task.taskId).then((result): SubagentResult => {
    state = result.status === "completed" ? "completed" : "failed";
    return {
      status: result.status,
      agentId: result.agentId,
      taskId: result.taskId,
      output: readReportPreview(result.reportPath),
      summary: result.summary,
      usage: result.usage,
      resultPath: result.reportPath,
      transcriptPath: result.transcriptPath,
      coveragePath: result.coveragePath,
      reportPath: result.reportPath,
      resultJsonPath: result.resultPath,
      filesChanged: [],
      workspace: null,
      patch: null,
    };
  });
  return {
    agentId: submitted.task.agentId,
    taskId: submitted.task.taskId,
    get status() { return state; },
    wait: () => resultPromise,
    cancel: () => { void runtime.cancel(submitted.task.taskId); },
  };
}

/** @deprecated Artifact paths are task-scoped; use SubagentResult.reportPath. */
export function getSubagentResultPath(agentId: string): string {
  for (const runtime of processSubagentRegistry.list()) {
    const task = runtime.list().find((candidate) => candidate.agentId === agentId);
    if (task) return task.artifacts.report;
  }
  return "";
}

/** @deprecated Artifact paths are task-scoped; use SubagentResult.transcriptPath. */
export function getSubagentTranscriptPath(agentId: string): string {
  for (const runtime of processSubagentRegistry.list()) {
    const task = runtime.list().find((candidate) => candidate.agentId === agentId);
    if (task) return task.artifacts.transcript;
  }
  return "";
}

function readReportPreview(reportPath: string): string {
  try {
    // Avoid a default full report injection into the parent context.
    return fs.readFileSync(reportPath, "utf8").slice(0, 4_000);
  } catch {
    return "";
  }
}
