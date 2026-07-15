// Grill Me — requirements gathering mode
// Before making a plan, the agent asks clarifying questions until
// enough information is collected. User can skip with "先按默认方案来".

// ---- Types ----

export interface ChecklistItem {
  question: string;
  key: string;
  category: string;
  priority: "critical" | "important" | "nice_to_have";
  defaultValue?: string;
}

export interface GatheredRequirements {
  taskDescription: string;
  taskTypes: string[];
  answers: Record<string, string>; // key → answer
  skipped: string[]; // keys that were skipped (default assumed)
  clarifications: Array<{ question: string; answer: string }>;
  gatheredAt: string;
}

export interface GatheringState {
  questions: ChecklistItem[];
  answers: Record<string, string>;
  skipped: Set<string>;
  currentIndex: number;
  taskDescription: string;
  taskTypes: string[];
}

// ---- Checklist Templates ----

const TEMPLATES: Record<string, ChecklistItem[]> = {
  auth: [
    {
      question: "认证方式：JWT、Session、还是 OAuth2.0？要不要支持 SSO？",
      key: "auth_method",
      category: "auth",
      priority: "critical",
      defaultValue: "JWT + bcrypt",
    },
    {
      question: "用户数据存储：用现有 users 表还是新建？需要哪些字段（email, password_hash, role...）？",
      key: "user_storage",
      category: "auth",
      priority: "critical",
      defaultValue: "新建 users 表（id, email, password_hash, created_at, updated_at）",
    },
    {
      question: "密码策略：最小长度？复杂度要求？要不要密码重置/找回功能？",
      key: "password_policy",
      category: "auth",
      priority: "important",
      defaultValue: "最小 8 位，无复杂度要求，暂不需要密码重置",
    },
    {
      question: "会话管理：Token 过期时间？要不要 refresh token？是否支持多设备登录？",
      key: "session_mgmt",
      category: "auth",
      priority: "important",
      defaultValue: "Token 24h 过期，不做 refresh token",
    },
    {
      question: "安全防护：登录失败限制？要不要验证码？是否限流？",
      key: "security_hardening",
      category: "auth",
      priority: "important",
      defaultValue: "5 次失败锁定 15 分钟",
    },
    {
      question: "中间件/框架：Express？Fastify？已有的中间件结构是什么？",
      key: "framework",
      category: "auth",
      priority: "critical",
      defaultValue: "跟随项目现有框架",
    },
    {
      question: "测试：需要单元测试吗？集成测试？覆盖哪些场景？",
      key: "testing",
      category: "auth",
      priority: "nice_to_have",
      defaultValue: "核心流程的单元测试",
    },
  ],

  database: [
    {
      question: "数据库类型：SQLite、PostgreSQL、MySQL？还是多个？",
      key: "db_type",
      category: "database",
      priority: "critical",
    },
    {
      question: "ORM/查询方式：用 ORM（Prisma / Drizzle / TypeORM）还是原生 SQL？",
      key: "orm_choice",
      category: "database",
      priority: "critical",
      defaultValue: "跟随项目现有方案",
    },
    {
      question: "Migration 策略：自动 migration 还是手动管理 SQL 脚本？",
      key: "migration",
      category: "database",
      priority: "important",
      defaultValue: "自动 migration",
    },
    {
      question: "需要哪些表/集合？每个表的字段和关系是什么？",
      key: "schema_design",
      category: "database",
      priority: "critical",
    },
    {
      question: "索引策略：哪些字段需要索引？唯一约束有哪些？",
      key: "indexes",
      category: "database",
      priority: "important",
      defaultValue: "主键 + 外键索引，后续按查询优化",
    },
    {
      question: "连接池/性能：是否需要连接池配置？预期并发量？",
      key: "pool_config",
      category: "database",
      priority: "nice_to_have",
      defaultValue: "默认连接池配置",
    },
  ],

  api: [
    {
      question: "API 风格：RESTful 还是 GraphQL？有没有 OpenAPI 规范要求？",
      key: "api_style",
      category: "api",
      priority: "critical",
      defaultValue: "RESTful",
    },
    {
      question: "路由前缀：`/api/v1/...` 还是直接挂载？需要版本管理吗？",
      key: "routing",
      category: "api",
      priority: "important",
      defaultValue: "/api/v1/",
    },
    {
      question: "请求/响应格式：JSON Schema 验证？统一的错误格式？分页规范？",
      key: "req_res_format",
      category: "api",
      priority: "important",
      defaultValue: "JSON + 统一 { error, data } 响应格式",
    },
    {
      question: "认证/鉴权：哪些端点需要认证？用中间件还是手动检查？",
      key: "api_auth",
      category: "api",
      priority: "critical",
    },
    {
      question: "文件上传：是否需要？大小限制？存储位置（本地/云存储）？",
      key: "file_upload",
      category: "api",
      priority: "nice_to_have",
      defaultValue: "暂不需要",
    },
    {
      question: "CORS / 安全头：需要配置哪些来源？",
      key: "cors",
      category: "api",
      priority: "important",
      defaultValue: "开发环境允许 localhost",
    },
  ],

  frontend: [
    {
      question: "框架：React、Vue、还是纯 HTML/CSS？有没有组件库？",
      key: "fe_framework",
      category: "frontend",
      priority: "critical",
    },
    {
      question: "状态管理：Redux、Zustand、Context、还是不需要？",
      key: "state_mgmt",
      category: "frontend",
      priority: "important",
      defaultValue: "React Context / Vue Composition API",
    },
    {
      question: "样式方案：Tailwind、CSS Modules、styled-components？",
      key: "styling",
      category: "frontend",
      priority: "nice_to_have",
      defaultValue: "跟随项目现有方案",
    },
    {
      question: "路由：需要哪些页面？用 React Router / Vue Router？",
      key: "fe_routing",
      category: "frontend",
      priority: "critical",
    },
    {
      question: "响应式：需要支持移动端吗？断点设计？",
      key: "responsive",
      category: "frontend",
      priority: "nice_to_have",
      defaultValue: "桌面端优先",
    },
    {
      question: "表单处理：有没有表单库偏好（React Hook Form / Formik）？需要哪些校验？",
      key: "form_handling",
      category: "frontend",
      priority: "important",
      defaultValue: "浏览器原生校验",
    },
  ],

  testing: [
    {
      question: "测试框架：Jest、Vitest、Mocha？项目已有测试基础设施吗？",
      key: "test_framework",
      category: "testing",
      priority: "critical",
      defaultValue: "跟随项目现有框架",
    },
    {
      question: "测试类型：单元测试、集成测试、E2E？各自覆盖到什么程度？",
      key: "test_types",
      category: "testing",
      priority: "important",
      defaultValue: "单元测试 + 核心流程集成测试",
    },
    {
      question: "Mock 策略：数据库要不要 mock？外部 API 要不要 mock？",
      key: "mock_strategy",
      category: "testing",
      priority: "important",
      defaultValue: "数据库用内存 SQLite，外部 API mock",
    },
    {
      question: "CI 集成：测试需要在 CI 中运行吗？覆盖率门槛？",
      key: "ci_integration",
      category: "testing",
      priority: "nice_to_have",
      defaultValue: "不设覆盖率门槛",
    },
  ],

  general: [
    {
      question: "这个功能的核心目标是什么？解决了什么问题？",
      key: "goal",
      category: "general",
      priority: "critical",
    },
    {
      question: "有参考实现或者灵感来源吗？",
      key: "reference",
      category: "general",
      priority: "nice_to_have",
      defaultValue: "无特殊参考",
    },
    {
      question: "有没有时间或范围限制？是否有 phase 划分的计划？",
      key: "scope",
      category: "general",
      priority: "important",
      defaultValue: "一次性完成",
    },
    {
      question: "哪些东西明确不需要？（避免过度设计）",
      key: "out_of_scope",
      category: "general",
      priority: "important",
      defaultValue: "无明显排除项",
    },
  ],
};

// ---- Task type detection ----

const TYPE_KEYWORDS: Record<string, string[]> = {
  auth: [
    "登录", "注册", "认证", "权限", "角色", "token", "jwt", "session",
    "login", "register", "auth", "oauth", "sso", "密码", "password",
    "登出", "logout",
  ],
  database: [
    "数据库", "表", "字段", "索引", "migration", "连接池", "查询",
    "sql", "orm", "prisma", "drizzle", "存储", "schema",
    "database", "table", "column", "index",
  ],
  api: [
    "接口", "api", "路由", "rest", "graphql", "端点", "endpoint",
    "请求", "响应", "cors", "分页", "版本",
  ],
  frontend: [
    "页面", "组件", "ui", "前端", "样式", "css", "tailwind",
    "按钮", "表单", "导航", "路由", "布局", "响应式",
    "frontend", "component", "react", "vue",
  ],
  testing: [
    "测试", "test", "jest", "vitest", "覆盖率", "e2e", "单元测试",
    "集成测试", "mock",
  ],
};

function detectTaskTypes(description: string): string[] {
  const lower = description.toLowerCase();
  const types = new Set<string>();

  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        types.add(type);
        break;
      }
    }
  }

  // Always include general
  types.add("general");

  return Array.from(types);
}

// ---- Main gathering API ----

export function startGathering(taskDescription: string): GatheringState {
  const taskTypes = detectTaskTypes(taskDescription);
  const questions: ChecklistItem[] = [];

  // Collect questions from relevant templates, de-duplicate by key
  const seen = new Set<string>();
  for (const type of taskTypes) {
    const template = TEMPLATES[type];
    if (!template) continue;
    for (const item of template) {
      if (!seen.has(item.key)) {
        seen.add(item.key);
        questions.push(item);
      }
    }
  }

  // Sort: critical first, then important, then nice_to_have
  const priorityOrder = { critical: 0, important: 1, nice_to_have: 2 };
  questions.sort(
    (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
  );

  return {
    questions,
    answers: {},
    skipped: new Set(),
    currentIndex: 0,
    taskDescription,
    taskTypes,
  };
}

/** Get the next batch of questions (up to `batchSize`) to ask the user. */
export function getNextQuestions(
  state: GatheringState,
  batchSize = 3
): ChecklistItem[] {
  const batch: ChecklistItem[] = [];
  let i = state.currentIndex;
  while (batch.length < batchSize && i < state.questions.length) {
    const q = state.questions[i];
    if (!state.answers[q.key] && !state.skipped.has(q.key)) {
      batch.push(q);
    }
    i++;
  }
  return batch;
}

/** True if all critical and important questions are answered or skipped. */
export function isSufficient(state: GatheringState): boolean {
  const unanswered = state.questions.filter(
    (q) =>
      !state.answers[q.key] &&
      !state.skipped.has(q.key) &&
      q.priority !== "nice_to_have"
  );
  return unanswered.length === 0;
}

/** Record an answer to a specific question. */
export function recordAnswer(
  state: GatheringState,
  key: string,
  answer: string
): void {
  state.answers[key] = answer;
  // Advance currentIndex past this question if it was the current one
  const idx = state.questions.findIndex((q) => q.key === key);
  if (idx >= state.currentIndex) {
    state.currentIndex = idx + 1;
  }
}

/** Skip a question (use default value). */
export function skipQuestion(state: GatheringState, key: string): void {
  state.skipped.add(key);
  const q = state.questions.find((q) => q.key === key);
  if (q?.defaultValue) {
    state.answers[key] = q.defaultValue;
  }
  const idx = state.questions.findIndex((q) => q.key === key);
  if (idx >= state.currentIndex) {
    state.currentIndex = idx + 1;
  }
}

/** Skip ALL remaining questions with defaults. */
export function skipAllRemaining(state: GatheringState): void {
  for (const q of state.questions) {
    if (!state.answers[q.key] && !state.skipped.has(q.key)) {
      skipQuestion(state, q.key);
    }
  }
}

/** Produce the structured output for the planner. */
export function finalizeGathering(state: GatheringState): GatheredRequirements {
  const clarifications: Array<{ question: string; answer: string }> = [];

  for (const q of state.questions) {
    const answer = state.answers[q.key];
    if (answer) {
      clarifications.push({ question: q.question, answer });
    }
  }

  return {
    taskDescription: state.taskDescription,
    taskTypes: state.taskTypes,
    answers: { ...state.answers },
    skipped: Array.from(state.skipped),
    clarifications,
    gatheredAt: new Date().toISOString(),
  };
}

/** Get remaining unanswered critical questions count. */
export function remainingCriticalCount(state: GatheringState): number {
  return state.questions.filter(
    (q) =>
      !state.answers[q.key] &&
      !state.skipped.has(q.key) &&
      q.priority === "critical"
  ).length;
}

/** Total progress of answering (0–1). */
export function gatheringProgress(state: GatheringState): number {
  const total = state.questions.length;
  const answered =
    Object.keys(state.answers).length + state.skipped.size;
  return Math.min(answered / total, 1);
}

/** Format the gathered info as a human-readable summary. */
export function formatGatheringSummary(req: GatheredRequirements): string {
  const lines = [
    `**任务**：${req.taskDescription}`,
    `**类型**：${req.taskTypes.join(", ")}`,
    `**已确认决策**：`,
  ];

  for (const c of req.clarifications) {
    const skipped = req.skipped.some((s) =>
      c.question.includes(s) || c.answer.includes("默认")
    );
    const marker = skipped ? "（使用默认值）" : "";
    lines.push(`  - ${c.question.split("？")[0]}？→ ${c.answer} ${marker}`);
  }

  return lines.join("\n");
}
