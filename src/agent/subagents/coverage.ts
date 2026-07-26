import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type {
  CompleteTaskCoverageDeclaration,
  CoverageFileEntry,
  CoverageManifest,
  SubagentCoverageTracker,
} from "../../shared/core-types.js";

interface MutableCoverageFile extends CoverageFileEntry {
  inspected_ranges: Array<{ start: number; end: number }>;
}

interface DiscoveryRun {
  root: string;
  broad: boolean;
  includeHidden: boolean;
  truncated: boolean;
  failed: boolean;
}

const EXHAUSTIVE_TASK_PATTERNS = [
  /\bevery\s+(?:line|source\s+file|code\s+file)\b/i,
  /\ball\s+(?:source|code)\s+files?\b/i,
  /\bexhaustive(?:ly)?\b/i,
  /\bcomplete(?:ly)?\s+(?:inspect|explore|review|read|analy[sz]e)\b/i,
  /\b100%\s+(?:file|line|source|code)?\s*coverage\b/i,
  /每一行/,
  /逐行/,
  /所有(?:源代码|代码文件|源码文件)/,
  /全部(?:源代码|代码文件|源码文件)/,
  /完整(?:详细)?(?:地)?(?:探索|审查|检查|阅读|分析)/,
];

const EXHAUSTIVE_CLAIM_PATTERNS = [
  /\bevery\s+(?:line|source\s+file|code\s+file)\s+(?:was|has been|is)\s+(?:read|inspected|reviewed|covered)\b/i,
  /\ball\s+(?:source|code)\s+files?\s+(?:were|have been|are)\s+(?:read|inspected|reviewed|covered)\b/i,
  /\b(?:complete|full|100%)\s+(?:file|line|source|code)?\s*coverage\b/i,
  /(?:已经|已)(?:逐行|完整)(?:阅读|检查|审查|覆盖)/,
  /(?:所有|全部)(?:源代码|代码文件|源码文件)(?:均|都)?(?:已经|已)?(?:阅读|检查|审查|覆盖)/,
];

export function taskRequiresExhaustiveCoverage(prompt: string): boolean {
  return EXHAUSTIVE_TASK_PATTERNS.some((pattern) => pattern.test(prompt));
}

export function makesExhaustiveClaim(text: string): boolean {
  return EXHAUSTIVE_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

export function coverageSummary(manifest: CoverageManifest) {
  const { files: _files, notes: _notes, ...summary } = manifest;
  return summary;
}

export function emptyCoverageManifest(required = false): CoverageManifest {
  return {
    version: 1,
    required,
    scope_roots: [],
    discovery_complete: false,
    complete: false,
    gate_satisfied: !required,
    discovered: 0,
    inspected: 0,
    excluded: 0,
    failed: 0,
    line_count: 0,
    files: [],
    notes: required
      ? ["No observable file-discovery or file-read activity was recorded."]
      : ["Coverage was not required for this task."],
  };
}

/**
 * Builds a coverage manifest exclusively from observable tool activity. Model
 * declarations may narrow the intended roots and justify exclusions, but may
 * not invent inspected files or hashes.
 */
export class ObservableCoverageTracker implements SubagentCoverageTracker {
  readonly required: boolean;

  private readonly files = new Map<string, MutableCoverageFile>();
  private readonly discoveryRuns: DiscoveryRun[] = [];
  private readonly notes: string[] = [];
  private declaration?: CompleteTaskCoverageDeclaration;

  constructor(
    private readonly workingDir: string,
    prompt: string,
    forceRequired = false,
  ) {
    this.required = forceRequired || taskRequiresExhaustiveCoverage(prompt);
  }

  recordToolResult(
    toolName: string,
    input: Record<string, unknown>,
    output: string,
    isError: boolean,
  ): void {
    if (toolName === "Read") {
      this.recordRead(input, output, isError);
      return;
    }
    if (toolName === "Glob") {
      this.recordGlob(input, output, isError);
      return;
    }
    if (toolName === "Grep") {
      this.recordGrep(input, output, isError);
    }
  }

  applyDeclaration(declaration?: CompleteTaskCoverageDeclaration): string[] {
    const exclusions = (declaration?.exclusions ?? []).map((exclusion) => ({
      ...exclusion,
      target: this.resolve(exclusion.path),
    }));
    const unmatched = exclusions
      .filter((exclusion) => !this.files.has(exclusion.target))
      .map((exclusion) => exclusion.path);
    if (unmatched.length > 0) return unmatched;

    // A retry may replace an earlier declaration. Rebuild exclusion state from
    // observable reads first so a rejected attempt cannot poison later gates.
    for (const entry of this.files.values()) {
      if (entry.status !== "excluded") continue;
      const fullyRead = typeof entry.line_count === "number" &&
        rangesCover(entry.inspected_ranges, entry.line_count);
      entry.status = fullyRead ? "inspected" : "discovered";
      entry.reason = fullyRead ? undefined : "Discovered but not fully inspected.";
    }

    this.declaration = declaration;
    for (const exclusion of exclusions) {
      const entry = this.files.get(exclusion.target);
      if (!entry) continue;
      entry.status = "excluded";
      entry.reason = exclusion.reason.trim();
    }
    return [];
  }

  snapshot(): CoverageManifest {
    const scopeRoots = this.scopeRoots();
    const scopedFiles = [...this.files.values()]
      .filter((entry) => scopeRoots.length === 0 ||
        scopeRoots.some((root) => entry.path === root || isInside(entry.path, root)))
      .sort((left, right) => left.path.localeCompare(right.path));
    const inspected = scopedFiles.filter((entry) => entry.status === "inspected").length;
    const excluded = scopedFiles.filter((entry) => entry.status === "excluded").length;
    const failed = scopedFiles.filter((entry) => entry.status === "failed").length;
    const unresolved = scopedFiles.filter((entry) => entry.status === "discovered").length;
    const discoveryComplete = scopeRoots.length > 0 &&
      scopeRoots.every((scopeRoot) => this.discoveryRuns.some((run) =>
        run.broad && !run.truncated && !run.failed &&
        run.includeHidden &&
        (run.root === scopeRoot || isInside(scopeRoot, run.root)),
      ));
    const complete = discoveryComplete && failed === 0 && unresolved === 0;
    const required = this.required || this.declaration?.exhaustive === true;
    const notes = [...this.notes];
    if (!discoveryComplete) {
      notes.push(
        "Discovery is not closed: every declared scope root needs a successful, non-truncated broad Glob with include_hidden=true.",
      );
    }
    if (unresolved > 0) notes.push(`${unresolved} discovered file(s) were not fully inspected or excluded.`);
    if (failed > 0) notes.push(`${failed} file(s) could not be inspected.`);

    return {
      version: 1,
      required,
      scope_roots: scopeRoots,
      discovery_complete: discoveryComplete,
      complete,
      gate_satisfied: !required || complete,
      discovered: scopedFiles.length,
      inspected,
      excluded,
      failed,
      line_count: scopedFiles
        .filter((entry) => entry.status === "inspected")
        .reduce((total, entry) => total + (entry.line_count ?? 0), 0),
      files: scopedFiles.map((entry) => ({
        ...entry,
        inspected_ranges: entry.inspected_ranges.length > 0
          ? entry.inspected_ranges.map((range) => ({ ...range }))
          : undefined,
      })),
      notes: unique(notes),
    };
  }

  private recordRead(
    input: Record<string, unknown>,
    output: string,
    isError: boolean,
  ): void {
    if (typeof input.file_path !== "string") return;
    const filePath = this.resolve(input.file_path);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      this.setFailed(filePath, compactFailure(output, "Read failed: file is unavailable."));
      return;
    }
    if (!stat.isFile()) return;

    const metadata = inspectFile(filePath);
    const entry = this.ensureFile(filePath);
    entry.line_count = metadata.lineCount;
    entry.content_hash = metadata.contentHash;
    if (isError) {
      this.setFailed(filePath, compactFailure(output, "Read failed."));
      return;
    }

    const offset = positiveInteger(input.offset, 1);
    const limit = positiveInteger(input.limit, 2_000);
    const end = Math.min(metadata.lineCount, offset + limit - 1);
    if (end >= offset) entry.inspected_ranges.push({ start: offset, end });
    entry.inspected_ranges = mergeRanges(entry.inspected_ranges);
    if (rangesCover(entry.inspected_ranges, metadata.lineCount)) {
      entry.status = "inspected";
      entry.reason = undefined;
    } else if (entry.status !== "excluded") {
      entry.status = "discovered";
      entry.reason = "Only part of the file was observed by Read.";
    }
  }

  private recordGlob(
    input: Record<string, unknown>,
    output: string,
    isError: boolean,
  ): void {
    const searchRoot = this.resolve(typeof input.path === "string" ? input.path : ".");
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const truncated = /\(limited to \d+\)/i.test(output);
    const broadRoot = broadGlobRoot(searchRoot, pattern);
    const broad = broadRoot !== undefined;
    const includeHidden = input.include_hidden === true;
    const incomplete = /^Glob incomplete:/m.test(output);
    this.discoveryRuns.push({
      root: broadRoot ?? searchRoot,
      broad,
      includeHidden,
      truncated,
      failed: isError || incomplete,
    });
    if (isError || incomplete) {
      this.notes.push(`Glob failed for ${searchRoot} (${pattern || "unknown pattern"}).`);
      if (isError) return;
    }
    for (const line of output.split("\n")) {
      if (line.startsWith("Glob policy exclusion:") || line.startsWith("Glob incomplete:")) {
        this.notes.push(line);
      }
    }

    for (const line of output.split("\n")) {
      const match = line.match(/^\s*((?:\d+(?:\.\d+)?[BKMGTP])|-)\s{2,}(.+?)\s*$/i);
      if (!match || match[1] === "-") continue;
      const filePath = path.resolve(searchRoot, match[2]);
      try {
        if (fs.statSync(filePath).isFile()) this.ensureFile(filePath);
      } catch {
        this.setFailed(filePath, "File was discovered by Glob but disappeared before inspection.");
      }
    }
  }

  private recordGrep(
    input: Record<string, unknown>,
    output: string,
    isError: boolean,
  ): void {
    if (isError) return;
    const searchRoot = this.resolve(typeof input.path === "string" ? input.path : ".");
    for (const line of output.split("\n")) {
      const match = line.match(/^(.+?):\d+:/);
      if (!match) continue;
      const candidate = path.isAbsolute(match[1])
        ? path.resolve(match[1])
        : path.resolve(searchRoot, match[1]);
      try {
        if (fs.statSync(candidate).isFile()) this.ensureFile(candidate);
      } catch {
        // Grep output can contain display-only paths; only observable files
        // that still exist participate in coverage.
      }
    }
  }

  private scopeRoots(): string[] {
    const declared = this.declaration?.scope_roots
      ?.filter((value) => value.trim().length > 0)
      .map((value) => this.resolve(value));
    if (declared && declared.length > 0) return unique(declared);
    const inferred = this.discoveryRuns
      .filter((run) => run.broad && !run.failed)
      .map((run) => run.root);
    if (inferred.length > 0) return unique(inferred);
    return [path.resolve(this.workingDir)];
  }

  private ensureFile(filePath: string): MutableCoverageFile {
    const normalized = path.resolve(filePath);
    let entry = this.files.get(normalized);
    if (!entry) {
      entry = {
        path: normalized,
        status: "discovered",
        inspected_ranges: [],
      };
      this.files.set(normalized, entry);
    }
    return entry;
  }

  private setFailed(filePath: string, reason: string): void {
    const entry = this.ensureFile(filePath);
    if (entry.status === "inspected" || entry.status === "excluded") return;
    entry.status = "failed";
    entry.reason = reason;
  }

  private resolve(value: string): string {
    return path.resolve(this.workingDir, value.replace(/\\ /g, " "));
  }
}

function inspectFile(filePath: string): { lineCount: number; contentHash: string } {
  const content = fs.readFileSync(filePath);
  return {
    lineCount: content.toString("utf8").split("\n").length,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

function broadGlobRoot(searchRoot: string, pattern: string): string | undefined {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized === "**/*" || normalized === "**/*.*" ||
      normalized === "**" || normalized === "*") {
    return searchRoot;
  }

  for (const suffix of ["/**/*.*", "/**/*", "/**"] as const) {
    if (!normalized.endsWith(suffix)) continue;
    const prefix = normalized.slice(0, -suffix.length).replace(/\/+$/, "");
    // Only a literal directory prefix can safely narrow the effective root.
    if (prefix && !/[*?[\]{}!]/.test(prefix)) {
      return path.resolve(searchRoot, prefix);
    }
  }
  return undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function rangesCover(
  ranges: Array<{ start: number; end: number }>,
  lineCount: number,
): boolean {
  return lineCount === 0 || (ranges.length === 1 && ranges[0].start <= 1 && ranges[0].end >= lineCount);
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function compactFailure(output: string, fallback: string): string {
  const normalized = output.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 300) : fallback;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
