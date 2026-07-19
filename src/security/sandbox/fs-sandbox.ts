// FsSandbox — validates file operations stay within workspace boundaries
// Handles path traversal, symlink resolution, and sensitive path blocking.

import * as path from "path";
import * as fs from "fs";
import type { ISandbox, SandboxResult } from "./sandbox.js";

/** Paths that should never be accessed, even within workspace. */
const SENSITIVE_PATHS = [
  "/etc/passwd", "/etc/shadow", "/etc/hosts",
  "/proc", "/sys", "/dev",
  ".ssh/id_rsa", ".ssh/authorized_keys",
  ".git/config", ".env", ".env.local",
];

const SUBAGENT_ARTIFACT_PATTERN = /^\/tmp\/rubato-subagent-[A-Za-z0-9_-]+(?:\.transcript)?\.md$/;
const TOOL_RESULT_PATTERN = /^\/tmp\/rubato-tool-results\/[A-Za-z0-9_-]+\.txt$/;

export class FsSandbox implements ISandbox {
  readonly name = "fs-sandbox";

  validate(toolName: string, input: Record<string, unknown>, workingDir: string): SandboxResult {
    const filePath = input.file_path as string | undefined;
    if (!filePath) return { allowed: true };

    const resolved = this.resolvePath(filePath, workingDir);
    const workspaceRoot = path.resolve(workingDir);

    // 0. Allow reads of Rubato-owned temporary artifacts, but no arbitrary /tmp access.
    if (
      toolName === "Read" &&
      (SUBAGENT_ARTIFACT_PATTERN.test(resolved) || TOOL_RESULT_PATTERN.test(resolved))
    ) {
      return { allowed: true, sanitizedInput: { ...input, file_path: resolved } };
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
      if (!real.startsWith(workspaceRoot + path.sep) && real !== workspaceRoot) {
        return {
          allowed: false,
          reason: `Symlink blocked: "${filePath}" → "${real}" points outside workspace`,
        };
      }
    } catch {
      // File doesn't exist yet (write/create), boundary check above is sufficient
    }

    // 3. Sensitive path check (relative to workspace)
    const relativePath = path.relative(workspaceRoot, resolved);
    for (const sensitive of SENSITIVE_PATHS) {
      if (relativePath.includes(sensitive) || resolved.includes(sensitive)) {
        return {
          allowed: false,
          reason: `Sensitive path blocked: "${filePath}" matches sensitive pattern "${sensitive}"`,
        };
      }
    }

    return { allowed: true, sanitizedInput: { ...input, file_path: resolved } };
  }

  private resolvePath(filePath: string, workingDir: string): string {
    if (path.isAbsolute(filePath)) return path.resolve(filePath);
    return path.resolve(workingDir, filePath);
  }
}
