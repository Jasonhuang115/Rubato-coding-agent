import type { AgentMode, PlanPhase, PlanReadyControl } from "../shared/core-types.js";

const APPROVE = new Set(["y", "yes", "是", "执行", "开始执行", "按计划执行"]);
const REJECT = new Set(["n", "no", "否", "继续规划"]);

export interface PlanSnapshot {
  title: string;
  markdown: string;
  path: string;
}

export interface TransformedPlanInput {
  modelMessage: string;
  event?: "approved" | "revision_requested";
}

/** Session-local state. Nothing here is persisted as user configuration. */
export class AgentModeController {
  mode: AgentMode = "default";
  phase: PlanPhase = "planning";
  latestPlan: PlanSnapshot | null = null;

  enablePlan(): void {
    this.mode = "plan";
    this.phase = "planning";
  }

  disablePlan(): void {
    this.mode = "default";
    this.phase = "planning";
  }

  clearPending(): void {
    this.phase = "planning";
    this.latestPlan = null;
  }

  markReady(control: PlanReadyControl): void {
    this.latestPlan = {
      title: control.title,
      markdown: control.markdown,
      path: control.path,
    };
    this.mode = "plan";
    this.phase = "awaiting_approval";
  }

  transformUserInput(input: string): TransformedPlanInput {
    const normalized = input.trim().toLowerCase();
    if (this.mode !== "plan" || this.phase !== "awaiting_approval" || !this.latestPlan) {
      return { modelMessage: input };
    }
    if (APPROVE.has(normalized)) {
      const plan = this.latestPlan;
      this.disablePlan();
      return {
        event: "approved",
        modelMessage: [
          "The user explicitly approved the following plan. Implement it now in default mode.",
          "The approval covers implementation only; commit, push, PR, and other external side effects still require their normal authorization.",
          "",
          plan.markdown,
        ].join("\n"),
      };
    }
    this.phase = "planning";
    if (REJECT.has(normalized)) {
      return {
        event: "revision_requested",
        modelMessage: "The user declined the current plan and wants to continue planning. Ask one focused question about what should change.",
      };
    }
    return {
      event: "revision_requested",
      modelMessage: `The user provided feedback on the submitted plan. Revise the plan without implementing it:\n\n${input}`,
    };
  }

  statusText(): string {
    const lines = [`Mode: ${this.mode}`, `Phase: ${this.phase}`];
    if (this.latestPlan) lines.push(`Latest plan: ${this.latestPlan.path}`);
    return lines.join("\n");
  }
}
