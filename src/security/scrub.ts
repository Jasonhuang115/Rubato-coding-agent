import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { redactText, redactValue } from "../agent/subagents/redaction.js";

export interface ScrubOptions {
  /** Defaults to ~/.rubato (or RUBATO_HOME). */
  rubatoHome?: string;
  /** A file or directory inside rubatoHome. Defaults to all persisted data. */
  target?: string;
  /** Inspect without changing files. */
  dryRun?: boolean;
}

export interface ScrubReport {
  root: string;
  target: string;
  dryRun: boolean;
  filesScanned: number;
  filesChanged: number;
  bytesScanned: number;
  skippedSymlinks: number;
  errors: Array<{ path: string; message: string }>;
}

const TEXT_EXTENSIONS = new Set([".jsonl", ".json", ".md", ".txt"]);

/**
 * Redact credentials from existing Rubato traces, sessions and task artifacts.
 *
 * The target is strictly constrained to Rubato-owned persistence directories.
 * Symlinks are never followed and writes use a same-directory atomic rename so
 * a crash cannot leave a partially scrubbed file.
 */
export function scrubPersistedData(options: ScrubOptions = {}): ScrubReport {
  const configuredRoot = path.resolve(
    options.rubatoHome ??
      process.env.RUBATO_HOME ??
      path.join(os.homedir(), ".rubato"),
  );
  const target = path.resolve(options.target ?? configuredRoot);
  const report: ScrubReport = {
    root: configuredRoot,
    target,
    dryRun: options.dryRun ?? false,
    filesScanned: 0,
    filesChanged: 0,
    bytesScanned: 0,
    skippedSymlinks: 0,
    errors: [],
  };

  if (!fs.existsSync(configuredRoot)) return report;
  const realRoot = fs.realpathSync(configuredRoot);
  if (!isWithin(configuredRoot, target)) {
    throw new Error("Scrub target must stay inside the Rubato data directory.");
  }
  if (!fs.existsSync(target)) {
    throw new Error(`Scrub target does not exist: ${target}`);
  }
  const targetStat = fs.lstatSync(target);
  if (targetStat.isSymbolicLink()) {
    throw new Error("Scrub target must not be a symbolic link.");
  }
  const realTarget = fs.realpathSync(target);
  if (!isWithin(realRoot, realTarget)) {
    throw new Error("Scrub target resolves outside the Rubato data directory.");
  }

  const files = collectEligibleFiles(realTarget, realRoot, report);
  if (targetStat.isFile() && files.length === 0) {
    throw new Error("Scrub target is not a Rubato trace, session, or task artifact.");
  }

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      const original = fs.readFileSync(filePath, "utf8");
      const scrubbed = scrubFileContent(filePath, original);
      report.filesScanned += 1;
      report.bytesScanned += stat.size;
      if (scrubbed === original) continue;
      report.filesChanged += 1;
      if (!report.dryRun) writeAtomic(filePath, scrubbed, stat.mode);
    } catch (error) {
      report.errors.push({
        path: filePath,
        message: error instanceof Error ? redactText(error.message) : "Unknown scrub error",
      });
    }
  }
  return report;
}

function collectEligibleFiles(
  target: string,
  realRoot: string,
  report: ScrubReport,
): string[] {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    report.skippedSymlinks += 1;
    return [];
  }
  if (stat.isFile()) return isEligibleFile(target, realRoot) ? [target] : [];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  const entries = fs.readdirSync(target, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      report.skippedSymlinks += 1;
      continue;
    }
    if (entry.isDirectory()) {
      const realDirectory = fs.realpathSync(entryPath);
      if (isWithin(realRoot, realDirectory)) {
        files.push(...collectEligibleFiles(realDirectory, realRoot, report));
      }
      continue;
    }
    if (entry.isFile() && isEligibleFile(entryPath, realRoot)) files.push(entryPath);
  }
  return files;
}

function isEligibleFile(filePath: string, realRoot: string): boolean {
  if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  const relative = path.relative(realRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);

  // Legacy ~/.rubato/sessions/*.jsonl
  if (segments[0] === "sessions") {
    return segments.length === 2 && path.extname(filePath).toLowerCase() === ".jsonl";
  }
  if (segments[0] !== "projects" || segments.length < 3) return false;

  // Project session index and JSONL transcripts.
  if (segments[2] === "sessions.json") return segments.length === 3;
  if (segments[2] === "sessions") {
    return segments.length === 4 && path.extname(filePath).toLowerCase() === ".jsonl";
  }

  // Root trace, task JSON/Markdown/transcript and blob text.
  return segments[2] === "runs" && segments.length >= 5;
}

function scrubFileContent(filePath: string, content: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jsonl") {
    const trailingNewline = content.endsWith("\n");
    const lines = content.split("\n");
    if (trailingNewline) lines.pop();
    const scrubbed = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(redactValue(JSON.parse(line)));
      } catch {
        return redactText(line);
      }
    }).join("\n");
    return trailingNewline ? `${scrubbed}\n` : scrubbed;
  }
  if (extension === ".json") {
    try {
      return `${JSON.stringify(redactValue(JSON.parse(content)), null, 2)}\n`;
    } catch {
      return redactText(content);
    }
  }
  return redactText(content);
}

function writeAtomic(filePath: string, content: string, mode: number): void {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.rubato-scrub-${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
