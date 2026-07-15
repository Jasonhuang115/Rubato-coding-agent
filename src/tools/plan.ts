// Plan Tool — allows the AI to create and manage plans programmatically
// This bridges the gap between system prompt instructions and actual plan operations

import type { ToolDefinition, AgentContext } from "../core-types.js";
import { loadPlan, savePlan, serializePlan } from "../plan/tree.js";
import { getGrillMeConfig } from "../plan/grillme.js";
import type { PlanDoc } from "../plan/tree.js";
import * as fs from "fs";
import * as path from "path";

const PLAN_DIR = ".agent/plans";

export const planTool: ToolDefinition = {
  name: "Plan",
  description:
    "Manage the intention tree / plan. Use to create plans, add tasks, mark progress, or show current status. The plan is stored as a markdown file under .agent/plans/.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "add_task", "complete", "block", "show", "finalize"],
        description:
          "create: start a new plan. add_task: append a task. complete: mark a task done. block: block a task. show: display current plan. finalize: lock plan as in_progress.",
      },
      title: {
        type: "string",
        description: "Plan title (required for 'create')",
      },
      goal: {
        type: "string",
        description: "Goal statement for the plan (for 'create')",
      },
      taskTitle: {
        type: "string",
        description: "Task title to add (for 'add_task')",
      },
      taskId: {
        type: "string",
        description: "Task ID to complete or block (for 'complete' / 'block')",
      },
      dependsOn: {
        type: "string",
        description: "Comma-separated task IDs this task depends on (for 'add_task')",
      },
      files: {
        type: "string",
        description: "Comma-separated file paths this plan touches (for 'create')",
      },
    },
    required: ["action"],
  },
  type: "write",
  requiresApproval: false,

  async handler(input, ctx) {
    const { action, title, goal, taskTitle, taskId, dependsOn, files } = input as {
      action: string;
      title?: string;
      goal?: string;
      taskTitle?: string;
      taskId?: string;
      dependsOn?: string;
      files?: string;
    };

    const branch = getGitBranch(ctx.workingDir);
    const existing = loadPlan(ctx.workingDir, branch);

    switch (action) {
      case "create": {
        if (!title) return { content: "Error: 'title' is required for create action.", isError: true };

        const now = new Date().toISOString().slice(0, 10);
        const plan: PlanDoc = {
          title: title!,
          status: "draft",
          branch,
          goal: goal ?? "",
          clarifications: [],
          tasks: {
            id: "root",
            title: title!,
            depth: -1,
            status: "in_progress",
            children: [],
            dependsOn: [],
          },
          decisions: [],
          files: files ? files.split(",").map((f) => f.trim()) : [],
          createdAt: now,
          updatedAt: now,
        };

        savePlan(ctx.workingDir, plan);
        return {
          content: `Plan "${title}" created and saved to .agent/plans/${branch}.md\n\n${serializePlan(plan)}`,
        };
      }

      case "add_task": {
        if (!existing) return { content: "Error: No active plan. Use action=create first.", isError: true };
        if (!taskTitle) return { content: "Error: 'taskTitle' is required for add_task.", isError: true };

        const deps = dependsOn ? dependsOn.split(",").map((d) => d.trim()) : [];
        const childCount = existing.tasks.children.length;

        existing.tasks.children.push({
          id: `root/${childCount + 1}`,
          title: taskTitle!,
          depth: 0,
          status: "pending",
          children: [],
          dependsOn: deps,
        });

        existing.updatedAt = new Date().toISOString().slice(0, 10);
        savePlan(ctx.workingDir, existing);

        return {
          content: `Task "${taskTitle}" added to plan "${existing.title}".\n\n${serializePlan(existing)}`,
        };
      }

      case "complete": {
        if (!existing) return { content: "Error: No active plan.", isError: true };
        if (!taskId) return { content: "Error: 'taskId' is required for complete.", isError: true };

        const node = findNodeInPlan(existing, taskId!);
        if (!node) return { content: `Error: Task "${taskId}" not found.`, isError: true };

        node.status = "done";
        existing.updatedAt = new Date().toISOString().slice(0, 10);

        // Auto-activate next pending task
        const next = findNextPending(existing.tasks);
        if (next) {
          next.status = "in_progress";
        }

        savePlan(ctx.workingDir, existing);
        return {
          content: `Task "${node.title}" marked as done.${next ? ` Next: "${next.title}" is now active.` : ""}\n\n${serializePlan(existing)}`,
        };
      }

      case "block": {
        if (!existing) return { content: "Error: No active plan.", isError: true };
        if (!taskId) return { content: "Error: 'taskId' is required for block.", isError: true };

        const node = findNodeInPlan(existing, taskId!);
        if (!node) return { content: `Error: Task "${taskId}" not found.`, isError: true };

        node.status = "blocked";
        existing.updatedAt = new Date().toISOString().slice(0, 10);
        savePlan(ctx.workingDir, existing);

        return {
          content: `Task "${node.title}" blocked.\n\n${serializePlan(existing)}`,
        };
      }

      case "show": {
        if (!existing) {
          return { content: "No active plan. Create one with action=create, or tell the user to describe their task." };
        }
        return { content: serializePlan(existing) };
      }

      case "finalize": {
        if (!existing) return { content: "Error: No active plan to finalize.", isError: true };

        existing.status = "in_progress";
        existing.updatedAt = new Date().toISOString().slice(0, 10);

        // Activate first pending task
        const first = findNextPending(existing.tasks);
        if (first) {
          first.status = "in_progress";
        }

        savePlan(ctx.workingDir, existing);
        return {
          content: `Plan "${existing.title}" is now active! First task: "${first?.title ?? 'none'}".\n\n${serializePlan(existing)}`,
        };
      }

      default:
        return { content: `Unknown action: ${action}. Valid: create, add_task, complete, block, show, finalize`, isError: true };
    }
  },
};

// ---- Helpers ----

function getGitBranch(workingDir: string): string {
  try {
    return fs
      .readFileSync(path.join(workingDir, ".git", "HEAD"), "utf-8")
      .trim()
      .replace("ref: refs/heads/", "") || "main";
  } catch {
    return "main";
  }
}

function findNodeInPlan(plan: PlanDoc, id: string): PlanDoc["tasks"]["children"][0] | null {
  for (const child of plan.tasks.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function findNode(
  node: PlanDoc["tasks"]["children"][0],
  id: string
): PlanDoc["tasks"]["children"][0] | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function findNextPending(
  node: PlanDoc["tasks"]
): PlanDoc["tasks"]["children"][0] | null {
  for (const child of node.children) {
    if (child.status === "pending") return child;
    const nested = findNextPending(child as any);
    if (nested) return nested;
  }
  return null;
}
