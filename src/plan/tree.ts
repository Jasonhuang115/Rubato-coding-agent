// Intention tree — data structure and markdown serialization
// Plans are stored as .md files under .agent/plans/{branch}.md
// Both human-readable and machine-parseable via checkbox markers

import fs from "fs";
import path from "path";

// ---- Types ----

export interface IntentionNode {
  id: string;
  title: string;
  depth: number; // 0=root goal, 1=top task, 2=subtask...
  status: "pending" | "in_progress" | "done" | "blocked" | "skipped";
  children: IntentionNode[];
  dependsOn: string[]; // prerequisite node IDs
}

export interface PlanDoc {
  title: string;
  status: "draft" | "in_progress" | "done" | "abandoned";
  branch: string;
  goal: string;
  clarifications: Array<{ question: string; answer: string }>;
  tasks: IntentionNode;
  decisions: string[];
  files: string[];
  createdAt: string;
  updatedAt: string;
}

// ---- Markdown → PlanDoc ----

const PLAN_DIR = ".agent/plans";

export function parsePlan(markdown: string, branch: string): PlanDoc {
  const lines = markdown.split("\n");

  const title = extract(lines, /^# Plan:\s*(.+)/) ?? "Untitled";
  const statusLine = extract(lines, /^\*\*Status:\*\*\s*(.+?)\s*\|/);
  const progressLine = extract(lines, /\|\s*\*\*Progress:\*\*\s*(\d+)\/(\d+)/);
  const updatedLine = extract(lines, /\|\s*\*\*Updated:\*\*\s*(.+)/);

  const status = parseStatus(statusLine ?? "draft");

  const goal = extractSection(lines, "## Goal");
  const clarifications = parseClarifications(lines);
  const tasks = parseTasks(lines);
  const decisions = parseList(lines, "## Decisions");
  const files = parseList(lines, "## Files");

  return {
    title,
    status,
    branch,
    goal,
    clarifications,
    tasks,
    decisions,
    files,
    createdAt: "",
    updatedAt: updatedLine ?? new Date().toISOString().slice(0, 10),
  };
}

// ---- PlanDoc → Markdown ----

export function serializePlan(plan: PlanDoc): string {
  const progress = countProgress(plan.tasks);
  const updated = new Date().toISOString().slice(0, 10);

  const lines = [
    `# Plan: ${plan.title}`,
    `**Status:** ${plan.status} | **Progress:** ${progress.done}/${progress.total} | **Updated:** ${updated}`,
    `**Branch:** ${plan.branch}`,
    "",
  ];

  if (plan.goal) {
    lines.push("## Goal", plan.goal, "");
  }

  if (plan.clarifications.length > 0) {
    lines.push("## Clarifications");
    for (const c of plan.clarifications) {
      lines.push(`- Q: ${c.question}`);
      lines.push(`  A: ${c.answer}`);
    }
    lines.push("");
  }

  if (plan.tasks.children.length > 0) {
    lines.push("## Tasks");
    for (const child of plan.tasks.children) {
      lines.push(...serializeNode(child, 0));
    }
    lines.push("");
  }

  if (plan.decisions.length > 0) {
    lines.push("## Decisions");
    for (const d of plan.decisions) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  if (plan.files.length > 0) {
    lines.push("## Files");
    for (const f of plan.files) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---- Node tree → Task list ----

function serializeNode(node: IntentionNode, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const marker = node.status === "done" ? "x" : " ";
  const label = node.status === "in_progress" ? " **← current**" : "";
  const blocked = node.status === "blocked" ? " ⛔" : "";
  const deps = node.dependsOn.length > 0 ? ` (depends: ${node.dependsOn.join(", ")})` : "";

  const lines = [`${indent}- [${marker}] ${node.title}${label}${blocked}${deps}`];

  for (const child of node.children) {
    lines.push(...serializeNode(child, depth + 1));
  }

  return lines;
}

// ---- Task list → Node tree ----

function parseTasks(lines: string[]): IntentionNode {
  const root: IntentionNode = {
    id: "root",
    title: "Root",
    depth: -1,
    status: "in_progress",
    children: [],
    dependsOn: [],
  };

  const taskSection = findSection(lines, "## Tasks");
  if (!taskSection) return root;

  const stack: IntentionNode[] = [root];

  for (const rawLine of taskSection) {
    const match = rawLine.match(/^(\s*)- \[([ x])\] (.+)$/);
    if (!match) continue;

    const indent = match[1].length;
    const checked = match[2] === "x";
    const rawTitle = match[3];

    // Extract metadata from title
    const title = rawTitle
      .replace(/\s*\*\*← current\*\*/, "")
      .replace(/\s*⛔/, "")
      .replace(/\s*\(depends: [^)]+\)/, "")
      .trim();

    const depsMatch = rawTitle.match(/depends:\s*([^)]+)/);
    const dependsOn = depsMatch ? depsMatch[1].split(",").map((s) => s.trim()) : [];

    const isCurrent = rawTitle.includes("**← current**");
    const isBlocked = rawTitle.includes("⛔");

    const depth = indent / 2;
    const node: IntentionNode = {
      id: `task_${depth}_${title.replace(/[^a-zA-Z0-9一-鿿]/g, "_").slice(0, 30)}`,
      title,
      depth,
      status: isCurrent ? "in_progress" : isBlocked ? "blocked" : checked ? "done" : "pending",
      children: [],
      dependsOn,
    };

    // Pop stack until we find the parent
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    node.id = `${parent.id}/${parent.children.length + 1}`;
    parent.children.push(node);
    stack.push(node);
  }

  return root;
}

// ---- Plan utilities ----

export function getActiveGoal(root: IntentionNode): IntentionNode | null {
  for (const child of root.children) {
    const found = findActive(child);
    if (found) return found;
  }
  return null;
}

function findActive(node: IntentionNode): IntentionNode | null {
  if (node.status === "in_progress") return node;
  for (const child of node.children) {
    const found = findActive(child);
    if (found) return found;
  }
  return null;
}

export function getProgress(root: IntentionNode): { done: number; total: number } {
  let done = 0;
  let total = 0;
  countLeaves(root, { done, total });
  return countLeaves(root, { done: 0, total: 0 });
}

function countLeaves(
  node: IntentionNode,
  acc: { done: number; total: number }
): { done: number; total: number } {
  if (node.children.length === 0) {
    acc.total++;
    if (node.status === "done" || node.status === "skipped") acc.done++;
  } else {
    for (const child of node.children) {
      countLeaves(child, acc);
    }
  }
  return acc;
}

export function getNodePath(root: IntentionNode, targetId: string): IntentionNode[] {
  for (const child of root.children) {
    const path = findPath(child, targetId, [root]);
    if (path) return path;
  }
  return [];
}

function findPath(
  node: IntentionNode,
  targetId: string,
  ancestors: IntentionNode[]
): IntentionNode[] | null {
  const current = [...ancestors, node];
  if (node.id === targetId) return current;
  for (const child of node.children) {
    const result = findPath(child, targetId, current);
    if (result) return result;
  }
  return null;
}

export function getBlockedBy(
  root: IntentionNode,
  nodeId: string
): IntentionNode[] {
  const blocked: IntentionNode[] = [];
  findNode(root, nodeId)?.dependsOn.forEach((depId) => {
    const dep = findNode(root, depId);
    if (dep && dep.status !== "done") {
      blocked.push(dep);
    }
  });
  return blocked;
}

export function findNode(root: IntentionNode, id: string): IntentionNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// ---- Persistence ----

export function loadPlan(workingDir: string, branch: string): PlanDoc | null {
  const filePath = planPath(workingDir, branch);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parsePlan(content, branch);
  } catch {
    return null;
  }
}

export function savePlan(workingDir: string, plan: PlanDoc): void {
  const dir = path.join(workingDir, PLAN_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = planPath(workingDir, plan.branch);
  const content = serializePlan(plan);
  fs.writeFileSync(filePath, content, "utf-8");
}

export function listPlans(workingDir: string): string[] {
  const dir = path.join(workingDir, PLAN_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""));
}

export function archivePlan(workingDir: string, branch: string): void {
  const src = planPath(workingDir, branch);
  if (!fs.existsSync(src)) return;
  const archiveDir = path.join(workingDir, PLAN_DIR, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const dest = path.join(archiveDir, `${branch}-${Date.now()}.md`);
  fs.renameSync(src, dest);
}

function planPath(workingDir: string, branch: string): string {
  const safeBranch = branch.replace(/\//g, "-");
  return path.join(workingDir, PLAN_DIR, `${safeBranch}.md`);
}

// ---- Helpers ----

function extract(lines: string[], re: RegExp): string | null {
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1] ?? m[0];
  }
  return null;
}

function extractSection(lines: string[], heading: string): string {
  let inSection = false;
  let content = "";
  for (const line of lines) {
    if (line.startsWith(heading)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (line.startsWith("## ")) break;
      if (line.trim()) content += line.trim() + "\n";
    }
  }
  return content.trim();
}

function findSection(lines: string[], heading: string): string[] | null {
  let inSection = false;
  const sectionLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(heading)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (line.startsWith("## ")) break;
      sectionLines.push(line);
    }
  }
  return sectionLines.length > 0 ? sectionLines : null;
}

function parseClarifications(
  lines: string[]
): Array<{ question: string; answer: string }> {
  const result: Array<{ question: string; answer: string }> = [];
  let currentQ = "";
  for (const line of lines) {
    const qMatch = line.match(/^- Q:\s*(.+)/);
    const aMatch = line.match(/^\s+A:\s*(.+)/);
    if (qMatch) {
      currentQ = qMatch[1];
    } else if (aMatch && currentQ) {
      result.push({ question: currentQ, answer: aMatch[1] });
      currentQ = "";
    }
  }
  return result;
}

function parseList(lines: string[], heading: string): string[] {
  const section = findSection(lines, heading);
  if (!section) return [];
  return section
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => l.replace(/^-\s*/, "").trim());
}

function parseStatus(s: string): PlanDoc["status"] {
  if (["draft", "in_progress", "done", "abandoned"].includes(s)) {
    return s as PlanDoc["status"];
  }
  return "draft";
}

function countProgress(root: IntentionNode): { done: number; total: number } {
  return countLeaves(root, { done: 0, total: 0 });
}
