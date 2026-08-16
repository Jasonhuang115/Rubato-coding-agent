# Rubato 记忆系统面试档案

> 目标：能够从旧 SQLite 自进化 RAG 讲到当前文件式记忆，区分论文指标、项目实现和项目实测。

## 1. 必须统一的术语

- 旧系统名：Mnemosyne / 自进化 RAG，不是“Rocket”。
- 当前系统名：verified file memory / 文件式长期记忆。
- 旧系统的“动态”包括：访问时间衰减、反馈强化/降权、检索策略权重更新、事实 supersession、触发式巩固和遗忘候选。
- 当前系统仍有半衰期和 outcome utility，但 belief confidence、recall match 和 utility ranking 被刻意分离。

## 2. 旧 SQLite 系统：实际实现

### 存储

- `better-sqlite3`，WAL 模式，启用 foreign keys。
- `entities`：类型、名称、内容、来源 session、来源类型、protected、tags、confidence、时间、384 维 embedding、status、superseded_by、abstracted_from、feedback_score、access_count。
- `relations`：实体边和 relation type。
- `access_log`：访问时间。
- `entities_fts`：FTS5 索引。
- `feedback_log`：injected/referenced/ignored/user_corrected/tool_success/tool_failed，以及 retrieval source。
- `pending_consolidation`：相似记忆组和触发次数。
- `strategy_weights`：fts5/vector/graph 的权重、调用数和成功数。
- `query_rewrite_rules`：历史有效的查询改写。

### 写入

- Seeder 扫描项目并播种实体。
- 会话 Extractor 用规则从对话提取文件、函数、概念和关系三元组。
- `upsertEntity`：对 config/error/api/deploy 等时效事实，同 name+type 出现新内容时把旧实体标为 `superseded` 并创建新实体；普通 note/concept 则合并内容。
- 每个实体生成 384 维 trigram-hash + word-hash 向量并 L2 归一化。虽然代码会下载 MiniLM ONNX 文件，历史 `generate()` 实际调用的是本地 hash embedding，不是神经语义 embedding。

### 检索

- Query rewriter 生成规则变体和已学习变体。
- 三路检索：FTS5、hash-vector cosine、从 FTS5 top results 做图邻居扩展。
- 使用加权 RRF：`weight / (60 + rank)` 聚合三路排名。
- 默认权重：FTS5 0.5、Vector 0.3、Graph 0.2。
- 过滤 `superseded` / `deprecated`，取 Top-K 注入上下文。

### 动态衰减与反馈

- 时间衰减示例：`decay = exp(-0.01 * days)`；检索相关度结合 confidence、decay 和 name match。
- referenced 记忆累计 `+0.1`，ignored 记忆累计 `-0.05`。
- retrieval source 至少积累 5 个样本后，以引用命中率更新策略权重。
- query 有帮助时，根据命中实体名称/内容学习改写规则。
- protected 手动记忆不自动删除；旧且未访问的非保护记忆可被 prune。

### 评分和巩固

- 历史 README 称“五维评分”，但代码实际使用六个信号：accuracy 0.25、freshness 0.15、relevance 0.15、conflict 0.10、frequency 0.15、feedback 0.20。
- 阈值：`>=0.85` 且访问次数足够可 upgrade；`>=0.55` inject；`<0.15` 且非保护可 forget。
- 相似组累计到 3 次进入 pending consolidation；早期实现使用规则式聚类/抽象，后续提交增加 LLM consolidation。

## 3. 论文映射与指标归属

### 三条核心参考

1. MemStrata：事实时间有效性和 deterministic supersession。论文报告 cosine 区分 contradiction/duplicate 的 AUROC 0.59，并报告 evolving knowledge 上显著降低 stale-fact error。
2. RecMem：recurrence-gated consolidation。论文报告相对部分 eager memory baseline，memory construction token 最多降低约 87%。
3. EvoRAG：把 response-level feedback 归因回 KG paths/triplets。论文报告相对 KG-RAG baseline reasoning accuracy 提升 7.34%。

### 辅助参考

- SegMem-RAG：根据经验在多个语料库间自适应路由。
- RRF：融合不同检索器的排名。

### 面试红线

- 上述 0.59、87%、7.34% 都是论文结果，不是 Rubato 自己的指标。
- Rubato 旧系统有单元测试覆盖 CRUD、FTS5、图遍历、反馈、权重、查询改写、评分、embedding 和 consolidator，但没有找到端到端长期记忆 benchmark，不能声称实测“越用越准”。

## 4. 为什么放弃旧方案

- 问题从“海量文档的语义召回”误建模成了“用户偏好和项目事实的生命周期管理”。
- 语义/词法相似不等于任务相关，也不能表达 authority、scope、current request precedence、conflict 和 supersession。
- referenced/ignored 的归因容易受回答措辞影响；早期样本少，策略权重自调可能放大噪声。
- Top-K 自动注入会把看似相似但无用的内容塞入上下文。
- SQLite/FTS/vector/graph/RRF/rewriter/evaluator/consolidator 复杂度高，但缺少端到端指标证明收益。
- 数据库不便于用户直接审计、纠正、版本对比、回滚和验证隐私删除。
- 旧 hash embedding 更接近词法特征，不应包装成强语义检索。

## 5. 当前文件式系统：一条记忆的主链

1. 用户消息写入 hash-chained session JSONL。
2. Fast path 提取明确、低风险的 remember/preference/constraint/goal/correction；复杂推断等待 Dream。
3. Observation 必须绑定用户事件的 sessionId、seq、hash；assistant/tool 不能贡献用户 belief 权重。
4. 按 logical key、scope、polarity 和 signal weight 归并 evidence；非固定 evidence 使用半衰期衰减。
5. Reducer 产生 ADD/REINFORCE/CONTEXTUALIZE/SUPERSEDE/CONFLICT/NOOP 等结构化 operation。
6. Operation 写为 candidate，具有 pending/review/rejected/published、risk 和 evidence ids。
7. 明确低风险用户事实可走确定性发布；冲突、敏感或推断内容进入 review/Dream。
8. Publisher 获取文件锁并做 CURRENT CAS，在 staging 构建全新不可变 release。
9. Release 生成 cards、catalog.tsv、PROFILE.md、INDEX.md、manifest.json、manifest.sha256；全部验证后原子切换 CURRENT。
10. 新会话只加载校验通过的 CURRENT：bounded PROFILE 常驻、repository facts 只注入标题索引、详细 card 通过 Grep/Read 按需读取。
11. correct 创建 revision 并 supersede；retire 可逆；undo 创建指向历史状态的新 release；hard purge 清理所有派生副本并写防复活 ledger。

## 6. 当前系统关键决策

- 用户画像与仓库事实分 authority：只有用户原话能支持用户 belief；repository scanner 的事实只作为 reference。
- 明确事实走无模型 fast path；推断走异步 Dream，且 LLM 只能提议，不能直接推进 CURRENT 或删除。
- belief confidence 与 outcome utility 分离：效果只能对已经文本匹配的卡片重排，不能把猜测变成事实或扩张召回集合。
- 同一会话重复表达只取最强证据，防止复读刷权重。
- 当前请求、安全规则和工作树事实始终优先于历史记忆。

## 7. 仍需准备的面试展开

- 2 分钟总述。
- 旧系统一条记忆从写入到召回的例子。
- 当前系统一条 explicit preference 的完整例子。
- 当前系统一条 inferred habit 的 Dream 例子。
- 冲突、纠正、退役、回滚、hard purge 的区别。
- 为什么文件系统不等于“直接写一个 MEMORY.md”。
- 并发发布、原子性、崩溃恢复和安全边界。
- 如何设计端到端评测：precision/recall、stale fact、personalization、context cost、false memory、deletion completeness。

