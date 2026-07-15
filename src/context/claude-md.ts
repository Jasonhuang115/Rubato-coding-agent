// CLAUDE.md reader — reads project-level instructions

import fs from "fs";
import path from "path";
import type { ContextSource, ContextBlock, AgentContext } from "../core-types.js";

export class ClaudeMdSource implements ContextSource {
  readonly name = "claude-md";
  readonly priority = 10;

  async fetch(_query: string, ctx: AgentContext): Promise<ContextBlock | null> {
    const filePath = path.join(ctx.workingDir, "CLAUDE.md");

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return {
        content,
        priority: this.priority,
        source: this.name,
      };
    } catch {
      return null;
    }
  }
}
