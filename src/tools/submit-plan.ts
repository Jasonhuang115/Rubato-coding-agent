import fs from "fs";
import path from "path";
import type { ToolDefinition } from "../shared/core-types.js";
import { projectMemoryId } from "../memory-files/paths.js";
import { getRubatoHome } from "../shared/rubato-home.js";

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function planFilePath(workingDir: string, sessionId: string): string {
  return path.join(
    getRubatoHome(),
    "projects",
    projectMemoryId(workingDir),
    "plans",
    `plan-${safeSessionId(sessionId)}.md`,
  );
}

export const submitPlanTool: ToolDefinition = {
  name: "SubmitPlan",
  description:
    "Submit the final decision-complete Markdown plan for user review. This ends the current planning turn without implementing it.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A concise non-empty plan title" },
      markdown: { type: "string", description: "The complete final plan in Markdown" },
    },
    required: ["title", "markdown"],
  },
  type: "read",
  requiresApproval: false,
  isConcurrencySafe: false,
  async handler(input, ctx) {
    if (ctx.mode !== "plan") {
      return { content: "SubmitPlan is available only in Plan mode.", isError: true };
    }
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const markdown = typeof input.markdown === "string" ? input.markdown.trim() : "";
    if (!title || !markdown) {
      return { content: "SubmitPlan requires non-empty title and markdown.", isError: true };
    }

    const target = planFilePath(ctx.workingDir, ctx.sessionId);
    const directory = path.dirname(target);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(temporary, markdown, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return {
      content: `Plan ready for user approval: ${target}`,
      control: { type: "plan_ready", title, markdown, path: target },
    };
  },
};
