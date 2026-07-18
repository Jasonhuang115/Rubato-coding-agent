# Rubato Todo

## 1. RAG + 向量数据库改造

将 Mnemosyne 记忆图谱和 Personal Tech Journal 的检索从 SQL LIKE 关键词匹配升级为语义向量检索。

### 1.1 嵌入模型本地部署
- [ ] 下载 ONNX 嵌入模型（`all-MiniLM-L6-v2`，384 维），已有 `embedding/setup.ts` 骨架
- [ ] 实现 `EmbeddingProvider` 接口：`embed(text: string) → Float32Array(384)`
- [ ] 支持批量嵌入（一次 encode 多条文本，减少模型调用开销）
- [ ] 加载/卸载模型生命周期管理（不用时不占内存）

### 1.2 Mnemosyne 向量存储
- [ ] sqlite-vec 建向量表（已有 `memory_vec` 骨架 schema）
- [ ] 实体 upsert 时同步生成 embedding 存入向量表
- [ ] 关系权重变化时更新对应实体的 embedding（可选，成本高）
- [ ] 实现 `searchByVector(vector, limit)` → 返回最相似实体列表
- [ ] 混合检索：向量相似度 + 关系权重 + 衰减系数 加权排序

### 1.3 Journal 向量存储
- [ ] `journal_entries` 表加 `embedding BLOB` 列
- [ ] 写入/更新条目时生成 embedding
- [ ] 实现 `searchByVector(vector, limit)` → 语义相似条目
- [ ] 混合检索：向量相似度 + 访问次数加权

### 1.4 检索策略升级
- [ ] 上下文注入时，query → embedding → 向量搜索替代 LIKE
- [ ] 支持多 query 加权检索（当前消息 + 项目名 + 最近文件）
- [ ] 搜索结果带相似度阈值过滤（低于阈值的噪声丢弃）
- [ ] 降级策略：嵌入模型不可用时 fallback 到 LIKE 搜索

### 1.5 三元组抽取升级
- [ ] 当前是正则 + 关键词词典 → 改为 LLM 抽取
- [ ] Prompt 模板：给定对话摘要 → 提取 (实体, 关系, 实体) 三元组
- [ ] 使用廉价模型（deepseek-chat），后台异步跑，不阻塞会话结束
- [ ] 已有实体的合并更新（同名实体不重复创建，而是增强）

### 1.6 冷启动 Bootstrap
- [ ] 首次打开项目时自动扫描代码（`bootstrap_on_first_open` 配置已有）
- [ ] 提取：文件→函数/类定义、import 依赖关系、package.json 依赖
- [ ] 生成初始 embedding 存入向量库
- [ ] 进度提示 + 可中断

---

## 2. Subagent 子代理系统

将"对话 → 执行"的单一循环扩展为"对话 → 拆解 → 并行/串行子代理执行 → 汇总"的分层架构。

### 2.1 子代理核心
- [ ] `SubagentManager`：创建、管理、销毁子代理实例
- [ ] 子代理类型定义：`explore`（只读搜索）、`implement`（写代码）、`review`（审查）、`research`（调研）
- [ ] 子代理拥有独立的消息上下文（从父代理 fork 必要上下文 + 任务 prompt）
- [ ] 子代理共享父代理的工具注册表（但有权限限制，如 explore 只能 read 类工具）
- [ ] 子代理并发上限控制（默认 min(4, cpu-2)）
- [ ] 子代理超时 + 失败隔离（单点崩溃不影响父代理和其他子代理）

### 2.2 任务拆解
- [ ] `TaskDecomposer`：将用户高层任务拆解为子任务列表
- [ ] 拆解输出：`[{ id, description, agentType, dependsOn, expectedOutput }]`
- [ ] 依赖拓扑排序，无依赖的子代理可并行执行
- [ ] 拆解结果展示给用户确认（Plan 模式集成）

### 2.3 执行编排
- [ ] `SubagentOrchestrator`：按依赖图调度子代理执行
- [ ] 并行阶段：无依赖关系的子代理同时启动
- [ ] 串行阶段：有依赖的等前置完成后启动，前置输出注入后置上下文
- [ ] 结果汇总：所有子代理完成后，汇总 agent 合成最终输出
- [ ] 进度可视化：显示当前运行中的子代理及其状态

### 2.4 子代理与主循环集成
- [ ] 主 Agent 可通过 `Subagent` 工具调用子代理
- [ ] 子代理的输出作为工具结果返回给主 Agent
- [ ] 支持 `/subagent` REPL 命令：查看当前子代理状态
- [ ] 子代理事件（started/done/failed）通过 AgentEvent 流式传递给 UI

### 2.5 子代理工作树隔离（可选）
- [ ] 每个写子代理在独立 git worktree 中执行
- [ ] 完成/失败后自动清理 worktree
- [ ] 变更汇总到主 worktree（合并或展示 diff 给用户确认）

---

## 优先级

| 优先级 | 任务 | 理由 |
|--------|------|------|
| P0 | 1.1 嵌入模型本地部署 | RAG 基础依赖 |
| P0 | 1.2 Mnemosyne 向量存储 | 核心检索升级 |
| P1 | 1.3 Journal 向量存储 | 知识库检索升级 |
| P1 | 1.4 检索策略升级 | 端到端打通 RAG |
| P1 | 2.1 子代理核心 | Subagent 基础 |
| P2 | 2.2 任务拆解 | 编排依赖 |
| P2 | 2.3 执行编排 | 调度执行 |
| P2 | 1.5 三元组抽取升级 | 质量提升 |
| P3 | 1.6 冷启动 Bootstrap | 首次用户体验 |
| P3 | 2.4 主循环集成 | CLI 体验 |
| P4 | 2.5 工作树隔离 | 安全隔离 |
