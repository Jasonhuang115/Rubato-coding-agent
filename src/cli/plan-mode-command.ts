import { AgentModeController } from "../agent/mode.js";

export function handlePlanModeCommand(input: string, controller: AgentModeController): void {
  const action = input.trim().split(/\s+/)[1] ?? "status";
  if (action === "on") {
    controller.enablePlan();
    console.log("\n  Mode: plan — workspace exploration is read-only.");
    return;
  }
  if (action === "off") {
    controller.disablePlan();
    console.log("\n  Mode: default — no submitted plan will be executed automatically.");
    return;
  }
  if (action === "status") {
    console.log(`\n  ${controller.statusText().replace(/\n/g, "\n  ")}`);
    return;
  }
  console.log("\n  Usage: /plan on | /plan off | /plan status");
}
