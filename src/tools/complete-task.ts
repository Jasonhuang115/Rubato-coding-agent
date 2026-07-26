import type {
  CompleteTaskCoverageDeclaration,
  CompleteTaskInput,
  ToolDefinition,
  ToolResult,
} from "../shared/core-types.js";
import { makesExhaustiveClaim } from "../agent/subagents/coverage.js";

function validate(input: Record<string, unknown>): CompleteTaskInput | null {
  const status = input.status;
  const summary = input.summary;
  const report = input.report_markdown;
  if (
    (status !== "completed" && status !== "partial" && status !== "blocked") ||
    typeof summary !== "string" ||
    summary.trim().length === 0 ||
    typeof report !== "string" ||
    report.trim().length === 0
  ) {
    return null;
  }

  const keyFiles = Array.isArray(input.key_files)
    ? input.key_files.filter((value): value is string => typeof value === "string")
    : undefined;
  const artifacts = Array.isArray(input.artifacts)
    ? input.artifacts.flatMap((value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as { path?: unknown }).path === "string" &&
          typeof (value as { description?: unknown }).description === "string"
        ) {
          return [{
            path: (value as { path: string }).path,
            description: (value as { description: string }).description,
          }];
        }
        return [];
      })
    : undefined;
  const coverage = validateCoverage(input.coverage);
  if (input.coverage !== undefined && !coverage) return null;

  return {
    status,
    summary: summary.trim(),
    report_markdown: report.trim(),
    key_files: keyFiles,
    artifacts,
    coverage: coverage ?? undefined,
  };
}

function validateCoverage(value: unknown): CompleteTaskCoverageDeclaration | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.exhaustive !== undefined && typeof record.exhaustive !== "boolean") return null;
  const scopeRoots = record.scope_roots === undefined
    ? undefined
    : Array.isArray(record.scope_roots)
      ? record.scope_roots.filter((item): item is string =>
          typeof item === "string" && item.trim().length > 0)
      : null;
  if (scopeRoots === null) return null;
  const exclusions = record.exclusions === undefined
    ? undefined
    : Array.isArray(record.exclusions)
      ? record.exclusions.flatMap((item) => {
          if (
            typeof item === "object" &&
            item !== null &&
            typeof (item as { path?: unknown }).path === "string" &&
            typeof (item as { reason?: unknown }).reason === "string" &&
            (item as { path: string }).path.trim().length > 0 &&
            (item as { reason: string }).reason.trim().length > 0
          ) {
            return [{
              path: (item as { path: string }).path.trim(),
              reason: (item as { reason: string }).reason.trim(),
            }];
          }
          return [];
        })
      : null;
  if (exclusions === null) return null;
  return {
    exhaustive: record.exhaustive as boolean | undefined,
    scope_roots: scopeRoots?.map((root) => root.trim()),
    exclusions,
  };
}

/**
 * Internal completion protocol. This definition is injected directly into a
 * subagent's scoped tool set and is never registered as a root-agent tool.
 */
export const completeTaskTool: ToolDefinition = {
  name: "CompleteTask",
  description:
    "Submit the final self-contained Markdown report for this subagent task and stop immediately. " +
    "This tool may be called exactly once. Exhaustive assignments must include a coverage declaration; " +
    "the runtime accepts completed status only when observable Glob/Read coverage is closed.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "partial", "blocked"] },
      summary: { type: "string" },
      report_markdown: { type: "string" },
      key_files: { type: "array", items: { type: "string" } },
      artifacts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            description: { type: "string" },
          },
          required: ["path", "description"],
        },
      },
      coverage: {
        type: "object",
        properties: {
          exhaustive: {
            type: "boolean",
            description: "Set true when the task promises every-file or every-line coverage.",
          },
          scope_roots: {
            type: "array",
            items: { type: "string" },
            description: "Exact directory roots whose complete contents were in scope.",
          },
          exclusions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                reason: { type: "string" },
              },
              required: ["path", "reason"],
            },
            description: "Discovered non-source/generated/binary files deliberately excluded, each with a reason.",
          },
        },
      },
    },
    required: ["status", "summary", "report_markdown"],
  },
  type: "read",
  isConcurrencySafe: false,
  async handler(input, ctx): Promise<ToolResult> {
    if (!ctx.taskRuntime) {
      return {
        content: "CompleteTask is only available inside a managed subagent task.",
        isError: true,
      };
    }
    if (ctx.taskRuntime.completionSubmitted) {
      return {
        content: "Control error: CompleteTask has already been submitted for this task.",
        isError: true,
      };
    }

    const completion = validate(input);
    if (!completion) {
      return {
        content: "Invalid CompleteTask input: status, summary, and report_markdown are required.",
        isError: true,
      };
    }

    const unmatchedExclusions = ctx.taskRuntime.coverage
      ?.applyDeclaration(completion.coverage) ?? [];
    if (unmatchedExclusions.length > 0) {
      return {
        content: [
          "Coverage control error: exclusions may only refer to files observed by Glob, Grep, or Read.",
          `Unmatched: ${unmatchedExclusions.slice(0, 10).join(", ")}`,
        ].join("\n"),
        isError: true,
      };
    }
    const coverage = ctx.taskRuntime.coverage?.snapshot();
    const exhaustiveGate = ctx.taskRuntime.coverage?.required === true ||
      completion.coverage?.exhaustive === true ||
      makesExhaustiveClaim(`${completion.summary}\n${completion.report_markdown}`);
    if (completion.status === "completed" && exhaustiveGate && coverage?.complete !== true) {
      const unresolved = coverage?.files
        .filter((file) => file.status === "discovered" || file.status === "failed")
        .slice(0, 10)
        .map((file) => file.path) ?? [];
      return {
        content: [
          "Coverage control error: completed/exhaustive delivery was rejected because observable coverage is not closed.",
          coverage
            ? `discovered=${coverage.discovered}, inspected=${coverage.inspected}, excluded=${coverage.excluded}, failed=${coverage.failed}, discovery_complete=${coverage.discovery_complete}`
            : "No runtime coverage evidence is available.",
          unresolved.length > 0 ? `Still unresolved: ${unresolved.join(", ")}` : "",
          coverage?.discovery_complete === false
            ? "To close discovery, run Glob with path set to each exact scope root, pattern **/*, and include_hidden=true (or use an equivalent literal-prefix recursive pattern)."
            : "",
          "Continue inspecting the missing scope, or submit status=partial and state the coverage gap honestly.",
        ].filter(Boolean).join("\n"),
        isError: true,
      };
    }

    ctx.taskRuntime.completionSubmitted = true;
    return {
      content: "Task completion accepted.",
      control: { type: "task_completion", completion },
    };
  },
};
