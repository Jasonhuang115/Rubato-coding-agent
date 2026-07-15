// Plan Generator — converts gathered requirements into a structured Intention Tree
// Produces a PlanDoc that gets serialized to .agent/plans/{branch}.md

import type { PlanDoc, IntentionNode } from "./tree.js";
import type { GatheredRequirements } from "./gatherer.js";
import { savePlan } from "./tree.js";

// ---- Plan generation ----

export interface PlanOptions {
  workingDir: string;
  branch: string;
  title?: string; // override auto-generated title
}

export function generatePlan(
  req: GatheredRequirements,
  opts: PlanOptions
): PlanDoc {
  const title = opts.title ?? inferTitle(req.taskDescription);
  const goal = buildGoalStatement(req);
  const tasks = buildTaskTree(req);
  const files = predictFiles(req);
  const decisions = extractDecisions(req);

  const now = new Date().toISOString().slice(0, 10);

  const plan: PlanDoc = {
    title,
    status: "draft",
    branch: opts.branch,
    goal,
    clarifications: req.clarifications,
    tasks,
    decisions,
    files,
    createdAt: now,
    updatedAt: now,
  };

  // Persist immediately
  savePlan(opts.workingDir, plan);

  return plan;
}

/** Update an existing plan (e.g. after user changes mind during execution). */
export function revisePlan(
  plan: PlanDoc,
  revisions: { goal?: string; addTasks?: IntentionNode[]; addFiles?: string[]; addDecisions?: string[] },
  workingDir: string
): PlanDoc {
  if (revisions.goal) {
    plan.goal = revisions.goal;
  }
  if (revisions.addTasks) {
    for (const task of revisions.addTasks) {
      plan.tasks.children.push(task);
    }
  }
  if (revisions.addFiles) {
    for (const f of revisions.addFiles) {
      if (!plan.files.includes(f)) {
        plan.files.push(f);
      }
    }
  }
  if (revisions.addDecisions) {
    for (const d of revisions.addDecisions) {
      if (!plan.decisions.includes(d)) {
        plan.decisions.push(d);
      }
    }
  }

  plan.updatedAt = new Date().toISOString().slice(0, 10);
  savePlan(workingDir, plan);

  return plan;
}

// ---- Internal helpers ----

function inferTitle(desc: string): string {
  // Take first sentence or first 60 chars
  const firstSentence = desc.split(/[。.!?？\n]/)[0].trim();
  if (firstSentence.length <= 60) return firstSentence;
  return firstSentence.slice(0, 57) + "...";
}

function buildGoalStatement(req: GatheredRequirements): string {
  const parts = [req.taskDescription];

  // Add key decisions as context
  const criticalKeys = req.clarifications
    .filter(() => true) // all clarifications are relevant
    .map((c) => `- ${c.question.split("？")[0]} → ${c.answer}`);

  if (criticalKeys.length > 0) {
    parts.push("\n核心决策：\n" + criticalKeys.join("\n"));
  }

  return parts.join("\n\n");
}

function buildTaskTree(req: GatheredRequirements): IntentionNode {
  const root: IntentionNode = {
    id: "root",
    title: req.taskDescription.slice(0, 80),
    depth: -1,
    status: "in_progress",
    children: [],
    dependsOn: [],
  };

  // Generate tasks based on task type
  for (const type of req.taskTypes) {
    const tasks = generateTasksForType(type, req);
    if (tasks) {
      root.children.push(tasks);
    }
  }

  // If no type-specific tasks, create a simple breakdown
  if (root.children.length === 0) {
    root.children.push({
      id: "root/1",
      title: "实现核心逻辑",
      depth: 0,
      status: "pending",
      children: [],
      dependsOn: [],
    });
  }

  // Add testing task if testing was discussed
  if (hasTesting(req)) {
    root.children.push({
      id: `root/${root.children.length + 1}`,
      title: "编写测试",
      depth: 0,
      status: "pending",
      children: [],
      dependsOn: root.children.map((c) => c.id),
    });
  }

  return root;
}

function generateTasksForType(
  type: string,
  req: GatheredRequirements
): IntentionNode | null {
  const answer = (key: string) => req.answers[key] ?? "";

  switch (type) {
    case "auth":
      return buildAuthTasks(req, answer);
    case "database":
      return buildDatabaseTasks(req, answer);
    case "api":
      return buildApiTasks(req, answer);
    case "frontend":
      return buildFrontendTasks(req, answer);
    default:
      return null;
  }
}

function buildAuthTasks(
  req: GatheredRequirements,
  a: (k: string) => string
): IntentionNode {
  const id = "root/1";
  const node: IntentionNode = {
    id,
    title: "用户认证系统",
    depth: 0,
    status: "pending",
    children: [],
    dependsOn: [],
  };

  // 1. Database layer
  const dbNode: IntentionNode = {
    id: `${id}/1`,
    title: "数据库层 — users 表",
    depth: 1,
    status: "pending",
    children: [
      {
        id: `${id}/1/1`,
        title: "创建 users 表（含索引和约束）",
        depth: 2,
        status: "pending",
        children: [],
        dependsOn: [],
      },
    ],
    dependsOn: [],
  };
  node.children.push(dbNode);

  // 2. Core business logic
  const bizNode: IntentionNode = {
    id: `${id}/2`,
    title: "业务逻辑",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [`${id}/1`],
  };

  if (a("auth_method").includes("JWT") || !a("auth_method")) {
    bizNode.children.push({
      id: `${id}/2/1`,
      title: "POST /register — 注册接口（bcrypt 哈希 → 入库）",
      depth: 2,
      status: "pending",
      children: [],
      dependsOn: [],
    });
    bizNode.children.push({
      id: `${id}/2/2`,
      title: "POST /login — 登录接口（验证密码 → 签发 JWT）",
      depth: 2,
      status: "pending",
      children: [],
      dependsOn: [],
    });
  }

  if (a("auth_method").includes("Session")) {
    bizNode.children.push({
      id: `${id}/2/3`,
      title: "Session 管理（创建/验证/销毁）",
      depth: 2,
      status: "pending",
      children: [],
      dependsOn: [],
    });
  }

  node.children.push(bizNode);

  // 3. Middleware
  node.children.push({
    id: `${id}/3`,
    title: "认证中间件",
    depth: 1,
    status: "pending",
    children: [
      {
        id: `${id}/3/1`,
        title: "JWT/Token 验证中间件（解析 → 查库 → 挂载 req.user）",
        depth: 2,
        status: "pending",
        children: [],
        dependsOn: [],
      },
      {
        id: `${id}/3/2`,
        title: "角色/权限守卫（可选）",
        depth: 2,
        status: "pending",
        children: [],
        dependsOn: [],
      },
    ],
    dependsOn: [`${id}/2`],
  });

  // 4. Security hardening
  if (a("security_hardening")) {
    node.children.push({
      id: `${id}/4`,
      title: "安全加固",
      depth: 1,
      status: "pending",
      children: [
        {
          id: `${id}/4/1`,
          title: "登录失败限流（5 次 → 锁定 15 分钟）",
          depth: 2,
          status: "pending",
          children: [],
          dependsOn: [],
        },
      ],
      dependsOn: [`${id}/2`],
    });
  }

  return node;
}

function buildDatabaseTasks(
  req: GatheredRequirements,
  a: (k: string) => string
): IntentionNode {
  const id = "root/1";
  const node: IntentionNode = {
    id,
    title: "数据库变更",
    depth: 0,
    status: "pending",
    children: [],
    dependsOn: [],
  };

  node.children.push({
    id: `${id}/1`,
    title: "设计 Schema（字段、类型、关系）",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [],
  });

  node.children.push({
    id: `${id}/2`,
    title: "编写 Migration 脚本",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [`${id}/1`],
  });

  node.children.push({
    id: `${id}/3`,
    title: "添加索引和约束",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [`${id}/2`],
  });

  if (a("orm_choice")) {
    node.children.push({
      id: `${id}/4`,
      title: "更新 ORM 模型定义",
      depth: 1,
      status: "pending",
      children: [],
      dependsOn: [`${id}/1`],
    });
  }

  return node;
}

function buildApiTasks(
  req: GatheredRequirements,
  a: (k: string) => string
): IntentionNode {
  const id = "root/1";
  const node: IntentionNode = {
    id,
    title: "API 端点实现",
    depth: 0,
    status: "pending",
    children: [],
    dependsOn: [],
  };

  node.children.push({
    id: `${id}/1`,
    title: "定义路由结构和版本前缀",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [],
  });

  node.children.push({
    id: `${id}/2`,
    title: "实现核心端点（CRUD）",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [`${id}/1`],
  });

  node.children.push({
    id: `${id}/3`,
    title: "添加请求校验（JSON Schema / Zod）",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [`${id}/2`],
  });

  node.children.push({
    id: `${id}/4`,
    title: "统一错误处理和响应格式",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [`${id}/2`],
  });

  if (a("cors")) {
    node.children.push({
      id: `${id}/5`,
      title: "配置 CORS 和安全头",
      depth: 1,
      status: "pending",
      children: [],
      dependsOn: [`${id}/1`],
    });
  }

  return node;
}

function buildFrontendTasks(
  req: GatheredRequirements,
  a: (k: string) => string
): IntentionNode {
  const id = "root/1";
  const node: IntentionNode = {
    id,
    title: "前端页面/组件",
    depth: 0,
    status: "pending",
    children: [],
    dependsOn: [],
  };

  node.children.push({
    id: `${id}/1`,
    title: "设计组件结构和页面布局",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [],
  });

  node.children.push({
    id: `${id}/2`,
    title: "实现核心 UI 组件",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [`${id}/1`],
  });

  node.children.push({
    id: `${id}/3`,
    title: "对接 API（数据获取和状态管理）",
    depth: 1,
    status: "pending",
    children: [],
    dependsOn: [`${id}/2`],
  });

  if (a("responsive")?.includes("移动端")) {
    node.children.push({
      id: `${id}/4`,
      title: "移动端响应式适配",
      depth: 1,
      status: "pending",
      children: [],
      dependsOn: [`${id}/2`],
    });
  }

  return node;
}

function hasTesting(req: GatheredRequirements): boolean {
  return (
    req.taskTypes.includes("testing") ||
    Object.keys(req.answers).some((k) => k.startsWith("test_"))
  );
}

function predictFiles(req: GatheredRequirements): string[] {
  const files: string[] = [];
  const a = req.answers;

  if (req.taskTypes.includes("auth")) {
    files.push("src/auth/");
    files.push("src/middleware/auth.ts");
  }

  if (req.taskTypes.includes("database")) {
    files.push("migrations/");
    files.push("src/db/");
  }

  if (req.taskTypes.includes("api")) {
    files.push("src/routes/");
    files.push("src/controllers/");
  }

  if (req.taskTypes.includes("frontend")) {
    files.push("src/components/");
    files.push("src/pages/");
  }

  if (hasTesting(req)) {
    files.push("tests/");
  }

  return files;
}

function extractDecisions(req: GatheredRequirements): string[] {
  const decisions: string[] = [];

  for (const c of req.clarifications) {
    const shortQ = c.question.split("？")[0].split("?")[0];
    decisions.push(`${shortQ}: ${c.answer}`);
  }

  return decisions;
}
