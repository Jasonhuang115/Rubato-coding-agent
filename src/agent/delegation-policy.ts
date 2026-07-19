import type { ToolDefinition } from "../shared/core-types.js";

export interface DelegationDecision {
  subagentType: "explore";
  description: string;
  prompt: string;
}

const CHINESE_PROJECT = /(项目|代码库|仓库|工程)/;
const CHINESE_EXPLORE = /(探索|分析|评估|评价|审查|了解|梳理)/;
const ENGLISH_PROJECT = /\b(project|codebase|repository|repo)\b/i;
const ENGLISH_EXPLORE = /\b(explore|analy[sz]e|evaluate|assess|review|understand|audit)\b/i;
const OPT_OUT = [
  /不(?:要|用|需要)(?:使用|启动|调用|起)?\s*(?:subagent|子代理)/i,
  /(?:不要|别)(?:启动|调用|起)?\s*(?:subagent|子代理)/i,
  /\b(?:do not|don't|without)\s+(?:use|spawn(?:ing)?|launch(?:ing)?)?\s*(?:a\s+)?subagent\b/i,
];

/** Deterministic routing for tasks that the system policy already says must delegate. */
export function getRequiredDelegation(
  prompt: string,
  depth: number,
  tools: ToolDefinition[],
): DelegationDecision | null {
  if (depth !== 0 || !tools.some((tool) => tool.name === "Agent")) return null;
  if (OPT_OUT.some((pattern) => pattern.test(prompt))) return null;

  const isBroadProjectExploration =
    (CHINESE_PROJECT.test(prompt) && CHINESE_EXPLORE.test(prompt)) ||
    (ENGLISH_PROJECT.test(prompt) && ENGLISH_EXPLORE.test(prompt));

  if (!isBroadProjectExploration) return null;

  return {
    subagentType: "explore",
    description: "Explore requested project",
    prompt: [
      prompt,
      "",
      "Explore the requested project broadly and read-only. Return a self-contained report with key files, architecture, strengths, weaknesses, and test coverage. Do not modify files.",
    ].join("\n"),
  };
}
