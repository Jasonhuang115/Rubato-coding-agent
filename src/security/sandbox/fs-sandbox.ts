// FsSandbox — validates file operations stay within workspace boundaries
// Handles path traversal, symlink resolution, and sensitive path blocking.

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ISandbox, SandboxResult } from "./sandbox.js";
import { matchSensitivePath } from "./sensitive-paths.js";

const TOOL_RESULT_PATTERN = /^\/tmp\/rubato-tool-results\/[A-Za-z0-9_-]+\.txt$/;

export class FsSandbox implements ISandbox {
  readonly name = "fs-sandbox";

  validate(toolName: string, input: Record<string, unknown>, workingDir: string): SandboxResult {
    const pathKey = toolName === "Grep" || toolName === "Glob" ? "path" : "file_path";
    const filePath = input[pathKey] as string | undefined;
    if (!filePath) return { allowed: true };

    const resolved = this.resolvePath(filePath, workingDir);
    const workspaceRoot = path.resolve(workingDir);
    let realWorkspaceRoot = workspaceRoot;
    try {
      realWorkspaceRoot = fs.realpathSync(workspaceRoot);
    } catch {
      // A not-yet-created workspace falls back to its lexical path.
    }

    // 0. Allow reads of Rubato-owned temporary artifacts, but no arbitrary /tmp access.
    if (
      (toolName === "Read" || toolName === "Grep" || toolName === "Glob") &&
      (isRubatoArtifactPath(resolved) || TOOL_RESULT_PATTERN.test(resolved))
    ) {
      return { allowed: true, sanitizedInput: { ...input, [pathKey]: resolved } };
    }

    // 1. Workspace boundary check
    if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
      return {
        allowed: false,
        reason: `Path traversal blocked: "${filePath}" resolves to "${resolved}" which is outside workspace "${workspaceRoot}"`,
      };
    }

    // 2. Symlink check — if file exists, resolve symlinks and re-check boundary
    try {
      const real = fs.realpathSync(resolved);
      if (!real.startsWith(realWorkspaceRoot + path.sep) && real !== realWorkspaceRoot) {
        return {
          allowed: false,
          reason: `Symlink blocked: "${filePath}" → "${real}" points outside workspace`,
        };
      }
    } catch {
      // File doesn't exist yet (write/create), boundary check above is sufficient
    }

    // 3. Sensitive path check (relative to workspace)
    const sensitive = matchSensitivePath(resolved, workspaceRoot);
    if (sensitive) {
      return {
        allowed: false,
        reason: `Sensitive path blocked: "${filePath}" contains ${sensitive.label}`,
      };
    }

    return { allowed: true, sanitizedInput: { ...input, [pathKey]: resolved } };
  }

  private resolvePath(filePath: string, workingDir: string): string {
    if (path.isAbsolute(filePath)) return path.resolve(filePath);
    return path.resolve(workingDir, filePath);
  }
}

function isRubatoArtifactPath(resolved: string): boolean {
  const rubatoHome = path.resolve(process.env.RUBATO_HOME ?? path.join(os.homedir(), ".rubato"));
  const relative = path.relative(rubatoHome, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  if (
    segments.length < 5 ||
    segments[0] !== "projects" ||
    segments[2] !== "runs"
  ) {
    return false;
  }
  if (segments[4] === "trace.jsonl" && segments.length === 5) return true;
  return segments[4] === "tasks" && segments.length >= 7;
}
