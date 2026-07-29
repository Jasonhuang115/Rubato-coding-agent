// Glob tool — finds files by pattern

import fs from "fs";
import path from "path";
import type { ToolDefinition } from "../shared/core-types.js";
import { resolveToolPath } from "./path-utils.js";

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
      include_hidden: {
        type: "boolean",
        description:
          "Include dotfiles and hidden directories. Exhaustive discovery must set this to true.",
      },
    },
    required: ["pattern"],
  },
  type: "read",
  requiresApproval: false,
  isConcurrencySafe: true,
  async handler(input, ctx) {
    const pattern = input.pattern as string;
    const searchPath = resolveToolPath((input.path as string) ?? ".", ctx.workingDir);
    const maxResults = (input.max_results as number) ?? MAX_RESULTS;
    const includeHidden = input.include_hidden === true;

    // Ensure the search path exists
    if (!fs.existsSync(searchPath)) {
      return { content: `Path not found: ${searchPath}`, isError: true };
    }

    let walkResult: GlobWalkResult;
    try {
      walkResult = await globWalk(
        searchPath,
        pattern,
        maxResults,
        includeHidden,
        ctx.abortSignal,
      );
    } catch (error) {
      if (ctx.abortSignal?.aborted) {
        return { content: "Glob cancelled.", isError: true };
      }
      throw error;
    }

    const { results, skipped, policyExclusions, reachedLimit } = walkResult;

    const truncated = reachedLimit;
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

    const header = results.length === 0
      ? `No files matching "${pattern}" in ${searchPath}`
      : `${results.length} file${results.length === 1 ? "" : "s"} matching "${pattern}" in ${searchPath}${truncated ? ` (limited to ${maxResults})` : ""}:\n\n${output}`;
    const diagnostics = [
      ...(truncated
        ? [
            `INCOMPLETE DISCOVERY: the result limit (${maxResults}) was reached. ` +
            "These entries are only a partial sample; narrow or partition the search " +
            "before claiming all files/projects were inspected.",
          ]
        : []),
      ...policyExclusions.map((entry) =>
        `Glob policy exclusion: ${entry.path} (${entry.reason})`),
      ...skipped.map((entry) =>
        `Glob incomplete: skipped ${entry.path} (${entry.reason})`),
    ];

    return {
      content: [header, diagnostics.join("\n")].filter(Boolean).join("\n\n"),
    };
  },
};

interface GlobWalkResult {
  results: string[];
  skipped: Array<{ path: string; reason: string }>;
  policyExclusions: Array<{ path: string; reason: string }>;
  reachedLimit: boolean;
}

async function globWalk(
  root: string,
  pattern: string,
  maxResults: number,
  includeHidden: boolean,
  signal?: AbortSignal,
): Promise<GlobWalkResult> {
  const results: string[] = [];
  const skipped: GlobWalkResult["skipped"] = [];
  const policyExclusions: GlobWalkResult["policyExclusions"] = [];
  let reachedLimit = false;

  // Convert glob to regex for matching
  const regex = globToRegex(pattern);

  async function walk(dir: string) {
    if (signal?.aborted) throw signal.reason ?? new Error("Glob cancelled");
    if (results.length >= maxResults) {
      reachedLimit = true;
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      skipped.push({
        path: dir,
        reason: error instanceof Error ? error.message : "directory is inaccessible",
      });
      return;
    }

    for (const entry of entries) {
      if (signal?.aborted) throw signal.reason ?? new Error("Glob cancelled");
      if (results.length >= maxResults) {
        reachedLimit = true;
        break;
      }

      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);

      if (entry.name === "node_modules" || entry.name === ".git") {
        policyExclusions.push({
          path: fullPath,
          reason: entry.name === ".git"
            ? "Git metadata is excluded by policy."
            : "Dependency directories are excluded by policy.",
        });
        continue;
      }
      if (entry.name.startsWith(".") && !includeHidden) continue;

      if (entry.isSymbolicLink()) {
        let target: fs.Stats;
        try {
          target = fs.statSync(fullPath);
        } catch (error) {
          skipped.push({
            path: fullPath,
            reason: error instanceof Error ? error.message : "symbolic link target is inaccessible",
          });
          continue;
        }
        if (target.isDirectory()) {
          skipped.push({
            path: fullPath,
            reason: "symbolic-link directories are not traversed",
          });
          continue;
        }
      }

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

  return {
    results: results.slice(0, maxResults),
    skipped,
    policyExclusions,
    reachedLimit,
  };
}

function globToRegex(glob: string): RegExp {
  // Simple glob to regex conversion
  let pattern = glob
    .replace(/\./g, "\\.")
    .replace(/\*\*\//g, "<<GLOBSTAR_DIR>>")
    .replace(/\*\*/g, "<<GLOBSTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\[([^\]]+)\]/g, "[$1]")
    .replace(/\{([^}]+)\}/g, (_, p1) => `(${p1.split(",").join("|")})`)
    .replace(/<<GLOBSTAR_DIR>>/g, "(?:.*/)?")
    .replace(/<<GLOBSTAR>>/g, ".*");

  return new RegExp(`^${pattern}$|/${pattern}$`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
