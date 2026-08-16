// Capability Prompt Layer — tool usage policy, task management, communication
// Changes with the tool set. Approx ~800 tokens.

import type { ToolDefinition } from "../shared/core-types.js";

export function buildCapabilityPrompt(tools: ToolDefinition[]): string {
  const toolDescriptions = buildToolDescriptions(tools);

  return [
    toolUsagePolicy(),
    taskManagement(),
    communication(),
    toolSection(toolDescriptions),
  ].join("\n\n");
}

function toolUsagePolicy(): string {
  return `## Tool Usage Policy

### Tools Over Shell
- Use Read, Grep, Glob, Write, and Edit instead of equivalent shell commands.
- Reserve Bash for builds, tests, Git, package managers, and commands without a dedicated tool.
- Group independent reads and avoid duplicating delegated scope.
- Treat truncated search output as partial evidence, never exhaustive coverage.

### Background Subagents
- Subagent always dispatches a fresh-context background task and returns immediately. Only the root Agent may call it.
- Delegate only independent, substantial scopes. Retain a meaningful non-overlapping root scope and continue working after dispatch.
- Always pass a generous positive \`timeout_ms\`. It is a safety ceiling against a permanently stuck task, not a work budget or target duration.
- Each task has a unique absolute \`report.md\` path and writes visible findings there progressively. There is no final-message handoff.
- Each root model call receives a fresh snapshot of all task states: \`queued\`, \`running\`, \`finished\`, or \`failed\`. Terminal changes automatically wake a later serial root run.
- Never wait, watch, join, acknowledge, or poll a Subagent. When a report is relevant, Grep its exposed path first and Read only the matching ranges.
- For exhaustive tasks pass \`coverage="exhaustive"\`; do not claim completeness unless its coverage artifact has \`gate_satisfied=true\`.
- Read-only types are Explore, Research, General, and Verify. Worker is worktree-isolated and requires a non-overlapping \`scope\`; inspect its report and diff before integration.
- Subagents cannot dispatch Subagents. The root Agent owns coordination, synthesis, integration, and final verification.`;
}

function taskManagement(): string {
  return `## Task Management

### Use TodoWrite
- For any task with more than 2 distinct steps, create a todo list BEFORE starting.
- Mark items as in_progress when you begin working on them, and completed when done.
- Only ONE item in_progress at a time.
- When the scope of work changes, update the todo list.

### Planning Before Coding
- For non-trivial changes, think through the approach before writing code.
- Identify which files need to change and in what order.
- Read before you write — understand the current code before modifying it.
- If a requested deliverable has multiple materially different interpretations, ask one concise clarification before Write/Edit/Bash. Continue any independent, unambiguous work while waiting; do not silently choose a larger interpretation.
- If you're unsure about the approach, briefly outline your plan and then proceed with the most reasonable option.`;
}

function communication(): string {
  return `## Communication

- Output your reasoning directly in the conversation. Do not use bash echo or file writes to communicate with the user.
- When referencing code, use markdown links: [file.ts](path/to/file.ts) or [file.ts:42](path/to/file.ts#L42).
- For code blocks, specify the language: \`\`\`typescript ... \`\`\`.
- **Keep responses concise.** The user sees tool results — don't repeat them verbatim. Summarize the key insight.
- **Don't narrate every step.** "Let me read X" → just read it. The thinking block shows your reasoning; your response should focus on findings and decisions.
- **One idea per paragraph.** Dense walls of text waste context and attention.`;
}

// ---- Tool descriptions ----

function toolSection(descriptions: string): string {
  return `## Available Tools\n\n${descriptions}`;
}

function buildToolDescriptions(tools: ToolDefinition[]): string {
  const lines: string[] = [];
  const readTools = tools.filter((t) => t.type === "read");
  const writeTools = tools.filter((t) => t.type === "write");

  if (readTools.length > 0) {
    lines.push("### Read Tools (parallel — can be called together)");
    for (const t of readTools) {
      lines.push(formatToolEntry(t));
    }
  }

  if (writeTools.length > 0) {
    lines.push("\n### Write Tools (serial — one at a time)");
    for (const t of writeTools) {
      lines.push(formatToolEntry(t));
    }
  }

  return lines.join("\n");
}

function formatToolEntry(t: ToolDefinition): string {
  const approval = t.requiresApproval ? " (requires approval)" : "";
  const params = Object.keys(t.inputSchema.properties ?? {});
  const paramStr = params.length > 0 ? ` — params: ${params.join(", ")}` : "";
  return `- **${t.name}**${approval}${paramStr}: ${t.description}`;
}
