// Grill Me — deviation tracking mode
// Monitors user inputs and tool calls against the active plan.
// Three sensitivity levels: strict, normal, loose.
// When deviation is detected, warns the user and offers options.

import type { PlanDoc, IntentionNode } from "./tree.js";
import { getActiveGoal, getBlockedBy, findNode } from "./tree.js";

// ---- Types ----

export type Sensitivity = "strict" | "normal" | "loose";

export interface DeviationResult {
  /** Whether a deviation was detected */
  isDeviation: boolean;
  /** Severity: mild = unrelated task, major = conflicts with plan, blocker = dependency violation */
  severity: "none" | "mild" | "major" | "blocker";
  /** Human-readable explanation */
  message: string;
  /** The current active goal that might be affected */
  affectedGoal?: string;
  /** The current progress */
  progress?: string;
  /** Suggested actions for the user */
  suggestions: DeviationAction[];
}

export interface DeviationAction {
  label: string;
  description: string;
  /** What happens if user picks this */
  type: "pause_and_do" | "record_later" | "continue_plan" | "revise_plan" | "proceed_anyway";
}

export interface GrillMeConfig {
  enabled: boolean;
  sensitivity: Sensitivity;
}

// ---- Default config ----

let currentConfig: GrillMeConfig = {
  enabled: true,
  sensitivity: "normal",
};

export function getGrillMeConfig(): GrillMeConfig {
  return { ...currentConfig };
}

export function setGrillMeConfig(config: Partial<GrillMeConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

// ---- Deviation detection ----

/** Check if a user message deviates from the current plan. */
export function checkDeviation(
  userMessage: string,
  plan: PlanDoc | null,
  sensitivity?: Sensitivity
): DeviationResult {
  const sens = sensitivity ?? currentConfig.sensitivity;

  if (!currentConfig.enabled || !plan || plan.status === "abandoned") {
    return noDeviation();
  }

  if (plan.status === "done") {
    return {
      isDeviation: false,
      severity: "none",
      message: "",
      suggestions: [],
    };
  }

  const activeGoal = getActiveGoal(plan.tasks);
  if (!activeGoal) {
    return noDeviation();
  }

  const progress = formatProgress(plan);

  // Check if user wants to start something completely new
  const newTaskSignal = isNewTaskIntent(userMessage);
  if (newTaskSignal && sens !== "loose") {
    return {
      isDeviation: true,
      severity: "major",
      message: `⚠️ 你似乎想开始一个新任务「${truncate(userMessage, 60)}」，但当前计划「${plan.title}」还未完成。`,
      affectedGoal: activeGoal.title,
      progress,
      suggestions: [
        {
          label: "暂停计划，先处理这个",
          type: "pause_and_do",
          description: "当前计划暂停，新任务完成后恢复。",
        },
        {
          label: "先记下来，做完再处理",
          type: "record_later",
          description: "把新任务加入待办列表，先完成当前计划。",
        },
        {
          label: "放弃当前计划，开始新的",
          type: "revise_plan",
          description: "归档当前计划，为新任务创建新计划。",
        },
      ],
    };
  }

  // Check if message is about changing a completed decision
  const revisionSignal = isRevisingCompleted(userMessage, plan);
  if (revisionSignal && sens !== "loose") {
    return {
      isDeviation: true,
      severity: "major",
      message: `⚠️ 「${revisionSignal.decision}」这个决策已经确定并执行了部分任务。修改它会影响：\n${revisionSignal.affected.map((t) => `  - ${t}`).join("\n")}\n\n要重新评估计划吗？`,
      affectedGoal: activeGoal.title,
      progress,
      suggestions: [
        {
          label: "重新评估计划",
          type: "revise_plan",
          description: "标记受影响的任务为需返工，更新计划。",
        },
        {
          label: "保留现有方案，不修改",
          type: "continue_plan",
          description: "继续按原计划执行。",
        },
      ],
    };
  }

  // Check if user is asking something related to the plan
  const isRelated = isRelatedToActiveGoal(userMessage, activeGoal);
  if (!isRelated && sens === "strict") {
    return {
      isDeviation: true,
      severity: "mild",
      message: `⚠️（严格模式）当前目标是「${activeGoal.title}」，这条消息似乎不直接相关。`,
      affectedGoal: activeGoal.title,
      progress,
      suggestions: [
        { label: "继续执行计划", type: "continue_plan", description: "忽略，继续。" },
        { label: "先处理这个", type: "pause_and_do", description: "记录为计划外任务。" },
      ],
    };
  }

  // Loose mode: only flag clear blockers
  if (sens === "loose" && !isRelated && !isRelatedToPlan(userMessage, plan)) {
    return noDeviation();
  }

  return noDeviation();
}

/** Check if a tool call deviates from the plan. */
export function checkToolDeviation(
  toolName: string,
  toolInput: Record<string, unknown>,
  plan: PlanDoc | null,
  sensitivity?: Sensitivity
): DeviationResult {
  const sens = sensitivity ?? currentConfig.sensitivity;

  if (!currentConfig.enabled || !plan || sens === "loose") {
    return noDeviation();
  }

  const activeGoal = getActiveGoal(plan.tasks);
  if (!activeGoal) return noDeviation();

  // File-based tools: check if touching files outside the plan
  const filePath = extractFilePath(toolName, toolInput);
  if (filePath && plan.files.length > 0) {
    const isInPlan = plan.files.some((f) => filePath.startsWith(f) || f.startsWith(filePath));
    if (!isInPlan && sens === "strict") {
      return {
        isDeviation: true,
        severity: "mild",
        message: `⚠️（严格模式）${toolName} 操作的文件「${filePath}」不在计划范围内。\n计划文件：${plan.files.join(", ")}`,
        affectedGoal: activeGoal.title,
        suggestions: [
          { label: "仍然执行", type: "proceed_anyway", description: "我知道这可能偏离计划。" },
          { label: "跳过", type: "continue_plan", description: "不执行此操作。" },
        ],
      };
    }

    if (!isInPlan && sens === "normal") {
      // In normal mode, only flag if it happens repeatedly — tracked externally
      // But we still note it
      return {
        isDeviation: true,
        severity: "mild",
        message: `💡 操作的文件「${filePath}」不在计划中。当前目标：「${activeGoal.title}」`,
        affectedGoal: activeGoal.title,
        suggestions: [
          { label: "继续", type: "proceed_anyway", description: "这个文件和当前目标相关。" },
          { label: "更新计划文件列表", type: "revise_plan", description: "将此文件加入计划。" },
        ],
      };
    }
  }

  // Dependency check: is the tool operating on something that depends on unfinished work?
  if (toolName === "write" || toolName === "edit") {
    const blockers = getBlockedBy(plan.tasks, activeGoal.id);
    if (blockers.length > 0) {
      return {
        isDeviation: true,
        severity: "blocker",
        message: `⛔ 当前任务「${activeGoal.title}」依赖以下未完成的任务：\n${blockers.map((b) => `  - ${b.title} (${b.status})`).join("\n")}\n\n建议先完成这些前置任务。`,
        affectedGoal: activeGoal.title,
        suggestions: [
          { label: "先完成前置任务", type: "continue_plan", description: "按依赖顺序执行。" },
          { label: "跳过依赖（我知道风险）", type: "proceed_anyway", description: "前置条件不适用，直接继续。" },
        ],
      };
    }
  }

  return noDeviation();
}

// ---- Formatting helpers ----

export function formatGrillMeWarning(result: DeviationResult): string {
  if (!result.isDeviation) return "";

  const lines = [result.message];

  if (result.affectedGoal) {
    lines.push(`\n当前目标：${result.affectedGoal}`);
  }
  if (result.progress) {
    lines.push(result.progress);
  }
  if (result.suggestions.length > 0) {
    lines.push(
      "\n选项：",
      ...result.suggestions.map(
        (s, i) => `  (${i + 1}) ${s.label} — ${s.description}`
      )
    );
  }

  return lines.join("\n");
}

// ---- Internal helpers ----

function noDeviation(): DeviationResult {
  return { isDeviation: false, severity: "none", message: "", suggestions: [] };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

function formatProgress(plan: PlanDoc): string {
  const tasks = plan.tasks;
  let done = 0;
  let total = 0;
  countLeaves(tasks, { done: 0, total: 0 }, (acc) => {
    done = acc.done;
    total = acc.total;
    return acc;
  });
  return `进度：${done}/${total} 已完成`;
}

function countLeaves(
  node: IntentionNode,
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
      countLeaves(child, sub, (a) => {
        d = a.done;
        t = a.total;
      });
    }
  }
  cb({ done: d, total: t });
}

function isNewTaskIntent(message: string): boolean {
  const signals = [
    /帮我(新)?(做|写|加|建|创建|实现|开发)/,
    /先(不管|别管|放一下|停一下)/,
    /换个(任务|方向)/,
    /新(需求|功能|任务|项目)/,
    /另外/,
    /顺便/,
    /等一下.*(先|帮我)/,
    /let.*(me|us).*(create|build|add|make|start).*new/i,
  ];
  return signals.some((re) => re.test(message));
}

function isRevisingCompleted(
  message: string,
  plan: PlanDoc
): { decision: string; affected: string[] } | null {
  const revisionMarkers = [
    /(?:不要|不用|别|改|换|替代|取消|替换).*(?:JWT|Session|OAuth|密码|Token|加密|哈希|数据库|框架|ORM)/,
    /(?:应该|还是|改成|换成|用).*(?:JWT|Session|OAuth|密码|Token|加密|哈希|数据库|框架|ORM)/,
    /等等.*(?:不|改|换)/,
  ];

  if (!revisionMarkers.some((re) => re.test(message))) return null;

  // Find which decisions and tasks might be affected
  const affected: string[] = [];
  for (const d of plan.decisions) {
    const keywords = d.split(":")[0].trim();
    if (message.includes(keywords.slice(0, 4))) {
      affected.push(d);
    }
  }

  if (affected.length === 0) return null;

  return {
    decision: affected[0],
    affected: plan.tasks.children
      .filter((t) => t.status === "done" || t.status === "in_progress")
      .map((t) => t.title),
  };
}

function isRelatedToActiveGoal(message: string, goal: IntentionNode): boolean {
  const goalWords = extractKeywords(goal.title);
  const msgWords = extractKeywords(message);

  if (goalWords.length === 0) return true; // can't judge

  const overlap = goalWords.filter((w) => msgWords.includes(w));
  // At least 30% keyword overlap
  return overlap.length / goalWords.length >= 0.3;
}

function isRelatedToPlan(message: string, plan: PlanDoc): boolean {
  const planWords = extractKeywords(plan.title + " " + plan.goal);
  const msgWords = extractKeywords(message);

  if (planWords.length === 0) return true;
  const overlap = planWords.filter((w) => msgWords.includes(w));
  return overlap.length >= 2;
}

function extractKeywords(text: string): string[] {
  // Simple CJK + English keyword extraction
  // Remove punctuation, split CJK by character pairs, split English by word
  const cleaned = text
    .replace(/[，。！？、；：""''（）【】《》\n\r\t.,!?;:'"()\[\]{}]/g, " ")
    .trim()
    .toLowerCase();

  const words = cleaned.split(/\s+/).filter((w) => w.length > 1);

  // For CJK text, also extract 2-char n-grams
  const cjkOnly = text.replace(/[a-zA-Z0-9\s.,!?;:'"()\[\]{}]/g, "");
  for (let i = 0; i < cjkOnly.length - 1; i++) {
    words.push(cjkOnly.slice(i, i + 2));
  }

  return [...new Set(words)];
}

function extractFilePath(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  const fileTools = ["read", "write", "edit", "glob"];
  if (!fileTools.includes(toolName)) return null;

  const path = input.file_path ?? input.filePath ?? input.path;
  if (typeof path === "string") return path;
  return null;
}
