# Rubato 代码架构审计报告（修订版）

## 背景

对项目进行全面架构审查。区分三类问题：

- **🗑️ 真死代码**: 被取代的旧系统、无价值的包装、纯冗余
- **🔌 未接入的规划功能**: 已完整实现但未连入 agent loop 的模块
- **🐛 代码质量问题**: 重复逻辑、类型冲突、坏味道

---

## 第一部分：🗑️ 真正的死代码（建议删除）

### 1. 未使用的 npm 依赖（3 个）

| 依赖 | 引用次数 | 说明 |
|------|---------|------|
| `zod` | 0 | 从未导入，packages.json 残留 |
| `@photostructure/sqlite-vec` | 0（仅注释） | memory/schema.ts 注释中提到但从未实现，且 sqlite-vec 需要 native binary |
| `memfs` | 0 | devDep，测试中从未使用 |

### 2. `journal/store.ts` — 被 Mnemosyne 取代的旧系统

`JournalStore` 是旧的知识库存储（`journal_entries` 表）。现在 `journal/extractor.ts` 和 `recall.ts` 都写入 `getMnemosyneStore()`。

证据链：
- `journal/extractor.ts:2` — `// Phase 2: Extracts to unified Mnemosyne entities table`
- `memory/store.ts:518` — 迁移代码 `this.addManualMemory(..., "journal_migration")`
- `cli/entry.ts:30` — `getJournalStore` 被导入但从未调用

### 3. `model/provider.ts` — 无价值的 re-export shim（15 行）

仅从 `core-types.js` re-export 7 个类型。仅 2 个文件从此导入，而 35+ 文件直接从 `core-types.js` 导入。

```
export type { ModelProvider, ChatParams, StreamEvent, TokenUsage } from "../core-types.js";
export type { Message, ContentBlock, ToolDefinition } from "../core-types.js";
```

### 4. `memory/schema.ts` — Phase 1 残余接口（79 行）

定义了 `MemoryStore` 接口和 `getMemoryStore`/`setMemoryStore` placeholder。但实际使用的 `MnemosyneStore` 用自己的 `getMnemosyneStore()` 单例。`getMemoryStore`/`setMemoryStore` 调用次数为 0。

### 5. 重复的类型定义（同名不同义）

| 类型名 | 位置 1 | 位置 2 | 冲突 |
|--------|--------|--------|------|
| `SessionRecord` | `core-types.ts:217` (JSONL 行: `{type, timestamp, data}`) | `session/manager.ts:12` (会话索引: `{id, createdAt, ...}`) | **同名，完全不同结构** |
| `PermissionRule` | `core-types.ts:132` (`action: "allow" \| "deny" \| "ask"`, `reason?`) | `permissions/config.ts:101` (`action: "allow" \| "deny"`, `reason` 必填) | **不兼容** |
| `SessionIndexEntry` | `core-types.ts:227` | `session/manager.ts:12` (叫 `SessionRecord`) | **完全相同的字段，两个名字** |

### 6. 重复的辅助函数

| 函数 | 出现位置 | 次数 |
|------|---------|------|
| `resolvePath()` | read.ts, write.ts, edit.ts, grep.ts, glob.ts | 5x 完全相同 |
| `normalizePath()` | registry.ts | 1x 近似 |
| `isGitRepo()` | git/advisor.ts, context/git-status.ts, agent/subagent.ts | 3x |
| `gitExec()` | git/advisor.ts, context/git-status.ts | 2x |
| `getDefaultBranch()` | branch-health.ts, preflight.ts, team-radar.ts | 3x |
| `getModifiedFiles()` | preflight.ts, team-radar.ts | 2x |
| `countLeaves()` | plan/tree.ts, plan/manager.ts, plan/grillme.ts | 3x |

### 7. 未使用的导入

| 文件 | 导入 | 行号 |
|------|------|------|
| `agent/loop.ts` | `TextBlock` | 12 |
| `agent/loop.ts` | `ToolResultBlock` | 14 |
| `agent/loop.ts` | `StreamEvent` | 15 |
| `agent/loop.ts` | `getReadTools`, `getWriteTools` | 21 |
| `tools/bash.ts` | `exec` (from child_process) | 3 |
| `tools/plan.ts` | `getGrillMeConfig` | 6 |
| `model/openai-compat.ts` | `TokenUsage`（导入但用内联字面量） | 11 |
| `cli/entry.ts` | `getJournalStore`（导入从不调用） | 30 |

### 8. 从未调用的死导出

#### session/meta.ts — 整个 MetaConsumer 系统 + 3 个函数
- `registerMetaConsumer()`, `notifyConsumers()`, `MetaConsumer` 接口 — 零调用
- `updateSessionMeta()`, `recordFileAccess()`, `addTokens()` — 零外部调用
- 只有 `createSessionMeta()` 和 `finalizeSessionMeta()` 实际在使用

#### agent/
- `agent-defs.ts`: `getCustomDefinitions()` — 从未导入
- `subagent.ts`: `EXPLORE_DEF`, `GENERAL_DEF`, `VERIFY_DEF` — 仅内部 map 使用，不需要 export

#### tools/
- `todo.ts`: `getTodos()`, `clearTodos()` — 仅测试引用
- `plan.ts`: `PLAN_DIR` 常量 — 未被引用（tree.ts 有自己的）

#### plan/
- `planner.ts`: `revisePlan()` — 从未调用
- `gatherer.ts`: `getNextQuestions()`, `remainingCriticalCount()`, `gatheringProgress()`, `formatGatheringSummary()` — 4 个死导出
- `tree.ts`: `getProgress()`, `getNodePath()`, `archivePlan()` — 3 个死导出
- `grillme.ts`: `DeviationAction` 接口 — 仅内部使用

#### skills/
- `registry.ts`: `findSkillSubagentDef()` — 从未导入
- `loader.ts`: `scanSkillsDir()`, `loadSkillPlugin()` — 从未导入

#### context/
- `compression.ts`: `CompactSummary`, `SnipOptions`, `DEFAULT_SNIP_OPTIONS` — 从未导入
- `compression.ts`: `snipContent()`, `snipLines()` — 仅测试引用
- `sources.ts`: `ContextChain.remove()`, `ContextChain.getSources()` — 从未调用
- `micro-compact.ts`: `MicroCompactResult` — 从未导入

#### embedding/
- `setup.ts`: `EmbeddingSetupResult`, `getModelDir()` — 从未导入
- `generate.ts`: `generateBatch()`, `isOnnxReady()` — 从未导入

#### journal/
- `recall.ts`: `recallOnMessage()`, `detectKnowledgeGaps()` — 从未导入
- `extractor.ts`: `manualRemember()` — 从未导入

#### git/advisor.ts（即使是在用的文件里）
- `adviseCommit()`, `advisePush()`, `advisePull()`, `adviseMerge()`, `adviseDestructive()`, `explainConcept()`, `AdvisoryResult` — 7 个死导出

#### memory/
- `evaluator.ts`: `getForgetCandidates()` — 从未导入
- `seeder.ts`: `importMemoryMd()` — 从未导入

### 9. 死配置项

| 配置 | 加载位置 | 消费者 |
|------|---------|--------|
| `config.model.maxRetries` | config-loader.ts:135 | **无** — 未传递给任何 provider |

### 10. `embedding/setup.ts` — ONNX 模型下载路径死代码

`setupEmbeddingInfrastructure()` 下载 `all-MiniLM-L6-v2` ONNX 模型 (~90MB)，但 `generateSimpleEmbedding()` 使用纯 trigram hash 不需要 ONNX。下载的模型从未被加载。

**但 embedding 模块本身是有用的**：`generateSimpleEmbedding` 和 `cosineSimilarity` 被 memory 系统实际使用。

---

## 第二部分：🔌 未接入的规划功能（建议接入，非删除）

这些模块都是**完整实现的高质量代码**，只是还没连入 agent loop。

### Git 智能系统（8 个模块，~2000 行）

| 模块 | 功能 | 触发时机 |
|------|------|---------|
| `archaeology.ts` | "这行为什么这么写" → 追溯提交历史 → 用大白话解释 | 用户询问代码历史 |
| `conflict-narrator.ts` | 冲突时讲述双方分支的故事 + 建议 | merge/rebase 冲突 |
| `intent-verify.ts` | "你说只改 A，怎么还动了 B？" 对照 plan 审查改动 | commit 前 |
| `newbie-guide.ts` | 用当前项目实例解释 git 概念 | 用户问 git 问题 |
| `preflight.ts` | push 前检查：remote ahead/behind、其他人是否在改相同文件 | push 前 |
| `semantic-blame.ts` | 结合 git log + commit message + memory graph 解释 WHY | 用户问代码原因 |
| `team-radar.ts` | "小心，张三也在改同一个文件" — 纯本地分析 | 实时 |
| `workflow-learner.ts` | 观察团队 git 模式，学习分支命名、PR 大小、merge 偏好 | 后台 |

**当前状态**: 只有 `advisor.ts`（git 基础操作）和 `branch-health.ts`（分支健康）被 `entry.ts` 调用。其他 8 个模块完整实现但未接入。

**建议**: 在 `agent/loop.ts` 的工具执行阶段或 git 操作检测点调用这些模块。

### MCP 协议系统（3 个模块，~350 行）

| 模块 | 功能 |
|------|------|
| `types.ts` | JSON-RPC 消息类型、Tool/Resource 定义 |
| `client.ts` | MCP 客户端（连接、握手、工具调用） |
| `adapter.ts` | MCP Tool → Rubato ToolDefinition 适配器 |

**当前状态**: 完全未接入。`entry.ts` 不加载 MCP 配置，`registry.ts` 不注册 MCP 工具。

**建议**: 在 `entry.ts` 启动流程中加载 MCP 配置，通过 `adaptMcpServerTools()` 将外部 MCP server 的工具注册到工具注册表。

### Memory 高级检索系统（5 个模块，~650 行）

| 模块 | 功能 | 状态 |
|------|------|------|
| `fusion.ts` | 多策略混合检索（vector + FTS5 + graph），RRF 融合排序 | 未接入 |
| `vector-search.ts` | 向量相似度搜索 | 仅被 fusion 调用 |
| `rewriter.ts` | 查询改写（学习用户反馈） | 仅被 fusion 调用 |
| `global.ts` | 跨项目知识图谱（用户偏好、经验教训） | 未接入 |
| `extractor.ts` | 会话后三元组抽取 (entity, relation, entity) | 未接入 |

**当前 memory 核心已在使用**:
- `store.ts` — MnemosyneStore，通过 `getMnemosyneStore()` 被 evaluator、consolidator、seeder、mnemosyne-source、journal、entry.ts 使用
- `evaluator.ts` — 记忆评估/注入候选，被 mnemosyne-source 使用
- `consolidator.ts` — 记忆合并，被 agent/loop.ts 动态导入
- `seeder.ts` — 启动时从代码库 bootstrap 记忆，被 entry.ts 动态导入

**建议**: 将 fusion/global/extractor 接入 agent loop：
- `fusion.hybridRetrieve()` → 替换 mnemosyne-source 中的单一检索路径
- `global.recordPreference()` → 在用户反馈或 session 结束时调用
- `extractor.extractTriples()` → post-session 分析

---

## 第三部分：🐛 代码质量问题

### 11. `model/deepseek.ts` 与 `openai-compat.ts` 重复的转换器

两个文件各自实现了几乎相同的 `convertMessages()` 和 `convertTools()`（~60 行）。`openai-compat.ts` 注释说 "shared with deepseek"，但实际上从未共享。

### 12. `dist/` 应加入 .gitignore

编译产物不应受版本控制。`dist/` 目录包含 .d.ts 和 .js 文件。

### 13. tsconfig.json 冗余

- `declarationMap: true` — CLI 应用不需要
- `sourceMap: true` — CLI 不需要
- `exclude: ["test"]` — 已被 `include: ["src/**/*.ts"]` 隐式排除

### 14. 不一致/坏味道

- `system-prompt.ts`: 章节编号混乱（第 7 节出现两次、第 10 节出现两次、第 9 节缺失）
- `soul.ts:13`: `_ctx` 参数用 `_` 前缀表示未使用但实际在第 23 行使用了
- `config-loader.ts`: 项目级 YAML 解析错误 → console.warn；家目录 YAML 解析错误 → 静默吞掉
- `.env.example`: 声明 8 个 provider 但只为 3 个提供 API key 模板
- `context/git-status.ts` 自己实现了 `gitExec`/`gitIsRepo` 而不从 `git/advisor.ts` 导入
- `agent/subagent.ts` 自己实现了 `isGitRepo` 而不从 `git/advisor.ts` 导入
- `entry.ts` 1147 行过大，混合了参数解析、REPL、PlanManager、会话、技能加载等多种职责
- `SubagentDefinition.readonly` 字段从未被 `resolveTools()` 实际执行

### 15. 测试失败（3 个）

```
FAIL  test/memory.test.ts — 2 failed
FAIL  test/permissions.test.ts — 1 failed
```

---

## 建议清理方案

### 立即删除（零风险）

| 优先级 | 操作 | 删除行数 |
|--------|------|---------|
| 1 | `npm uninstall zod @photostructure/sqlite-vec memfs` | package.json 3 行 |
| 2 | 删除 `journal/store.ts` | ~100 行 |
| 3 | 删除 `model/provider.ts`（2 个 import 改为从 core-types） | 15 行 |
| 4 | 删除 `memory/schema.ts` | 79 行 |
| 5 | 删除所有未使用的导入 | 9 行 |
| 6 | 删除所有死导出（见列表） | ~40 处 |
| 7 | 提取 `resolvePath()` 到共享模块 → 5 个文件去重 | 净减少 ~20 行 |
| 8 | 统一 `isGitRepo`/`gitExec` 到 advisor.ts → 2 个文件改用 import | 净减少 ~30 行 |
| 9 | 清理 core-types.ts 死类型 + 合并重复类型定义 | ~20 行 |
| 10 | `dist/` 加入 .gitignore | 1 行 |

### 计划接入（保留代码，需要架构决策）

| 优先级 | 操作 | 说明 |
|--------|------|------|
| G1 | 接入 git 8 模块 | 需要在 agent loop 中确定触发点 |
| G2 | 接入 MCP 模块 | 需要在 entry.ts 加载 MCP 配置 + 注册工具 |
| G3 | 接入 memory 高级模块 | fusion/global/extractor 连入 agent loop |
| G4 | ONNX 嵌入推理 | 替换 trigram hash 为真正的语义向量 |

### 低优先级（代码质量）

| 优先级 | 操作 |
|--------|------|
| Q1 | 提取 `deepseek.ts`/`openai-compat.ts` 共享转换器 |
| Q2 | 提取 `getDefaultBranch()` 3x, `countLeaves()` 3x |
| Q3 | tsconfig.json 优化 |
| Q4 | 章节编号、命名统一 |
| Q5 | 修复 3 个测试失败 |
| Q6 | `SubagentDefinition.readonly` 实际生效 |

---

## 估算

| 类别 | 净删除 |
|------|--------|
| 真死代码（npm + journal/store + provider.ts + schema.ts + 死导出/导入 + 重复） | ~400 行 |
| 保留但需接入的功能代码（git 8 + MCP 3 + memory 5） | 0 行删除，~3000 行保留 |
| 代码质量改进 | ~30 行净减少 |
| **总计删除** | **~430 行** |
| **总计保留（接入后可用）** | **~3000 行功能代码** |
