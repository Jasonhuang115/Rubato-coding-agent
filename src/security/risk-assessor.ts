// Risk Assessor — evaluates tool operation risk levels.
// Used by SecurityRuntime to assign risk metadata to every tool execution.

import type { RiskLevel } from "./sandbox/sandbox.js";

export { type RiskLevel } from "./sandbox/sandbox.js";

export interface RiskAssessment {
  level: RiskLevel;
  factors: string[];
}

/**
 * Assess the risk of a tool operation based on tool name and input.
 * Returns both a level and the factors that contributed.
 */
export function assessRisk(toolName: string, input: Record<string, unknown>): RiskAssessment {
  const factors: string[] = [];

  switch (toolName) {
    case "Bash": {
      const cmd = (input.command as string) ?? "";
      factors.push("shell_execution");

      if (cmd.includes("sudo ")) {
        factors.push("sudo");
        return { level: "critical", factors };
      }
      if (/\brm\s+(-[^\s]*\s+)*\//.test(cmd)) {
        factors.push("root_delete");
        return { level: "high", factors };
      }
      if (/\brm\s/.test(cmd)) {
        factors.push("delete");
        return { level: "high", factors };
      }
      if (/\bgit\s+push\b/.test(cmd)) {
        factors.push("push");
        return { level: "medium", factors };
      }
      if (/\bgit\s+commit\b/.test(cmd)) {
        factors.push("commit");
        return { level: "low", factors };
      }
      if (/\bnpm\s+(install|publish|unpublish)\b/.test(cmd)) {
        factors.push("package_management");
        return { level: "medium", factors };
      }
      if (/\bnpm\s+(test|run|ls|view)\b/.test(cmd) || /\bnpx\b/.test(cmd)) {
        factors.push("dev_tool");
        return { level: "low", factors };
      }
      return { level: "medium", factors };
    }

    case "Write":
    case "Edit":
      factors.push("filesystem_write");
      return { level: "medium", factors };

    case "WebFetch":
    case "WebSearch":
      factors.push("network");
      return { level: "medium", factors };

    case "Read":
    case "Grep":
    case "Glob":
      factors.push("filesystem_read");
      return { level: "low", factors };

    default:
      factors.push("unknown_tool");
      return { level: "low", factors };
  }
}
