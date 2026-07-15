// MEMORY.md reader — reads project memory (similar to Claude Code's memory system)

import fs from "fs";
import path from "path";
import type { ContextSource, ContextBlock, AgentContext } from "../core-types.js";

export class MemoryMdSource implements ContextSource {
  readonly name = "memory-md";
  readonly priority = 20;

  async fetch(_query: string, ctx: AgentContext): Promise<ContextBlock | null> {
    const memoryPath = path.join(ctx.workingDir, "MEMORY.md");

    if (!fs.existsSync(memoryPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(memoryPath, "utf-8");
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
