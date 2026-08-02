// Tool registry — manages tool definitions and dispatch

import fs from "fs";
import type { ToolDefinition, AgentContext, ToolResult } from "../shared/core-types.js";
import { resolveToolPath } from "./path-utils.js";
import type { AgentMode } from "../shared/core-types.js";

const tools = new Map<string, ToolDefinition>();

export function register(tool: ToolDefinition): void {
  if (tools.has(tool.name)) {
    throw new Error(`Tool "${tool.name}" is already registered`);
  }
  tools.set(tool.name, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

export function getAllTools(): ToolDefinition[] {
  return Array.from(tools.values());
}

export const PLAN_TOOL_NAMES = new Set([
  "Read", "Grep", "Glob", "WebFetch", "WebSearch", "Agent", "Task", "SubmitPlan",
]);

export function getToolsForMode(mode: AgentMode): ToolDefinition[] {
  const all = getAllTools();
  if (mode === "plan") return all.filter((tool) => PLAN_TOOL_NAMES.has(tool.name));
  return all.filter((tool) => tool.name !== "SubmitPlan");
}

export async function dispatch(
  name: string,
  input: Record<string, unknown>,
  ctx: AgentContext
): Promise<ToolResult> {
  const tool = tools.get(name);
  if (!tool) {
    return { content: `Unknown tool: ${name}`, isError: true };
  }

  try {
    return await tool.handler(input, ctx);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Tool error (${name}): ${message}`, isError: true };
  }
}

export function unregister(name: string): boolean {
  return tools.delete(name);
}

export function clear(): void {
  tools.clear();
}

// ---- ReadGuard helpers used by Write/Edit tools ----

export function enforceReadGuard(
  filePath: string,
  ctx: AgentContext
): { allowed: false; reason: string } | { allowed: true } {
  // Normalize path for comparison
  const normalized = resolveToolPath(filePath, ctx.workingDir);

  if (ctx.readGuard.hasRead(normalized)) {
    return { allowed: true };
  }

  // If file doesn't exist yet, it's a new file — allow
  try {
    if (!fs.existsSync(normalized)) {
      return { allowed: true };
    }
  } catch {
    // If we can't check, allow (permissive)
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `ReadGuard: file "${filePath}" has not been read in this session. Read the file first before writing or editing.`,
  };
}
