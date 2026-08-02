import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type { MemoryScope, MemoryScopePaths } from "./types.js";
import { getRubatoHome } from "../shared/rubato-home.js";

export interface ResolveMemoryScopePathsInput {
  /** Rubato's data root. Defaults to RUBATO_HOME or ~/.rubato. */
  rootDir?: string;
  scope: MemoryScope;
  projectDir?: string;
  projectId?: string;
}

export function projectMemoryId(projectDir: string): string {
  return createHash("sha256")
    .update(path.resolve(projectDir))
    .digest("hex");
}

export function resolveMemoryScopePaths(
  input: ResolveMemoryScopePathsInput,
): MemoryScopePaths {
  const rootDir = path.resolve(
    input.rootDir ?? getRubatoHome(),
  );
  const memoryDir = path.join(rootDir, "memory");

  let projectId: string | undefined;
  let scopeDir: string;
  if (input.scope === "global") {
    scopeDir = path.join(memoryDir, "global");
  } else {
    projectId = input.projectId ??
      (input.projectDir ? projectMemoryId(input.projectDir) : undefined);
    if (!projectId || !/^[a-f0-9]{64}$/.test(projectId)) {
      throw new Error(
        "Project memory scope requires a canonical SHA-256 projectId or a projectDir.",
      );
    }
    scopeDir = path.join(memoryDir, "projects", projectId);
  }

  return {
    rootDir,
    memoryDir,
    scopeDir,
    currentPath: path.join(scopeDir, "CURRENT"),
    releasesDir: path.join(scopeDir, "releases"),
    stagingDir: path.join(scopeDir, ".staging"),
    lockPath: path.join(scopeDir, ".publish.lock"),
    purgeLedgerPath: path.join(memoryDir, "purge-ledger.jsonl"),
    scope: input.scope,
    projectId,
  };
}

export function ensureMemoryScopeDirectories(paths: MemoryScopePaths): void {
  fs.mkdirSync(paths.releasesDir, { recursive: true });
  fs.mkdirSync(paths.stagingDir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.purgeLedgerPath), { recursive: true });
}
