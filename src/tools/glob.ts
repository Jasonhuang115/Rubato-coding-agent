// Glob tool — finds files by pattern

import fs from "fs";
import path from "path";
import type { ToolDefinition, AgentContext } from "../core-types.js";

const MAX_RESULTS = 500;

export const globTool: ToolDefinition = {
  name: "Glob",
  description:
    "Find files matching a glob pattern. " +
    "Supports standard glob syntax: *, **, ?, [abc], {a,b}. " +
    "Useful for discovering file structure and finding files by naming convention.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match (e.g. 'src/**/*.ts', '*.md')",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: working directory)",
      },
      max_results: {
        type: "number",
        description: `Maximum results to return (default: ${MAX_RESULTS})`,
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
    const maxResults = (input.max_results as number) ?? MAX_RESULTS;

    // Ensure the search path exists
    if (!fs.existsSync(searchPath)) {
      return { content: `Path not found: ${searchPath}`, isError: true };
    }

    const results = await globWalk(searchPath, pattern, maxResults);

    if (results.length === 0) {
      return { content: `No files matching "${pattern}" in ${searchPath}` };
    }

    const truncated = results.length >= maxResults;
    const output =
      results
        .map((f) => {
          // Relative path from searchPath for cleaner output
          const rel = path.relative(searchPath, f);
          const stat = fs.statSync(f);
          const size = stat.isDirectory() ? "-" : formatSize(stat.size);
          return `${size.padStart(8)}  ${rel}`;
        })
        .join("\n");

    const header = `${results.length} file${results.length === 1 ? "" : "s"} matching "${pattern}" in ${searchPath}${truncated ? ` (limited to ${maxResults})` : ""}:\n\n`;

    return { content: header + output };
  },
};

async function globWalk(
  root: string,
  pattern: string,
  maxResults: number
): Promise<string[]> {
  const results: string[] = [];

  // Convert glob to regex for matching
  const regex = globToRegex(pattern);

  async function walk(dir: string) {
    if (results.length >= maxResults) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Skip inaccessible directories
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);

      // Skip hidden files/dirs by default (unless pattern explicitly starts with .)
      if (entry.name.startsWith(".") && !pattern.startsWith(".")) continue;

      // Skip node_modules
      if (entry.name === "node_modules") continue;

      // Skip .git
      if (entry.name === ".git") continue;

      // Match against pattern
      if (regex.test(relPath) || regex.test(entry.name)) {
        results.push(fullPath);
      }

      // Recurse into directories for ** patterns
      if (entry.isDirectory()) {
        const hasGlobstar = pattern.includes("**");
        if (hasGlobstar || relPath.split(path.sep).length < 5) {
          await walk(fullPath);
        }
      }
    }
  }

  await walk(root);

  // Sort: directories first, then alphabetical
  results.sort((a, b) => {
    const aIsDir = fs.statSync(a).isDirectory();
    const bIsDir = fs.statSync(b).isDirectory();
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a.localeCompare(b);
  });

  return results.slice(0, maxResults);
}

function globToRegex(glob: string): RegExp {
  // Simple glob to regex conversion
  let pattern = glob
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<GLOBSTAR>>/g, ".*")
    .replace(/\?/g, "[^/]")
    .replace(/\[([^\]]+)\]/g, "[$1]")
    .replace(/\{([^}]+)\}/g, (_, p1) => `(${p1.split(",").join("|")})`);

  return new RegExp(`^${pattern}$|/${pattern}$`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.resolve(process.cwd(), filePath);
}
