import path from "path";

/** Resolve a tool-supplied path relative to the current agent workspace. */
export function resolveToolPath(filePath: string, workingDir: string): string {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(workingDir, filePath);
}

/** True when two filesystem paths name the same location after normalization. */
export function isSameToolPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}
