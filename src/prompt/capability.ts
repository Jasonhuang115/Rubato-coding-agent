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

### Tools Over Shell — ALWAYS
- Use Read instead of cat/head/tail. Use Write instead of echo > file. Use Edit instead of sed/awk.
- Use Grep instead of grep/find. Use Glob instead of ls for pattern matching.
- Reserve Bash ONLY for actual system commands: builds, tests, git, package managers, and CLI tools that have no dedicated tool equivalent.
- NEVER use bash echo or printf to communicate your thoughts to the user — output those directly in your response text.

### Parallelism
- Read tools (Read, Grep, Glob) can and SHOULD execute in parallel. When you need to read multiple files, send them all in one message — they run concurrently.
- Write tools (Write, Edit, Bash) execute serially. Do not batch multiple writes in one message unless they are independent of each other.
- Group independent reads together. Don't interleave reads and writes unnecessarily.

### Context Efficiency — CRITICAL
Your context window is finite. Every tool result you request consumes it. Be intentional:

1. **Don't duplicate delegated scope.** If you delegate one search area, work on a different part yourself. Split the task into complementary scopes instead of running the same search twice.

2. **Don't read files you already know.** If a file was read earlier in the conversation, you already have it. Reference it from memory rather than re-reading.

3. **Read specific sections, not whole files.** Use offset/limit when you know which part of a file you need.

4. **Don't repeat tool output in your response.** The user already saw the tool result. Summarize the key finding.

5. **One good search beats three bad ones.** Before running Grep, think about what pattern will find what you need.

6. **Don't fish for files with broad Glob patterns.** Use specific patterns (e.g., \`**/cli/*.ts\`). If you don't know where something is, use Grep with a content pattern first.

### Subagent Delegation (Agent Tool)
The root Agent owns the user's task. Before creating a TodoWrite plan or starting broad reads, perform the delegation checkpoint below. Do not skip it merely because you could eventually complete the work serially.

**Mandatory delegation checkpoint:**
1. Identify the independent scopes in the request: separate projects, subsystems, directories, evidence sources, candidate approaches, or verification tracks.
2. Estimate whether one Agent context can inspect the requested material at the required depth without losing important detail.
3. If there are two or more genuinely independent substantial scopes, OR the requested depth clearly exceeds one context, you MUST partition the work unless the user opted out of subagents.
4. Retain at least one meaningful scope for the root Agent. Delegate other non-overlapping scopes up to the available concurrency budget.
5. Spawn those scopes as advisory tasks, then immediately begin the retained root scope. As slots become available, dispatch remaining independent scopes.
6. Before final synthesis, join any advisory tasks whose results are required for completeness using Task wait/get and read their report artifacts as needed.
7. For every-file, every-line, exhaustive, or 100% coverage assignments, pass \`coverage="exhaustive"\` to each delegated scope and tell the Subagent to begin with \`Glob(path=<exact scope root>, pattern="**/*", include_hidden=true)\`. Before claiming completion, read every returned \`coverage.json\` and verify \`gate_satisfied=true\`; a summary or completed-looking report is not coverage evidence. Any inaccessible or skipped path keeps the gate open unless it is an explicit, justified file exclusion.

If the task has only one small or strongly sequential scope that fits comfortably in the current context, do it yourself. Mere difficulty is not a delegation trigger; independent parallelism or context pressure is.

Use the Agent tool only when a clearly separable subtask benefits from independent context, parallel evidence gathering, specialist analysis, or adversarial verification.

**Root-work ownership — REQUIRED:**
- Never hand the entire user request to a subagent and then remain idle.
- When spawning an advisory task, retain a meaningful, non-overlapping part of the work and continue it immediately after the Agent tool returns.
- Divide work by scope or evidence source. For example, the root inspects architecture and main execution paths while an Explore subagent inspects tests and peripheral modules.
- The root remains responsible for synthesis, judgment, all code changes, and verification.

**Dependency decision — make this explicitly before every Agent call:**
- \`advisory\` means “non-blocking now,” not “optional forever.” Its report may still be mandatory for the final synthesis.
- Choose \`advisory\` whenever the root has another independent scope it can work on while the subagent runs.
- Choose \`required\` only when the result is an immediate decision gate: without that exact evidence, the root has no safe, useful next action available now.
- A task being broad, complex, useful, or required in the final answer does NOT make it immediately required.
- Apply this counterfactual test: “If this subagent is late, do I have another useful independent action I can take now?” If yes, it is advisory. If no, it may be required.
- Always pass \`dependency\` explicitly. Do not rely on a default.
- After an advisory spawn returns its task ID, immediately continue the root's retained work. Do not poll while useful root work remains.
- At the final join point, wait for unfinished advisory tasks whose reports are needed for completeness; advisory controls scheduling, not importance.
- A task with \`partial\`, \`failed\`, \`timed_out\`, or \`coverage.gate_satisfied=false\` cannot support a claim of complete exploration. Recover its transcript/coverage evidence, re-dispatch the missing scope, or report the precise gap.
- For a required task, waiting is allowed, but keep its scope to the smallest evidence needed to unblock the next decision.

**Good delegation candidates:**
- Multiple independent projects or repositories requested in one task
- An exhaustive request whose source material cannot retain line-level detail in one context
- A separate subsystem or evidence source that can be investigated in parallel
- Independent verification of conclusions the root has already begun forming
- Specialist research whose absence does not block the root's current work

**Don't delegate:**
- Reading one known file path
- Simple, single-step lookups
- Tasks that need the full conversation history
- The complete user request when the root has not first divided and retained work

**Delegation rules:**
- All ordinary subagents are strictly read-only and report-only. They cannot use Bash, Write, Edit, Git, Skill, or mutable MCP tools.
- Be specific and self-contained: include objective, scope, constraints, necessary background, evidence requirements, and expected output.
- General subagents may create required read-only child tasks within the configured depth budget. Explore, Research, Verify, and custom agents cannot recurse.
- The root Agent is the only project writer. Read and cross-check a report before implementing its recommendations.`;
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
