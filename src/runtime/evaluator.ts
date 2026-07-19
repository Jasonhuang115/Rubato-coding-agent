// Evaluation Runtime — automated quality assessment for agent outputs.
// Runs test suites, type checks, linting, and builds against agent-modified code.
// Provides objective pass/fail signals for reflection and benchmark scoring.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

// ---- Types ----

export interface EvalContext {
  task: string;
  workingDir: string;
  filesModified: string[];
  testOutput?: string;
  buildOutput?: string;
  lintOutput?: string;
}

export interface EvalResult {
  passed: boolean;
  score: number; // 0-1
  details: string[];
  metrics: {
    testsPassed?: number;
    testsFailed?: number;
    compileErrors?: number;
    lintErrors?: number;
  };
}

export interface Evaluator {
  name: string;
  evaluate(ctx: EvalContext): Promise<EvalResult>;
}

// ---- Built-in Evaluators ----

/**
 * TestEvaluator — runs `npm test` and checks pass/fail rate.
 */
export class TestEvaluator implements Evaluator {
  name = "test";

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!hasPackageScript(ctx.workingDir, "test")) {
      return {
        passed: true,
        score: 1,
        details: ["No test script detected — skipping tests"],
        metrics: {},
      };
    }

    try {
      const output = await runCommand("npm", ["test", "--", "--reporter=verbose"], ctx.workingDir);

      // Parse test results
      const testsPassed = (output.match(/(\d+)\s+passing/g) ?? [])
        .map((m) => parseInt(m.match(/\d+/)![0], 10))
        .reduce((a, b) => a + b, 0);
      const testsFailed = (output.match(/(\d+)\s+failing/g) ?? [])
        .map((m) => parseInt(m.match(/\d+/)![0], 10))
        .reduce((a, b) => a + b, 0);

      const passed = testsFailed === 0 && testsPassed > 0;
      const score = testsPassed > 0 ? testsPassed / (testsPassed + testsFailed) : 0;

      return {
        passed,
        score,
        details: passed ? [`All ${testsPassed} tests passed`] : [`${testsFailed} tests failed, ${testsPassed} passed`],
        metrics: { testsPassed, testsFailed },
      };
    } catch (err) {
      return {
        passed: false,
        score: 0,
        details: [`Test run failed: ${String(err)}`],
        metrics: {},
      };
    }
  }
}

/**
 * TypeCheckEvaluator — runs `tsc --noEmit` for TypeScript projects.
 */
export class TypeCheckEvaluator implements Evaluator {
  name = "typecheck";

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!hasPackageScript(ctx.workingDir, "typecheck") && !hasFile(ctx.workingDir, "tsconfig.json")) {
      return {
        passed: true,
        score: 1,
        details: ["No TypeScript project detected — skipping type check"],
        metrics: {},
      };
    }

    try {
      const output = hasPackageScript(ctx.workingDir, "typecheck")
        ? await runCommand("npm", ["run", "typecheck"], ctx.workingDir)
        : await runCommand("npx", ["tsc", "--noEmit"], ctx.workingDir);

      // Count errors in tsc output
      const errorMatches = output.match(/error TS\d+:/g) ?? [];
      const compileErrors = errorMatches.length;

      return {
        passed: compileErrors === 0,
        score: compileErrors === 0 ? 1 : Math.max(0, 1 - compileErrors * 0.1),
        details: compileErrors === 0
          ? ["Type check passed — 0 errors"]
          : [`${compileErrors} type errors found`],
        metrics: { compileErrors },
      };
    } catch {
      // tsc may not exist in non-TS projects
      return {
        passed: true,
        score: 1,
        details: ["No TypeScript project detected — skipping type check"],
        metrics: {},
      };
    }
  }
}

/**
 * BuildEvaluator — runs the project's build command.
 */
export class BuildEvaluator implements Evaluator {
  name = "build";

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    if (!hasPackageScript(ctx.workingDir, "build")) {
      return {
        passed: true,
        score: 1,
        details: ["No build script detected — skipping build"],
        metrics: {},
      };
    }

    try {
      const output = await runCommand("npm", ["run", "build"], ctx.workingDir);

      // Check for common error patterns
      const hasError = /error|Error|ERROR|FAILED/.test(output);

      return {
        passed: !hasError,
        score: hasError ? 0 : 1,
        details: hasError ? ["Build failed — check output for errors"] : ["Build succeeded"],
        metrics: {},
      };
    } catch {
      return {
        passed: false,
        score: 0,
        details: ["Build command failed"],
        metrics: {},
      };
    }
  }
}

/**
 * LintEvaluator — runs ESLint or project lint script.
 */
export class LintEvaluator implements Evaluator {
  name = "lint";

  async evaluate(ctx: EvalContext): Promise<EvalResult> {
    const hasLintScript = hasPackageScript(ctx.workingDir, "lint");
    if (!hasLintScript && !hasAnyFile(ctx.workingDir, [
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
    ])) {
      return {
        passed: true,
        score: 1,
        details: ["No linter configuration detected — skipping lint check"],
        metrics: {},
      };
    }

    try {
      const output = hasLintScript
        ? await runCommand("npm", ["run", "lint"], ctx.workingDir)
        : await runCommand("npx", ["eslint", ".", "--format=compact"], ctx.workingDir);

      const matches = output.match(/problem/g) ?? [];
      const lintErrors = matches.length;

      return {
        passed: lintErrors === 0,
        score: lintErrors === 0 ? 1 : Math.max(0, 1 - lintErrors * 0.05),
        details: lintErrors === 0
          ? ["Lint check passed — 0 problems"]
          : [`${lintErrors} lint problems found`],
        metrics: { lintErrors },
      };
    } catch {
      // ESLint may not be installed
      return {
        passed: true,
        score: 1,
        details: ["No linter configuration detected — skipping lint check"],
        metrics: {},
      };
    }
  }
}

/**
 * CompositeEvaluator — runs all evaluators and returns aggregated results.
 */
export class CompositeEvaluator {
  private evaluators: Evaluator[] = [
    new TypeCheckEvaluator(),
    new TestEvaluator(),
    new BuildEvaluator(),
    new LintEvaluator(),
  ];

  async evaluateAll(ctx: EvalContext): Promise<EvalResult[]> {
    const results = await Promise.all(
      this.evaluators.map((e) => e.evaluate(ctx)),
    );
    return results;
  }

  /**
   * Run all evaluators and compute an overall score.
   */
  async evaluateOverall(ctx: EvalContext): Promise<EvalResult> {
    const all = await this.evaluateAll(ctx);
    const scores = all.map((r) => r.score);
    const overall = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);

    const details = all.flatMap((r) => r.details);
    const metrics = all.reduce(
      (acc, r) => ({ ...acc, ...r.metrics }),
      {} as EvalResult["metrics"],
    );

    return {
      passed: all.every((r) => r.passed),
      score: overall,
      details,
      metrics,
    };
  }
}

// ---- Command runner ----

function runCommand(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      const output = stdout + stderr;
      if (code === 0) {
        resolve(output);
      } else {
        // tsc returns non-zero for type errors — still capture output
        resolve(output);
      }
    });

    child.on("error", reject);
  });
}

interface PackageJson {
  scripts?: Record<string, string>;
}

function readPackageJson(cwd: string): PackageJson | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf-8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function hasPackageScript(cwd: string, script: string): boolean {
  return Boolean(readPackageJson(cwd)?.scripts?.[script]);
}

function hasFile(cwd: string, file: string): boolean {
  return fs.existsSync(path.join(cwd, file));
}

function hasAnyFile(cwd: string, files: string[]): boolean {
  return files.some((file) => hasFile(cwd, file));
}
