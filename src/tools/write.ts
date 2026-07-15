// Write tool — creates or overwrites files. Requires ReadGuard for existing files.

import fs from "fs";
import path from "path";
import type { ToolDefinition, AgentContext } from "../core-types.js";
import { enforceReadGuard } from "./registry.js";

export const writeTool: ToolDefinition = {
  name: "Write",
  description:
    "Write content to a file, overwriting if it exists. " +
    "For existing files, the file must have been Read in this session first (ReadGuard). " +
    "Creates parent directories if needed.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
  type: "write",
  requiresApproval: true,
  isConcurrencySafe: false,
  async handler(input, ctx) {
    const filePath = resolvePath(input.file_path as string);
    const content = input.content as string;

    // ReadGuard check for existing files
    if (fs.existsSync(filePath)) {
      const guard = enforceReadGuard(filePath, ctx);
      if (!guard.allowed) {
        return { content: guard.reason, isError: true };
      }
    }

    try {
      // Create parent directories
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });

      // Write file
      fs.writeFileSync(filePath, content, "utf-8");

      // Mark as read (so subsequent writes/edits are allowed without re-reading)
      ctx.readGuard.markAsRead(filePath, content);

      return {
        content: `File written: ${filePath} (${content.length} bytes)`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error writing file: ${message}`, isError: true };
    }
  },
};

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.resolve(process.cwd(), filePath);
}
