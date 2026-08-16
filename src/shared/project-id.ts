import { createHash } from "crypto";
import path from "path";

/** Stable identifier used by all project-scoped Rubato state. */
export function projectMemoryId(projectDir: string): string {
  return createHash("sha256")
    .update(path.resolve(projectDir))
    .digest("hex");
}
