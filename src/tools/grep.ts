// Grep tool — searches file contents with regex

import { spawn } from "child_process";
import path from "path";
import type { ToolDefinition, AgentContext } from "../core-types.js";

const MAX_MATCHES = 500;
const MAX_OUTPUT_LENGTH = 100_000;

export const grepTool: ToolDefinition = {
  name: "Grep",
  description:
    "Search file contents using a regex pattern. " +
    "Uses ripgrep (rg) if available, falls back to grep. " +
    "Returns matching file paths with line numbers and matching lines.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The regex pattern to search for",
      },
      path: {
        type: "string",
        description: "Directory or file to search in (default: working directory)",
      },
      include: {
        type: "string",
        description: "File glob pattern to include (e.g. '*.ts')",
      },
      exclude: {
        type: "string",
        description: "Pattern to exclude (passed to --glob '!pattern' in rg)",
      },
      max_matches: {
        type: "number",
        description: `Maximum matches to return (default: ${MAX_MATCHES})`,
      },
      ignore_case: {
        type: "boolean",
        description: "Case-insensitive search (default: false)",
      },
    },
    required: ["pattern"],
  },
  type: "read",
  requiresApproval: false,
  isConcurrencySafe: true,
  async handler(input, ctx) {
    const pattern = input.pattern as string;
    const searchPath = resolvePath(
      (input.path as string) ?? ctx.workingDir ?? process.cwd()
    );
    const include = input.include as string | undefined;
    const exclude = input.exclude as string | undefined;
    const maxMatches = (input.max_matches as number) ?? MAX_MATCHES;
    const ignoreCase = (input.ignore_case as boolean) ?? false;

    return new Promise((resolve) => {
      // Try ripgrep first, fall back to grep
      const useRg = true; // try rg first
      const cmd = useRg ? "rg" : "grep";

      const args: string[] = [
        "--line-number",
        "--no-heading",
        "--color=never",
        "--with-filename",
        `-m${maxMatches}`,
      ];

      if (ignoreCase) args.push("--ignore-case");

      if (include) {
        args.push("--glob", include);
      }

      if (exclude) {
        args.push("--glob", `!${exclude}`);
      }

      // Escape the pattern for shell safety — rg treats it as regex by default
      args.push("--");
      args.push(pattern);
      args.push(searchPath);

      const child = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: ctx.workingDir ?? process.cwd(),
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_LENGTH) {
          stdout += data.toString();
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code: number | null) => {
        // rg exits with 1 for "no matches", which is fine
        if (code !== 0 && code !== 1 && !stdout) {
          // rg not found, try grep
          if (useRg && code === 127) {
            // rg not found — try with grep
            const grepChild = spawn(
              "grep",
              ["-rnI", "--color=never", `-m${maxMatches}`, pattern, searchPath],
              {
                stdio: ["pipe", "pipe", "pipe"],
                cwd: ctx.workingDir ?? process.cwd(),
              }
            );

            let grepOut = "";
            grepChild.stdout?.on("data", (data: Buffer) => {
              if (grepOut.length < MAX_OUTPUT_LENGTH) {
                grepOut += data.toString();
              }
            });

            grepChild.on("close", () => {
              const lines = grepOut.trim().split("\n").filter(Boolean);
              resolve({
                content: formatResults(pattern, searchPath, lines, maxMatches),
              });
            });

            grepChild.on("error", () => {
              resolve({
                content: `Search failed: neither rg nor grep available`,
                isError: true,
              });
            });
            return;
          }

          resolve({
            content: `Search error: ${stderr || `rg exited with code ${code}`}`,
            isError: true,
          });
          return;
        }

        const lines = stdout.trim().split("\n").filter(Boolean);
        resolve({
          content: formatResults(pattern, searchPath, lines, maxMatches),
        });
      });

      child.on("error", () => {
        // rg not installed, try grep
        const grepChild = spawn(
          "grep",
          ["-rnI", "--color=never", `-m${maxMatches}`, pattern, searchPath],
          {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: ctx.workingDir ?? process.cwd(),
          }
        );

        let grepOut = "";
        grepChild.stdout?.on("data", (data: Buffer) => {
          if (grepOut.length < MAX_OUTPUT_LENGTH) {
            grepOut += data.toString();
          }
        });

        grepChild.on("close", () => {
          const lines = grepOut.trim().split("\n").filter(Boolean);
          resolve({
            content: formatResults(pattern, searchPath, lines, maxMatches),
          });
        });

        grepChild.on("error", () => {
          resolve({
            content: `Search failed: neither rg nor grep available on this system`,
            isError: true,
          });
        });
      });
    });
  },
};

function formatResults(
  pattern: string,
  searchPath: string,
  lines: string[],
  maxMatches: number
): string {
  if (lines.length === 0) {
    return `No matches found for "${pattern}" in ${searchPath}`;
  }

  const truncated = lines.length >= maxMatches;
  const header = `${lines.length} match${lines.length === 1 ? "" : "es"} for "${pattern}" in ${searchPath}${truncated ? ` (limited to ${maxMatches})` : ""}:\n\n`;

  // Trim long lines
  const formatted = lines
    .map((line) => {
      if (line.length > 500) {
        return line.substring(0, 497) + "...";
      }
      return line;
    })
    .join("\n");

  return header + formatted;
}

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.resolve(process.cwd(), filePath);
}
