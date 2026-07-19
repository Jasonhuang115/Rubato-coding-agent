// FileSystem Snapshot — captures workspace state for rollback and diffing.
// Used by the security layer to support undo/rollback of agent operations.

import fs from "fs";
import path from "path";

export interface FsSnapshot {
  timestamp: number;
  workspaceRoot: string;
  files: FileRecord[];
}

export interface FileRecord {
  relativePath: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  /** Base64-encoded file content (only for files < 1MB). */
  content?: string;
}

const MAX_FILE_SIZE = 1_048_576; // 1MB — larger files track metadata only

export class SnapshotManager {
  private snapshots: FsSnapshot[] = [];

  /**
   * Capture the current state of the workspace.
   * Walks the directory tree and records metadata for all files.
   */
  capture(workspaceRoot: string, excludePatterns: string[] = ["node_modules", ".git", "dist", ".next", "build"]): FsSnapshot {
    const files: FileRecord[] = [];

    try {
      this.walkDir(workspaceRoot, workspaceRoot, files, excludePatterns);
    } catch {
      // Non-critical: best-effort snapshot
    }

    const snapshot: FsSnapshot = {
      timestamp: Date.now(),
      workspaceRoot,
      files,
    };

    this.snapshots.push(snapshot);
    return snapshot;
  }

  /**
   * Diff two snapshots and return changed/added/deleted files.
   */
  diff(before: FsSnapshot, after: FsSnapshot): FileDiff {
    const beforeMap = new Map(before.files.map((f) => [f.relativePath, f]));
    const afterMap = new Map(after.files.map((f) => [f.relativePath, f]));

    const changed: string[] = [];
    const added: string[] = [];
    const deleted: string[] = [];

    for (const [rp, afterFile] of afterMap) {
      const beforeFile = beforeMap.get(rp);
      if (!beforeFile) {
        added.push(rp);
      } else if (beforeFile.mtimeMs !== afterFile.mtimeMs || beforeFile.size !== afterFile.size) {
        changed.push(rp);
      }
    }

    for (const [rp] of beforeMap) {
      if (!afterMap.has(rp)) {
        deleted.push(rp);
      }
    }

    return { changed, added, deleted };
  }

  /**
   * Get the latest snapshot.
   */
  latest(): FsSnapshot | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  /**
   * Get all snapshots.
   */
  all(): FsSnapshot[] {
    return [...this.snapshots];
  }

  /**
   * Clear all snapshots.
   */
  clear(): void {
    this.snapshots = [];
  }

  // ---- Private ----

  private walkDir(
    root: string,
    dir: string,
    files: FileRecord[],
    excludes: string[],
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (excludes.includes(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".env") continue; // skip dotfiles except .env

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath);

      if (entry.isDirectory()) {
        this.walkDir(root, fullPath, files, excludes);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          const record: FileRecord = {
            relativePath,
            exists: true,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };

          // Store content for small files
          if (stat.size <= MAX_FILE_SIZE) {
            record.content = fs.readFileSync(fullPath).toString("base64");
          }

          files.push(record);
        } catch {
          // Skip inaccessible files
        }
      }
    }
  }
}

export interface FileDiff {
  changed: string[];
  added: string[];
  deleted: string[];
}
