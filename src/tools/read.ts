// Read tool — reads files into the session, feeds ReadGuard

import fs from "fs";
import path from "path";
import type { ToolDefinition, AgentContext } from "../core-types.js";

const MAX_LINES = 2000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const readTool: ToolDefinition = {
  name: "Read",
  description:
    "Read a file from the filesystem. " +
    "Supports reading a range of lines and PDF pages. " +
    "Reading a file is required before writing or editing it (ReadGuard).",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The absolute path to the file to read",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read",
      },
      pages: {
        type: "string",
        description: 'Page range for PDF files, e.g. "1-5"',
      },
    },
    required: ["file_path"],
  },
  type: "read",
  requiresApproval: false,
  isConcurrencySafe: true,
  async handler(input, ctx) {
    const filePath = resolvePath(input.file_path as string);
    const offset = (input.offset as number) ?? 1;
    const limit = (input.limit as number) ?? MAX_LINES;
    const pages = input.pages as string | undefined;

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return { content: `File not found: ${filePath}`, isError: true };
    }

    const stat = fs.statSync(filePath);

    // Directory
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(filePath, { withFileTypes: true });
      const listing = entries
        .map((e) => `${e.isDirectory() ? "dir" : "file"}  ${e.name}`)
        .join("\n");
      // Mark directory listing as "read" for child files
      ctx.readGuard.markAsRead(filePath, listing);
      return { content: listing || "[empty directory]" };
    }

    // Check file size
    if (stat.size > MAX_FILE_SIZE) {
      return {
        content: `File too large: ${stat.size} bytes (max: ${MAX_FILE_SIZE})`,
        isError: true,
      };
    }

    // Handle PDF
    if (filePath.endsWith(".pdf") && pages) {
      return {
        content: `PDF reading not yet supported in Phase 1. File: ${filePath}`,
        isError: true,
      };
    }

    // Read file
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      // Range reading
      const startLine = Math.max(0, offset - 1);
      const endLine = Math.min(lines.length, startLine + limit);
      const selectedLines = lines.slice(startLine, endLine);

      const output =
        selectedLines
          .map((line, i) => {
            const lineNum = startLine + i + 1;
            return `${String(lineNum).padStart(6, " ")}\t${line}`;
          })
          .join("\n") ||
        (content === "" ? "[file is empty]" : "");

      // Mark file as read (ReadGuard)
      ctx.readGuard.markAsRead(filePath, content);

      // Add header with file info
      const header = `File: ${filePath} (${lines.length} lines, ${stat.size} bytes)\n`;
      const rangeInfo =
        startLine > 0 || endLine < lines.length
          ? `[Showing lines ${startLine + 1}-${endLine} of ${lines.length}]\n`
          : "";

      return { content: header + rangeInfo + output };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `Error reading file: ${message}`, isError: true };
    }
  },
};

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.resolve(process.cwd(), filePath);
}
