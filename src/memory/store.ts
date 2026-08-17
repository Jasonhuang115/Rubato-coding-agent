import { randomUUID } from "crypto";
import { TextDecoder } from "util";
import fs from "fs";
import path from "path";
import { getRubatoHome } from "../shared/rubato-home.js";

export type MemoryNamespace = "project" | "user";

export const MEMORY_INDEX_FILE = "MEMORY.md";
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;
export const MEMORY_FILE_MAX_BYTES = 256 * 1024;
export const MEMORY_NAMESPACE_MAX_BYTES = 10 * 1024 * 1024;
export const MEMORY_USER_INJECT_MAX_BYTES = 6 * 1024;

export interface MemoryStoreOptions {
  projectId: string;
  rootDir?: string;
}

export interface MemoryView {
  kind: "file" | "directory" | "missing";
  path: string;
  content: string;
  totalLines?: number;
  sizeBytes?: number;
}

export interface MemoryMutationResult {
  message: string;
  warnings: string[];
}

export class MemoryStore {
  private readonly rubatoRoot: string;

  constructor(private readonly options: MemoryStoreOptions) {
    if (!/^[a-f0-9]{64}$/.test(options.projectId)) {
      throw new Error("MemoryStore requires a valid project ID.");
    }
    const configuredRoot = path.resolve(options.rootDir ?? getRubatoHome());
    this.rubatoRoot = fs.existsSync(configuredRoot)
      ? fs.realpathSync(configuredRoot)
      : configuredRoot;
  }

  root(namespace: MemoryNamespace): string {
    return namespace === "user"
      ? path.join(this.rubatoRoot, "user-memory")
      : path.join(this.rubatoRoot, "projects", this.options.projectId, "memory");
  }

  view(
    namespace: MemoryNamespace,
    relativePath = ".",
    startLine = 1,
    endLine?: number,
  ): MemoryView {
    assertUserMemoryPath(namespace, relativePath, true);
    const root = this.root(namespace);
    const target = resolveMemoryPath(root, relativePath, false);
    if (!fs.existsSync(target)) {
      return { kind: "missing", path: displayPath(namespace, relativePath), content: "[empty]" };
    }
    rejectSymlinkPath(root, target);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const content = directoryListing(target, root);
      return {
        kind: "directory",
        path: displayPath(namespace, relativePath),
        content: content || "[empty directory]",
        sizeBytes: namespaceSize(root),
      };
    }
    assertMarkdownPath(target);
    const content = readUtf8(target);
    const lines = content.split("\n");
    const start = Math.max(1, Math.trunc(startLine));
    const end = Math.min(lines.length, Math.max(start, Math.trunc(endLine ?? lines.length)));
    return {
      kind: "file",
      path: displayPath(namespace, relativePath),
      content: lines.slice(start - 1, end)
        .map((line, index) => `${String(start + index).padStart(6, " ")}\t${line}`)
        .join("\n"),
      totalLines: lines.length,
      sizeBytes: stat.size,
    };
  }

  create(
    namespace: MemoryNamespace,
    relativePath: string,
    fileText: string,
  ): MemoryMutationResult {
    return this.withNamespaceLock(namespace, () => {
      assertUserMemoryPath(namespace, relativePath);
      const root = this.ensureRoot(namespace);
      const target = resolveMemoryPath(root, relativePath, true);
      assertMarkdownPath(target);
      if (fs.existsSync(target)) throw new Error(`Memory file already exists: ${relativePath}`);
      validateMemoryText(fileText);
      ensureProjectedCapacity(root, 0, Buffer.byteLength(fileText));
      ensureDirectoryWithoutSymlinks(root, path.dirname(target));
      atomicWrite(target, fileText);
      return mutationResult(namespace, relativePath, fileText, "Memory file created.");
    });
  }

  replace(
    namespace: MemoryNamespace,
    relativePath: string,
    oldText: string,
    newText: string,
  ): MemoryMutationResult {
    return this.mutateFile(namespace, relativePath, (current) => {
      const occurrences = countOccurrences(current, oldText);
      if (occurrences === 0) throw new Error("old_str was not found in the memory file.");
      if (occurrences > 1) throw new Error("old_str is not unique in the memory file.");
      return current.replace(oldText, newText);
    }, "Memory file updated.");
  }

  insert(
    namespace: MemoryNamespace,
    relativePath: string,
    line: number,
    text: string,
  ): MemoryMutationResult {
    return this.mutateFile(namespace, relativePath, (current) => {
      const lines = current.split("\n");
      const position = Math.trunc(line);
      if (position < 0 || position > lines.length) {
        throw new Error(`insert_line must be between 0 and ${lines.length}.`);
      }
      lines.splice(position, 0, text);
      return lines.join("\n");
    }, "Memory file updated.");
  }

  rename(
    namespace: MemoryNamespace,
    relativePath: string,
    newRelativePath: string,
  ): MemoryMutationResult {
    return this.withNamespaceLock(namespace, () => {
      if (namespace === "user") {
        throw new Error("User memory only allows MEMORY.md and cannot be renamed.");
      }
      const root = this.ensureRoot(namespace);
      const source = resolveMemoryPath(root, relativePath, true);
      const target = resolveMemoryPath(root, newRelativePath, true);
      if (source === root) throw new Error("The memory namespace root cannot be renamed.");
      if (!fs.existsSync(source)) throw new Error(`Memory path does not exist: ${relativePath}`);
      if (fs.existsSync(target)) throw new Error(`Memory path already exists: ${newRelativePath}`);
      rejectSymlinkPath(root, source);
      if (fs.statSync(source).isFile()) assertMarkdownPath(target);
      ensureDirectoryWithoutSymlinks(root, path.dirname(target));
      fs.renameSync(source, target);
      return { message: "Memory path renamed.", warnings: [] };
    });
  }

  delete(
    namespace: MemoryNamespace,
    relativePath: string,
  ): MemoryMutationResult {
    return this.withNamespaceLock(namespace, () => {
      assertUserMemoryPath(namespace, relativePath);
      const root = this.ensureRoot(namespace);
      const target = resolveMemoryPath(root, relativePath, true);
      if (target === root) throw new Error("The memory namespace root cannot be deleted.");
      if (!fs.existsSync(target)) throw new Error(`Memory path does not exist: ${relativePath}`);
      rejectSymlinkPath(root, target);
      fs.rmSync(target, { recursive: true, force: false });
      return { message: "Memory path deleted.", warnings: [] };
    });
  }

  private mutateFile(
    namespace: MemoryNamespace,
    relativePath: string,
    transform: (current: string) => string,
    message: string,
  ): MemoryMutationResult {
    return this.withNamespaceLock(namespace, () => {
      assertUserMemoryPath(namespace, relativePath);
      const root = this.ensureRoot(namespace);
      const target = resolveMemoryPath(root, relativePath, true);
      assertMarkdownPath(target);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new Error(`Memory file does not exist: ${relativePath}`);
      }
      rejectSymlinkPath(root, target);
      const current = readUtf8(target);
      const next = transform(current);
      validateMemoryText(next);
      ensureProjectedCapacity(root, Buffer.byteLength(current), Buffer.byteLength(next));
      atomicWrite(target, next);
      return mutationResult(namespace, relativePath, next, message);
    });
  }

  private ensureRoot(namespace: MemoryNamespace): string {
    const root = this.root(namespace);
    ensureDirectoryWithoutSymlinks(this.rubatoRoot, root);
    return root;
  }

  private withNamespaceLock<T>(namespace: MemoryNamespace, action: () => T): T {
    const root = this.ensureRoot(namespace);
    const lockPath = path.join(root, ".memory.lock");
    let descriptor: number;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch {
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 60_000) {
          fs.unlinkSync(lockPath);
          descriptor = fs.openSync(lockPath, "wx", 0o600);
        } else {
          throw new Error("active lock");
        }
      } catch {
        throw new Error("Memory conflict: another window is updating this namespace.");
      }
    }
    try {
      fs.writeFileSync(descriptor, `${process.pid}\t${new Date().toISOString()}\n`, { encoding: "utf8" });
      return action();
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(lockPath);
    }
  }
}

export function readMemoryIndex(
  namespace: MemoryNamespace,
  options: MemoryStoreOptions,
): string | null {
  return readMemoryFile(namespace, options, MEMORY_INDEX_MAX_BYTES, MEMORY_INDEX_MAX_LINES);
}

export function readUserMemoryFile(options: MemoryStoreOptions): string | null {
  return readMemoryFile("user", options, MEMORY_USER_INJECT_MAX_BYTES);
}

export function migrateLegacyMemoryData(rootDir?: string): {
  removed: boolean;
  markerPath: string;
  error?: string;
} {
  const root = path.resolve(rootDir ?? getRubatoHome());
  const migrationDir = path.join(root, ".migrations");
  const markerPath = path.join(migrationDir, "memory-v2");
  if (fs.existsSync(markerPath)) return { removed: false, markerPath };
  const legacy = path.join(root, "memory");
  try {
    if (path.dirname(legacy) !== root || path.basename(legacy) !== "memory") {
      throw new Error("Refusing to clean an unexpected legacy memory path.");
    }
    if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "user-memory"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(migrationDir, { recursive: true, mode: 0o700 });
    atomicWrite(markerPath, "rubato-memory-v2\n");
    return { removed: true, markerPath };
  } catch (error) {
    return {
      removed: false,
      markerPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readMemoryFile(
  namespace: MemoryNamespace,
  options: MemoryStoreOptions,
  maxBytes: number,
  maxLines?: number,
): string | null {
  const store = new MemoryStore(options);
  const root = store.root(namespace);
  const indexPath = path.join(root, MEMORY_INDEX_FILE);
  if (!fs.existsSync(indexPath)) return null;
  try {
    rejectSymlinkPath(root, indexPath);
    const bytes = fs.readFileSync(indexPath);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const decoded = decodeUtf8Prefix(bytes, maxBytes);
    return maxLines === undefined ? decoded : decoded.split("\n").slice(0, maxLines).join("\n");
  } catch {
    return null;
  }
}

function assertUserMemoryPath(
  namespace: MemoryNamespace,
  relativePath: string,
  allowDirectory = false,
): void {
  if (namespace !== "user") return;
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (allowDirectory && (normalized === "." || normalized === "" || normalized === "/")) return;
  if (normalized === MEMORY_INDEX_FILE) return;
  throw new Error("User memory only allows MEMORY.md.");
}

function resolveMemoryPath(root: string, relativePath: string, mutating: boolean): string {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) {
    throw new Error("Invalid memory path.");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    throw new Error("Invalid encoded memory path.");
  }
  if (decoded !== relativePath || path.isAbsolute(decoded)) {
    throw new Error("Memory paths must be unencoded relative paths.");
  }
  const parts = decoded.replaceAll("\\", "/").split("/");
  if (parts.some((part) => part === "..")) throw new Error("Memory path traversal is not allowed.");
  const target = path.resolve(root, decoded || ".");
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Memory path escapes its namespace.");
  }
  if (mutating && target === root && decoded !== "." && decoded !== "") {
    throw new Error("Invalid memory path.");
  }
  return target;
}

function rejectSymlinkPath(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Memory path escapes its namespace.");
  }
  let current = root;
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
    throw new Error("Memory namespace cannot be a symbolic link.");
  }
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("Symbolic links are not allowed in memory paths.");
    }
  }
}

function ensureDirectoryWithoutSymlinks(boundary: string, directory: string): void {
  if (directory !== boundary && !directory.startsWith(`${boundary}${path.sep}`)) {
    throw new Error("Memory directory escapes RUBATO_HOME.");
  }
  fs.mkdirSync(boundary, { recursive: true, mode: 0o700 });
  let current = boundary;
  const relative = path.relative(boundary, directory);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error("Symbolic links are not allowed in memory paths.");
      }
      if (!fs.statSync(current).isDirectory()) {
        throw new Error("A memory directory path is occupied by a file.");
      }
    } else {
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
}

function assertMarkdownPath(filePath: string): void {
  if (path.extname(filePath).toLowerCase() !== ".md") {
    throw new Error("Memory files must use the .md extension.");
  }
}

function validateMemoryText(text: string): void {
  const size = Buffer.byteLength(text);
  if (size > MEMORY_FILE_MAX_BYTES) {
    throw new Error(`Memory file exceeds ${MEMORY_FILE_MAX_BYTES} bytes.`);
  }
  const issues: Array<[string, RegExp]> = [
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
    ["credential", /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i],
    ["GitHub token", /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ["API key", /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}\b/i],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
  ];
  const matches = issues.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  if (matches.length > 0) throw new Error(`Memory contains sensitive data: ${matches.join(", ")}.`);
}

function ensureProjectedCapacity(root: string, oldBytes: number, newBytes: number): void {
  const projected = namespaceSize(root) - oldBytes + newBytes;
  if (projected > MEMORY_NAMESPACE_MAX_BYTES) {
    throw new Error(`Memory namespace exceeds ${MEMORY_NAMESPACE_MAX_BYTES} bytes.`);
  }
}

function namespaceSize(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".memory.lock") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) total += fs.statSync(entryPath).size;
    }
  };
  visit(root);
  return total;
}

function directoryListing(directory: string, root: string): string {
  const baseDepth = path.relative(root, directory).split(path.sep).filter(Boolean).length;
  const lines: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .filter((item) => item.name !== ".memory.lock")
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(current, entry.name);
      const relative = path.relative(root, entryPath).split(path.sep).join("/");
      lines.push(`${entry.isDirectory() ? "dir " : "file"}  ${relative}`);
      const depth = path.relative(root, entryPath).split(path.sep).filter(Boolean).length;
      if (entry.isDirectory() && depth - baseDepth < 2) visit(entryPath);
    }
  };
  visit(directory);
  return lines.join("\n");
}

function readUtf8(filePath: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath));
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp.${randomUUID()}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function mutationResult(
  namespace: MemoryNamespace,
  relativePath: string,
  content: string,
  message: string,
): MemoryMutationResult {
  const warnings: string[] = [];
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized === MEMORY_INDEX_FILE) {
    const lines = content.split("\n").length;
    const bytes = Buffer.byteLength(content);
    if (namespace === "user") {
      if (bytes > MEMORY_USER_INJECT_MAX_BYTES) {
        warnings.push(
          "User MEMORY.md exceeds the resident portrait limit. Compact it now: keep four short sections and drop project-specific details.",
        );
      }
    } else if (lines > MEMORY_INDEX_MAX_LINES || bytes > MEMORY_INDEX_MAX_BYTES) {
      warnings.push(
        "MEMORY.md exceeds the startup index limit. Compact it now: keep one concise entry per topic and move details into topic files.",
      );
    }
  }
  return { message, warnings };
}

function decodeUtf8Prefix(bytes: Buffer, limit: number): string {
  let end = Math.min(bytes.length, limit);
  while (end > Math.max(0, limit - 4)) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end--;
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
}

function displayPath(namespace: MemoryNamespace, relativePath: string): string {
  const suffix = relativePath === "." || relativePath === "" ? "" : `/${relativePath}`;
  return `/memories/${namespace}${suffix}`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) throw new Error("old_str cannot be empty.");
  let count = 0;
  let position = 0;
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count++;
    position += needle.length;
  }
  return count;
}
