#!/usr/bin/env npx tsx
// Seed test memories into Mnemosyne for testing search and recall
// WARNING: This writes to your REAL memory database (~/.rubato/mnemosyne/memory.db)
// Only run for testing — do NOT run in production or on your personal data.
// Usage: npx tsx scripts/seed-test-memories.ts

import { getMnemosyneStore, closeMnemosyneStore } from "../src/memory/store.js";

const store = getMnemosyneStore();

console.log("Seeding test memories...\n");

// ---- 1. Manual memories (protected) ----
const manuals: Array<{ title: string; content: string; tags: string[] }> = [
  {
    title: "PostgreSQL 连接池配置",
    content: "生产环境使用 PgBouncer 连接池，max_connections=200，idle_timeout=300s。连接字符串格式：postgresql://user:pass@pgbouncer:6432/dbname",
    tags: ["postgresql", "数据库", "配置"],
  },
  {
    title: "Docker 部署流程",
    content: "1. docker build -t app .  2. docker tag app registry.example.com/app:v1  3. docker push  4. kubectl apply -f deploy.yaml  注意：部署前先跑 migration",
    tags: ["docker", "部署", "devops"],
  },
  {
    title: "TypeScript 严格模式最佳实践",
    content: "strict: true 在 tsconfig.json 中启用。注意 noImplicitAny 和 strictNullChecks 是最重要的两个子选项。迁移老项目时先开 strictNullChecks，再逐步开其他。",
    tags: ["typescript", "配置", "最佳实践"],
  },
  {
    title: "API 错误处理规范",
    content: "统一错误格式：{ error: { code: string, message: string, details?: any } }。HTTP 状态码：400 参数错误，401 未认证，403 无权限，404 未找到，409 冲突，422 验证失败，500 服务器错误。",
    tags: ["api", "错误处理", "规范"],
  },
  {
    title: "React 性能优化 checklist",
    content: "1. useMemo 缓存计算结果  2. useCallback 稳定回调引用  3. React.memo 避免不必要渲染  4. 虚拟列表处理长列表  5. 代码分割 lazy + Suspense  6. 避免在 render 中创建新对象/函数",
    tags: ["react", "性能", "最佳实践"],
  },
  {
    title: "Git 分支策略",
    content: "主干开发：feature branch → PR → code review → squash merge → main。 release 分支从 main 切出，hotfix 从 main 切出合回 main + release。",
    tags: ["git", "流程", "规范"],
  },
  {
    title: "Redis 缓存策略",
    content: "缓存穿透：布隆过滤器。缓存击穿：互斥锁 + 逻辑过期。缓存雪崩：随机 TTL + 多级缓存。key 命名规范：{业务}:{模块}:{标识}，如 user:profile:123",
    tags: ["redis", "缓存", "最佳实践"],
  },
  {
    title: "JWT 鉴权实现",
    content: "access_token 有效期 15min，refresh_token 有效期 7d。access_token 存内存，refresh_token 存 httpOnly cookie。token payload 只放 userId + role，不放敏感信息。",
    tags: ["jwt", "鉴权", "安全"],
  },
];

for (const m of manuals) {
  const id = store.addManualMemory(m.title, m.content, m.tags, "test-seeder", "note");
  console.log(`  📓 [manual] ${m.title} (id=${id})`);
}

// ---- 2. Auto-extracted memories (not protected) ----
const autos: Array<{ name: string; type: "concept" | "config" | "error" | "dependency"; content: string; confidence: number }> = [
  {
    name: "react/useEffect-cleanup",
    type: "concept",
    content: "useEffect 的 return 函数在组件卸载时执行。用于清理定时器、取消订阅、取消请求。忘记清理会导致内存泄漏。",
    confidence: 0.8,
  },
  {
    name: "bug/null-pointer-config",
    type: "error",
    content: "配置对象深层取值时未做空值检查。修复方案：使用可选链 config?.db?.host ?? 'localhost'",
    confidence: 0.9,
  },
  {
    name: "npm/react-scripts-version",
    type: "dependency",
    content: "项目依赖 react-scripts@5.0.1，已知该版本有 source map 泄露问题。建议升级到 5.0.2+ 或迁移到 Vite。",
    confidence: 0.7,
  },
  {
    name: "webpack/bundle-size-optimization",
    type: "config",
    content: "打包体积过大：Lodash 全量引入 72KB → tree-shaking + import 单独函数 → 12KB。moment.js 替换为 dayjs 省 200KB。",
    confidence: 0.85,
  },
  {
    name: "ci/github-actions-timeout",
    type: "config",
    content: "CI 超时原因：测试中使用了真实的第三方 API 调用。修复：Mock 外部服务，增加 jest.setTimeout(30000)。",
    confidence: 0.75,
  },
  {
    name: "sql/n+1-query-problem",
    type: "error",
    content: "ORM 查询 N+1 问题：循环中逐个查询关联数据。修复：使用 eager loading 或 batch query 一次性加载所有关联。",
    confidence: 0.9,
  },
  {
    name: "concept/eventual-consistency",
    type: "concept",
    content: "最终一致性：分布式系统中数据副本不会立即同步，但保证最终会一致。实现方式：消息队列异步同步、CQRS 读写分离。",
    confidence: 0.8,
  },
  {
    name: "docker/node-memory-limit",
    type: "config",
    content: "Node 容器内存限制：docker run --memory=512m。Node 默认堆 1.4GB 但容器只有 512MB 导致 OOMKilled。添加 NODE_OPTIONS=--max-old-space-size=400",
    confidence: 0.85,
  },
];

for (const a of autos) {
  const id = store.upsertEntity(a.name, a.type, a.content, "test-seeder", a.confidence, "auto", 0);
  console.log(`  🤖 [auto]   ${a.name} (id=${id}, confidence=${a.confidence})`);
}

// ---- 3. Relations ----
console.log("\nAdding relations...");
const all = store.getAllEntityIds(50);
if (all.length >= 4) {
  store.addRelation(all[0].id, all[1].id, "RELATED_TO", 0.7, "test");
  store.addRelation(all[2].id, all[0].id, "DEPENDS_ON", 0.5, "test");
  store.addRelation(all[3].id, all[4].id, "ALTERNATIVE_TO", 0.3, "test");
  console.log("  🔗 Added 3 relations");
}

// ---- 4. Stats ----
const stats = store.getStats();
console.log(`\n✅ Done! Store: ${stats.entities} entities | ${stats.relations} relations | ${stats.manualMemories} manual`);

closeMnemosyneStore();
