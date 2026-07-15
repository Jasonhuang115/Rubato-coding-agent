// ReadGuard — tracks which files have been read during the session
// Enforces "read before write" policy for Write and Edit tools

import { createHash } from "crypto";
import type { ReadGuardState, ReadGuardSnapshot } from "../core-types.js";

export class ReadGuard implements ReadGuardState {
  private files: Map<string, { timestamp: number; hash: string }> = new Map();

  hasRead(filePath: string): boolean {
    return this.files.has(filePath);
  }

  markAsRead(filePath: string, content: string): void {
    const hash = createHash("sha256").update(content).digest("hex").substring(0, 16);
    this.files.set(filePath, {
      timestamp: Date.now(),
      hash,
    });
  }

  serialize(): ReadGuardSnapshot {
    const files: Record<string, { timestamp: number; hash: string }> = {};
    for (const [path, info] of this.files) {
      files[path] = info;
    }
    return { files };
  }

  getFileCount(): number {
    return this.files.size;
  }

  getFiles(): string[] {
    return Array.from(this.files.keys());
  }
}
