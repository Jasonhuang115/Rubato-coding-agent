#!/usr/bin/env npx tsx
// SWE-bench harness for Rubato
// Reads SWE-bench dataset, runs rubato on each instance, outputs predictions.json
//
// Usage:
//   npx tsx scripts/swebench-run.ts --dataset path/to/swe-bench.jsonl --output predictions.json --max-instances 5
//
// SWE-bench evaluation (after producing predictions.json):
//   python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench --predictions_path predictions.json --run_id rubato-test

import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// ---- Types ----

interface SWEBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hint_text?: string;
  patch?: string;          // gold patch (only in train set)
  test_patch?: string;
  FAIL_TO_PASS?: string;
  PASS_TO_PASS?: string;
  version?: string;
  created_at?: string;
}

interface Prediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

// ---- Config ----

const WORK_DIR = path.join(process.env.HOME ?? "/tmp", ".rubato", "swebench-work");
const RUBATO_BIN = path.resolve("dist/cli/entry.js");
const TIMEOUT_MS = 30 * 60 * 1000; // 30 min per instance

// ---- Parse CLI args ----

function parseArgs(): { dataset: string; output: string; maxInstances: number } {
  const args = process.argv.slice(2);
  let dataset = "";
  let output = "predictions.json";
  let maxInstances = Infinity;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dataset" && args[i + 1]) { dataset = args[++i]; }
    else if (args[i] === "--output" && args[i + 1]) { output = args[++i]; }
    else if (args[i] === "--max-instances" && args[i + 1]) { maxInstances = parseInt(args[++i], 10); }
  }

  if (!dataset) {
    console.error("Usage: npx tsx scripts/swebench-run.ts --dataset <path> [--output predictions.json] [--max-instances N]");
    process.exit(1);
  }

  return { dataset, output, maxInstances };
}

// ---- Load dataset ----

function loadDataset(filePath: string): SWEBenchInstance[] {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SWEBenchInstance);
}

// ---- Setup repo (via GitHub tarball — fast, no git clone) ----

function setupRepo(instance: SWEBenchInstance): string {
  const repoDir = path.join(WORK_DIR, instance.instance_id);
  const repoName = instance.repo.split("/").pop() ?? "repo";

  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  fs.mkdirSync(repoDir, { recursive: true });
  const cloneDir = path.join(repoDir, repoName);

  // Download repo at the target commit as tar.gz (much faster than git clone)
  const [owner, repo] = instance.repo.split("/");
  const tarballUrl = `https://github.com/${owner}/${repo}/archive/${instance.base_commit}.tar.gz`;
  const tarballPath = path.join(repoDir, "repo.tar.gz");

  console.log(`  Downloading ${tarballUrl}...`);

  execSync(
    `curl -L --max-time 300 -o "${tarballPath}" "${tarballUrl}" 2>&1`,
    { stdio: "pipe", timeout: 310_000 }
  );

  // Extract
  console.log(`  Extracting...`);
  execSync(`tar -xzf "${tarballPath}" -C "${repoDir}" 2>&1`, {
    stdio: "pipe", timeout: 60_000,
  });

  // GitHub archives extract to <repo>-<commit>/ — rename to <repo>/
  const extractedDir = path.join(repoDir, `${repo}-${instance.base_commit}`);
  if (fs.existsSync(extractedDir)) {
    fs.renameSync(extractedDir, cloneDir);
  }

  // Init git so we can produce a diff later
  execSync(`git init 2>&1 && git add -A 2>&1 && git commit -m "base" 2>&1`, {
    cwd: cloneDir, stdio: "pipe", timeout: 30_000,
  });

  return cloneDir;
}

// ---- Run rubato ----

async function runRubato(
  workDir: string,
  problemStatement: string,
  hintText?: string
): Promise<string> {
  const prompt = [
    "You are an expert software engineer fixing a bug in this repository.",
    "",
    "## Problem Statement",
    problemStatement,
    "",
    hintText ? `## Hint\n${hintText}` : "",
    "",
    "## Instructions",
    "1. Read the relevant files to understand the codebase",
    "2. Identify the root cause of the issue",
    "3. Make the minimal changes needed to fix the bug",
    "4. Do NOT make unrelated changes, refactors, or style fixes",
    "5. When done, output a summary of what you changed and why",
  ].filter(Boolean).join("\n");

  console.log(`  Running rubato on ${workDir}...`);

  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [RUBATO_BIN, "-d", workDir, "-n", prompt],
      {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: TIMEOUT_MS,
        env: { ...process.env },
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

    child.on("close", (code) => {
      if (code !== 0) {
        console.log(`  rubato exited with code ${code}`);
        if (stderr) console.log(`  stderr: ${stderr.slice(0, 500)}`);
      }
      resolve(stdout);
    });

    child.on("error", (err) => {
      console.error(`  rubato error: ${err.message}`);
      reject(err);
    });
  });
}

// ---- Extract patch ----

function extractPatch(workDir: string): string {
  try {
    const diff = execSync("git diff --cached", {
      cwd: workDir,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 10_000,
    });

    if (diff.trim()) return diff;

    // If no staged changes, check unstaged
    const unstagedDiff = execSync("git diff", {
      cwd: workDir,
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 10_000,
    });

    return unstagedDiff;
  } catch {
    return "";
  }
}

// ---- Main ----

async function main() {
  const { dataset, output, maxInstances } = parseArgs();

  console.log(`Loading dataset: ${dataset}`);
  const instances = loadDataset(dataset).slice(0, maxInstances);
  console.log(`Will process ${instances.length} instances`);

  const predictions: Prediction[] = [];

  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i];
    console.log(`\n[${i + 1}/${instances.length}] ${instance.instance_id}`);

    try {
      // Setup
      const workDir = setupRepo(instance);

      // Run rubato
      await runRubato(workDir, instance.problem_statement, instance.hint_text);

      // Extract patch
      const patch = extractPatch(workDir);

      if (patch.trim()) {
        console.log(`  ✅ Got patch (${patch.split("\n").length} lines)`);
      } else {
        console.log(`  ⚠️  No patch produced`);
      }

      predictions.push({
        instance_id: instance.instance_id,
        model_name_or_path: "rubato-v0.2",
        model_patch: patch,
      });
    } catch (err) {
      console.error(`  ❌ Failed: ${err}`);
      predictions.push({
        instance_id: instance.instance_id,
        model_name_or_path: "rubato-v0.2",
        model_patch: "",
      });
    }
  }

  // Write predictions
  fs.writeFileSync(output, JSON.stringify(predictions, null, 2));
  console.log(`\n✅ Wrote ${predictions.length} predictions to ${output}`);

  // Summary
  const withPatch = predictions.filter((p) => p.model_patch.trim().length > 0);
  console.log(`   With patch: ${withPatch.length}/${predictions.length}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
