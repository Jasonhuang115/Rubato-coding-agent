// Edit tool — exact string replacement in files. Requires ReadGuard.

import fs from "fs";
import path from "path";
import { createTwoFilesPatch } from "diff";
import type { ToolDefinition, AgentContext } from "../core-types.js";
import { enforceReadGuard } from "./registry.js";

export const editTool: ToolDefinition = {
  name: "Edit",
  description:
    "Replace a string in a file with a new string. " +
    "The old_string must match exactly once in the file (or use replace_all for multiple matches). " +
    "The file must have been Read in this session first (ReadGuard).",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to edit",
      },
      old_string: {
        type: "string",
        description: "The text to replace (must match exactly in the file)",
      },
      new_string: {
        type: "string",
        description: "The text to replace it with (must differ from old_string)",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences (default: false)",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  type: "write",
  requiresApproval: true,
  isConcurrencySafe: false,
  async handler(input, ctx) {
    const filePath = resolvePath(input.file_path as string);
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;

    if (oldString === newString) {
      return {
        content: "Error: old_string and new_string must be different",
        isError: true,
      };
    }

    // ReadGuard check
    const guard = enforceReadGuard(filePath, ctx);
    if (!guard.allowed) {
      return { content: guard.reason, isError: true };
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");

      // Count occurrences
      const occurrences = countOccurrences(content, oldString);

      if (occurrences === 0) {
        return {
          content:
            `Error: old_string not found in ${filePath}. ` +
            `The file may have been modified since you last read it. Re-read the file and try again.`,
          isError: true,
        };
      }

      if (!replaceAll && occurrences > 1) {
        return {
          content:
            `Error: old_string found ${occurrences} times in ${filePath}. ` +
            `Use replace_all: true to replace all occurrences, or make old_string more specific.`,
          isError: true,
        };
      }

      // Perform replacement
      const newContent = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      fs.writeFileSync(filePath, newContent, "utf-8");

      // Mark updated content as read
      ctx.readGuard.markAsRead(filePath, newContent);

      // Generate diff
      const patch = createTwoFilesPatch(
        filePath,
        filePath,
        content,
        newContent,
        "before",
        "after"
      );

      const count = replaceAll ? occurrences : 1;
      return {
        content: `File edited: ${filePath} (${count} replacement${count > 1 ? "s" : ""})\n\n${patch}`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error editing file: ${message}`, isError: true };
    }
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.resolve(process.cwd(), filePath);
}
