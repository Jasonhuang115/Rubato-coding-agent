// PlanManager — ties together the plan system (tree + gatherer + planner + grillme)
// Lightweight facade used by agent loop and CLI entry

import type { PlanDoc } from "./tree.js";
import { loadPlan, savePlan, listPlans, serializePlan } from "./tree.js";
import type { GatheredRequirements, GatheringState } from "./gatherer.js";
import { startGathering, isSufficient, recordAnswer, skipQuestion, skipAllRemaining, finalizeGathering } from "./gatherer.js";
import { generatePlan } from "./planner.js";
import type { GrillMeConfig } from "./grillme.js";
import { checkDeviation, checkToolDeviation, getGrillMeConfig, setGrillMeConfig, formatGrillMeWarning } from "./grillme.js";

export class PlanManager {
  private plan: PlanDoc | null;
  private gatheringState: GatheringState | null;
  private workingDir: string;
  private branch: string;

  constructor(workingDir: string, branch?: string) {
    this.workingDir = workingDir;
    this.branch = branch ?? "main";
    this.plan = loadPlan(workingDir, this.branch);
    this.gatheringState = null;
  }

  // ---- Plan access ----

  getActivePlan(): PlanDoc | null {
    return this.plan;
  }

  getPlanSummary(): string {
    if (!this.plan) return "";

    const tasks = this.plan.tasks;
    let done = 0;
    let total = 0;
    this.countLeaves(tasks, { done: 0, total: 0 }, (acc) => {
      done = acc.done;
      total = acc.total;
    });

    const lines = [
      `当前计划：${this.plan.title}`,
      `状态：${this.plan.status} | 进度：${done}/${total}`,
    ];

    // Show top-level tasks
    if (tasks.children.length > 0) {
      lines.push("任务：");
      for (const child of tasks.children) {
        const icon = child.status === "done" ? "✅" :
          child.status === "in_progress" ? "🔄" :
          child.status === "blocked" ? "⛔" : "⏳";
        lines.push(`  ${icon} ${child.title}`);
      }
    }

    return lines.join("\n");
  }

  // ---- Gathering mode ----

  startRequirementsGathering(taskDescription: string): GatheringState {
    this.gatheringState = startGathering(taskDescription);
    return this.gatheringState;
  }

  getGatheringState(): GatheringState | null {
    return this.gatheringState;
  }

  recordRequirementAnswer(key: string, answer: string): void {
    if (this.gatheringState) {
      recordAnswer(this.gatheringState, key, answer);
    }
  }

  skipRequirement(key: string): void {
    if (this.gatheringState) {
      skipQuestion(this.gatheringState, key);
    }
  }

  isGatheringSufficient(): boolean {
    return this.gatheringState ? isSufficient(this.gatheringState) : false;
  }

  finalizeGatheringAndGeneratePlan(title?: string): PlanDoc | null {
    if (!this.gatheringState) return null;

    const req: GatheredRequirements = finalizeGathering(this.gatheringState);
    this.plan = generatePlan(req, {
      workingDir: this.workingDir,
      branch: this.branch,
      title,
    });
    this.gatheringState = null;
    return this.plan;
  }

  skipAllAndGeneratePlan(title?: string): PlanDoc | null {
    if (!this.gatheringState) return null;
    skipAllRemaining(this.gatheringState);
    return this.finalizeGatheringAndGeneratePlan(title);
  }

  // ---- Grill Me ----

  getGrillMeConfig(): GrillMeConfig {
    return getGrillMeConfig();
  }

  setGrillMeSensitivity(level: GrillMeConfig["sensitivity"]): void {
    setGrillMeConfig({ sensitivity: level });
  }

  toggleGrillMe(): boolean {
    const cfg = getGrillMeConfig();
    setGrillMeConfig({ enabled: !cfg.enabled });
    return !cfg.enabled;
  }

  onUserMessage(message: string): string | null {
    const result = checkDeviation(message, this.plan);
    if (result.isDeviation) {
      return formatGrillMeWarning(result);
    }
    return null;
  }

  onToolCall(toolName: string, input: Record<string, unknown>): string | null {
    const result = checkToolDeviation(toolName, input, this.plan);
    if (result.isDeviation) {
      return formatGrillMeWarning(result);
    }
    return null;
  }

  // ---- Plan management CLI commands ----

  showPlan(): string {
    if (!this.plan) return "没有活跃计划。用 /plan new <描述> 创建新计划。";

    return serializePlan(this.plan);
  }

  listPlans(): string[] {
    return listPlans(this.workingDir);
  }

  reloadPlan(): PlanDoc | null {
    this.plan = loadPlan(this.workingDir, this.branch);
    return this.plan;
  }

  savePlan(): void {
    if (this.plan) {
      savePlan(this.workingDir, this.plan);
    }
  }

  // ---- Helpers ----

  private countLeaves(
    node: import("./tree.js").IntentionNode,
    acc: { done: number; total: number },
    cb: (a: { done: number; total: number }) => void
  ): void {
    let d = acc.done;
    let t = acc.total;
    if (node.children.length === 0) {
      t++;
      if (node.status === "done" || node.status === "skipped") d++;
    } else {
      for (const child of node.children) {
        const sub = { done: d, total: t };
        this.countLeaves(child, sub, (a) => {
          d = a.done;
          t = a.total;
        });
      }
    }
    cb({ done: d, total: t });
  }
}
