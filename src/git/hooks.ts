// Git Hooks — connects the 8 advisory modules to agent loop events
// All hooks are read-only analysis; write operations still require user confirmation

import { getGitState, getCurrentBranch, isGitRepo } from "./advisor.js";
import { runPreflight, type PreflightResult } from "./preflight.js";
import { verifyIntent, type IntentVerification } from "./intent-verify.js";
import { getBranchHealth, type BranchHealthSummary } from "./branch-health.js";
import { narrateHistory } from "./archaeology.js";
import { quickBlame } from "./semantic-blame.js";
import { detectConceptQuestion, explainWithContext } from "./newbie-guide.js";
import { scanTeamRadar, type TeamRadarResult } from "./team-radar.js";
import { learnWorkflow, checkAgainstProfile, type WorkflowProfile } from "./workflow-learner.js";
import { hasConflicts, listConflictedFiles, narrateConflict } from "./conflict-narrator.js";
import type { PlanDoc } from "../plan/tree.js";
import type { MnemosyneStore } from "../memory/store.js";

// ---- Types ----

export interface GitHookResult {
  /** Warnings/advice to display to user (yield as AgentEvent) */
  warnings: string[];
  /** Suggested commands (display but don't execute) */
  suggestions: string[];
  /** Whether the operation should be blocked (only for destructive ops) */
  blocked: boolean;
}

// ---- Hook: Pre-Push Check ----

export async function prePushHook(workingDir: string): Promise<GitHookResult> {
  const warnings: string[] = [];
  const suggestions: string[] = [];
  let blocked = false;

  if (!(await isGitRepo(workingDir))) {
    return { warnings: [], suggestions: [], blocked: false };
  }

  // 1. Preflight check
  const preflight = await runPreflight(workingDir);
  if (preflight) {
    for (const w of preflight.warnings) {
      warnings.push(`[Preflight] ${w.message}`);
    }
    suggestions.push(...preflight.recommendations);
  }

  // 2. Team radar
  const radar = await scanTeamRadar(workingDir);
  if (radar && radar.collisions.length > 0) {
    const highRisk = radar.collisions.filter((c) => c.risk === "high");
    if (highRisk.length > 0) {
      warnings.push(`[Team Radar] 🚨 ${highRisk.length} 个高风险冲突！涉及：${[...new Set(highRisk.map((c) => c.author))].join("、")}`);
      suggestions.push("建议 push 前先和上述同事沟通");
    }
    for (const c of radar.collisions.slice(0, 3)) {
      warnings.push(`[Team Radar] ⚠️ \`${c.branch}\` (${c.author}) 也修改了 \`${c.file}\``);
    }
  }

  return { warnings, suggestions, blocked };
}

// ---- Hook: Pre-Commit Check ----

export async function preCommitHook(
  workingDir: string,
  plan: PlanDoc | null
): Promise<GitHookResult> {
  const warnings: string[] = [];
  const suggestions: string[] = [];
  let blocked = false;

  if (!(await isGitRepo(workingDir))) {
    return { warnings: [], suggestions: [], blocked: false };
  }

  // Intent verification
  const verification = await verifyIntent(workingDir, plan);
  if (verification && !verification.matchesIntent) {
    if (verification.suspicious.length > 0) {
      warnings.push(`[意图验证] ⚠️ ${verification.suspicious.length} 个文件不在计划范围内：${verification.suspicious.join(", ")}`);
    }
    if (verification.unrelated.length > 0) {
      warnings.push(`[意图验证] ❓ ${verification.unrelated.length} 个文件与计划无关：${verification.unrelated.join(", ")}`);
    }
    if (verification.suggestedMessage) {
      suggestions.push(`建议的 commit message：${verification.suggestedMessage}`);
    }
  }

  return { warnings, suggestions, blocked };
}

// ---- Hook: User Message Analysis ----

export async function analyzeUserMessage(
  message: string,
  workingDir: string
): Promise<string | null> {
  // Check for git concept questions
  const concept = detectConceptQuestion(message);
  if (concept) {
    const state = await getGitState(workingDir);
    if (state) {
      // Return explanation with current project context
      const { explainWithContext } = await import("./newbie-guide.js");
      const explanation = await explainWithContext(workingDir, concept);
      if (explanation) {
        return `## Git 概念：${explanation.concept}\n\n${explanation.shortAnswer}\n\n${explanation.withCurrentState}`;
      }
    }
  }

  // Check for code history questions
  const historyMatch = message.match(
    /(?:为什么|why|这行|this line|这段|this code|怎么|how come).*(?:这么写|这样|here|这个判断|这个逻辑)/
  );
  if (historyMatch) {
    // Return context for the model — it'll know to use archaeology
    return "💡 如果你想了解某行的历史原因，告诉我具体的文件和行号，我可以追溯完整的修改历史。";
  }

  return null;
}

// ---- Hook: Conflict Detection ----

export async function conflictCheckHook(
  workingDir: string
): Promise<string | null> {
  const hasConflict = await hasConflicts(workingDir);
  if (!hasConflict) return null;

  const files = await listConflictedFiles(workingDir);
  if (files.length === 0) return null;

  // Generate narratives for first 2 conflicted files
  const narratives: string[] = [];
  const branch = await getCurrentBranch(workingDir);

  for (const file of files.slice(0, 2)) {
    const narrative = await narrateConflict(workingDir, file, branch, "main");
    if (narrative) {
      narratives.push(narrative.narrative);
    }
  }

  if (narratives.length > 0) {
    return `## ⚠️ 检测到 Merge 冲突\n\n${narratives.join("\n\n---\n\n")}`;
  }

  return `## ⚠️ 检测到 Merge 冲突\n\n冲突文件：${files.join(", ")}。需要我逐一分析吗？`;
}

// ---- Hook: Session Start ----

export async function sessionStartHook(
  workingDir: string
): Promise<string | null> {
  if (!(await isGitRepo(workingDir))) return null;

  const health = await getBranchHealth(workingDir);
  if (!health) return null;

  const lines = [
    `## 🌿 Git 分支健康`,
    `默认分支：\`${health.defaultBranch}\` | 当前：\`${health.currentBranch}\``,
    `状态：${health.overallStatus}`,
    "",
  ];

  // Show only branches needing attention
  const attentionNeeded = health.branches.filter(
    (b) => b.status !== "healthy"
  );

  if (attentionNeeded.length > 0) {
    for (const b of attentionNeeded.slice(0, 5)) {
      const icon = b.status === "stale" ? "⏰" : b.status === "needs_sync" ? "⚠️" : "💡";
      lines.push(`  ${icon} \`${b.branch}\` — ${b.recommendation}`);
    }
  } else {
    lines.push("  所有分支状态良好 ✅");
  }

  return lines.join("\n");
}

// ---- Hook: Session End (Workflow Learning) ----

export async function sessionEndHook(
  workingDir: string
): Promise<{ learned: boolean; advice: string[] }> {
  if (!(await isGitRepo(workingDir))) {
    return { learned: false, advice: [] };
  }

  try {
    const profile = await learnWorkflow(workingDir);
    const advice = checkAgainstProfile(profile, {});
    return {
      learned: true,
      advice: advice.map((a) => `[${a.category}] ${a.message}`),
    };
  } catch {
    return { learned: false, advice: [] };
  }
}

// ---- Hook: Semantic Blame ----

export { quickBlame, narrateHistory };
