// Persist oversized tool results next to the session and keep a short preview
// in the conversation. Compression reuses the same preview copy so the model
// can Read the file later.

import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { getRubatoHome } from "../shared/rubato-home.js";
import type { Message } from "../shared/core-types.js";

export const OFFLOAD_THRESHOLD = 30_000;
const PREVIEW_LEN = 800;

export function toolResultOffloadDir(projectId: string | undefined, sessionId: string): string {
  const project = projectId && /^[a-f0-9]{64}$/.test(projectId) ? projectId : "unscoped";
  return path.join(getRubatoHome(), "projects", project, "sessions", sessionId, "tool-results");
}

export function defaultTmpOffloadDir(): string {
  return path.join(os.tmpdir(), "rubato-tool-results");
}

export function extractOffloadPath(content: string): string | undefined {
  const match = content.match(
    /(?:offloaded to|remains at|full output at) (\S+?)(?:[\]\s]|$)/,
  );
  const raw = match?.[1];
  if (!raw) return undefined;
  return raw.replace(/[.,;:]+$/, "");
}

export function isOffloadedToolResult(content: string): boolean {
  return extractOffloadPath(content) !== undefined;
}

export function formatOffloadPreview(
  content: string,
  filePath: string,
  options?: { alreadyOnDisk?: boolean },
): string {
  const preview = content.slice(0, PREVIEW_LEN);
  const already = Boolean(options?.alreadyOnDisk);
  return [
    already
      ? `[Large offloaded result remains at ${filePath}; no duplicate copy was created.]`
      : `[Full output (${(content.length / 1024).toFixed(1)}KB) offloaded to ${filePath}]`,
    ``,
    `Preview:`,
    preview,
    content.length > PREVIEW_LEN
      ? already
        ? `\n... [use Grep or Read with offset/limit on ${filePath}; do not read the whole file again]`
        : `\n... [use Read with offset/limit or Grep on ${filePath} to inspect the full ${(content.length / 1024).toFixed(0)}KB output]`
      : ``,
  ].join("\n");
}

export function offloadIfLarge(
  content: string,
  toolName: string,
  toolInput?: Record<string, unknown>,
  dir?: string,
): string {
  if (content.length <= OFFLOAD_THRESHOLD) return content;

  const targetDir = dir && dir.length > 0 ? dir : defaultTmpOffloadDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const requestedPath = toolName === "Read" && typeof toolInput?.file_path === "string"
    ? path.resolve(toolInput.file_path)
    : undefined;
  const readingExistingOffload = requestedPath !== undefined &&
    path.dirname(requestedPath) === path.resolve(targetDir);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const filePath = readingExistingOffload
    ? requestedPath
    : path.join(targetDir, `${toolName}-${hash}.txt`);
  if (!readingExistingOffload && !fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, "utf-8");
  }

  return formatOffloadPreview(content, filePath, { alreadyOnDisk: readingExistingOffload });
}

/** Offload a tool result regardless of the ingest threshold (used during compaction). */
export function offloadToolResultContent(
  content: string,
  toolName: string,
  dir: string,
): string {
  const existing = extractOffloadPath(content);
  if (existing) return content;
  fs.mkdirSync(dir, { recursive: true });
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const filePath = path.join(dir, `${toolName}-${hash}.txt`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, "utf-8");
  }
  return formatOffloadPreview(content, filePath);
}

export function listOffloadPaths(messages: Message[]): string[] {
  const paths = new Set<string>();
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      const found = extractOffloadPath(msg.content);
      if (found) paths.add(found);
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        const found = extractOffloadPath(block.content ?? "");
        if (found) paths.add(found);
      } else if (block.type === "text") {
        const found = extractOffloadPath(block.text);
        if (found) paths.add(found);
      }
    }
  }
  return [...paths];
}

export function writeCompactionHandoff(options: {
  dir: string;
  sessionId: string;
  summary: string;
  offloadIndex: string[];
}): string {
  fs.mkdirSync(options.dir, { recursive: true });
  const filePath = path.join(options.dir, "handoff.md");
  const index = options.offloadIndex.length > 0
    ? options.offloadIndex.map((p) => `- ${p}`).join("\n")
    : "- (none)";
  const body = [
    `Previous session: ${options.sessionId}`,
    "",
    "## Summary",
    options.summary.trim() || "(no summary)",
    "",
    "## Offloaded tool results",
    "Read these paths if you need the original tool output.",
    index,
    "",
  ].join("\n");
  fs.writeFileSync(filePath, body, "utf-8");
  return filePath;
}
