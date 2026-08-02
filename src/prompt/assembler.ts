// PromptAssembler — assembles the complete system prompt from 3 layers
// Static → Capability → Dynamic (Ephemeral is handled by the agent loop per-turn)

import type { AgentContext, ToolDefinition } from "../shared/core-types.js";
import { buildStaticPrompt } from "./static.js";
import { buildCapabilityPrompt } from "./capability.js";
import { buildDynamicPrompt } from "./dynamic.js";
import { buildPlanPrompt } from "./plan.js";
import type { LayeredPrompt } from "./types.js";

export class PromptAssembler {

  /**
   * Assemble the complete system prompt for the given context and tools.
   * Returns separated layers so the caller can decide on caching strategy.
   */
  assemble(ctx: AgentContext, tools: ToolDefinition[]): LayeredPrompt {
    if (ctx.mode === "plan") {
      return { static: buildPlanPrompt(ctx, tools), capability: "", dynamic: "" };
    }
    return {
      static: buildStaticPrompt(),
      capability: buildCapabilityPrompt(tools),
      dynamic: buildDynamicPrompt(ctx),
    };
  }

  /**
   * Assemble as a single string for providers that don't support caching.
   */
  assembleFlat(ctx: AgentContext, tools: ToolDefinition[]): string {
    const layers = this.assemble(ctx, tools);
    return [layers.static, layers.capability, layers.dynamic]
      .filter(Boolean)
      .join("\n\n");
  }

}

/** Default singleton assembler instance. */
let defaultAssembler: PromptAssembler | null = null;

export function getPromptAssembler(): PromptAssembler {
  if (!defaultAssembler) {
    defaultAssembler = new PromptAssembler();
  }
  return defaultAssembler;
}
