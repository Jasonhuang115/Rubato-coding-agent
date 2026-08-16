// FsSandbox — validates file operations stay within workspace boundaries
// Handles path traversal, symlink resolution, and sensitive path blocking.

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { ISandbox, SandboxResult } from "./sandbox.js";
import { matchSensitivePath } from "./sensitive-paths.js";
import { projectMemoryId } from "../../shared/project-id.js";
import { getRubatoHome } from "../../shared/rubato-home.js";

const TOOL_RESULT_PATTERN = /^[A-Za-z0-9_-]+\.txt$/;
const NATIVE_READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

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

    // 0. Allow reads of current-project Rubato artifacts, but no arbitrary
    // RUBATO_HOME or /tmp access. BashRead/BashWrite intentionally do not
    // qualify: only native Read/Grep/Glob may use the curated read surface.
    if (NATIVE_READ_TOOLS.has(toolName)) {
      const curatedPath =
        resolveRubatoArtifactRead(resolved, workingDir) ??
        resolveToolResultRead(resolved);
      if (curatedPath) {
        const sensitive = matchSensitivePath(curatedPath);
        if (sensitive) {
          return {
            allowed: false,
            reason: `Sensitive path blocked: "${filePath}" contains ${sensitive.label}`,
          };
        }
        return {
          allowed: true,
          sanitizedInput: { ...input, [pathKey]: curatedPath },
        };
      }
    }

    const rubatoHome = getRubatoHome();
    if (isPathWithin(resolved, rubatoHome)) {
      if (NATIVE_READ_TOOLS.has(toolName)) {
        const allowedPath = resolveAllowedRubatoRead(resolved, workingDir, rubatoHome);
        if (allowedPath) {
          const sensitive = matchSensitivePath(allowedPath);
          if (sensitive) {
            return {
              allowed: false,
              reason: `Sensitive path blocked: "${filePath}" contains ${sensitive.label}`,
            };
          }
          return {
            allowed: true,
            sanitizedInput: { ...input, [pathKey]: allowedPath },
          };
        }
      }
      return {
        allowed: false,
        reason:
          `Rubato private path blocked: "${filePath}". ` +
          "Only the current project's curated session/run artifacts are readable; " +
          "durable memory is accessible only through the Memory tool.",
      };
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

function resolveRubatoArtifactRead(
  resolved: string,
  workingDir: string,
): string | undefined {
  const rubatoHome = getRubatoHome();
  const relative = path.relative(rubatoHome, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const segments = relative.split(path.sep);
  if (
    segments.length < 5 ||
    segments[0] !== "projects" ||
    segments[1] !== projectId(workingDir) ||
    segments[2] !== "runs"
  ) {
    return undefined;
  }
  const isTrace = segments[4] === "trace.jsonl" && segments.length === 5;
  const isTaskArtifact = segments[4] === "tasks" && segments.length >= 7;
  if (!isTrace && !isTaskArtifact) return undefined;
  const runsDir = path.join(
    rubatoHome,
    "projects",
    projectId(workingDir),
    "runs",
  );
  return safeRealPathWithin(resolved, runsDir);
}

function resolveToolResultRead(resolved: string): string | undefined {
  const candidates = new Set([
    path.resolve("/tmp/rubato-tool-results"),
    path.resolve(os.tmpdir(), "rubato-tool-results"),
  ]);
  for (const toolResultsDir of candidates) {
    const relative = path.relative(toolResultsDir, resolved);
    if (
      !relative.includes(path.sep) &&
      !path.isAbsolute(relative) &&
      TOOL_RESULT_PATTERN.test(relative)
    ) {
      return safeRealPathWithin(resolved, toolResultsDir);
    }
  }
  return undefined;
}

function resolveAllowedRubatoRead(
  resolved: string,
  workingDir: string,
  rubatoHome: string,
): string | undefined {
  const projectIds = [projectId(workingDir)];

  for (const id of new Set(projectIds)) {
    const projectBase = path.join(rubatoHome, "projects", id);
    const sessionsDir = path.join(projectBase, "sessions");
    const sessionPath = resolveSessionRead(resolved, sessionsDir);
    if (sessionPath) return sessionPath;
    const catalogPath = path.join(projectBase, "session-catalog.tsv");
    if (resolved === catalogPath) {
      const verifiedCatalog = safeRealPathWithin(catalogPath, projectBase);
      if (verifiedCatalog) return verifiedCatalog;
    }
  }

  return undefined;
}

function resolveSessionRead(resolved: string, sessionsDir: string): string | undefined {
  if (resolved === sessionsDir) {
    return safeRealPathWithin(resolved, sessionsDir);
  }
  const relative = path.relative(sessionsDir, resolved);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep) ||
    !relative.endsWith(".jsonl")
  ) {
    return undefined;
  }
  return safeRealPathWithin(resolved, sessionsDir);
}

function safeRealPathWithin(candidate: string, boundary: string): string | undefined {
  try {
    const realCandidate = fs.realpathSync(candidate);
    const realBoundary = fs.realpathSync(boundary);
    return isPathWithin(realCandidate, realBoundary) ? realCandidate : undefined;
  } catch {
    // Read-only operations against missing paths cannot expose data. Preserve
    // the lexical path so the file tool can report its ordinary not-found error.
    return isPathWithin(candidate, boundary) ? candidate : undefined;
  }
}

function isPathWithin(candidate: string, boundary: string): boolean {
  return candidate === boundary || candidate.startsWith(boundary + path.sep);
}

function projectId(workingDir: string): string {
  return projectMemoryId(workingDir);
}
