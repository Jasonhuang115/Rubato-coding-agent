Rubato — 会追问、有记忆、懂 Git 协作的 AI 编程助手

github.com/jasonhuang115/coding-agent
独立开发  2026.06–至今

- **项目背景**：从零构建的 AI Coding Agent，解决主流 Agent 在企业级生产中的三个盲区——缺乏需求澄清与意图追踪导致"跑偏"、
  跨会话知识完全遗忘无法积累、Git 协作无预警踩坑（冲突/偏离计划/命名不合规）。以古典音乐术语 Rubato（弹性节奏）命名，
  隐喻 Agent 应适应用户而非相反：新任务慢下来追问，确认后稳步执行，快速问题精确秒回。

- **技术栈**：TypeScript, Node.js (ESM), better-sqlite3, OpenAI SDK, Anthropic SDK, vitest, chalk, Tavily API

- **基础 Agent 能力**：实现 Read / Write / Edit / Bash / Grep / Glob / WebFetch / WebSearch / TodoWrite / Plan 十工具，
  读写分离并行调度；Soul → CLAUDE.md → MEMORY.md → Mnemosyne → Git Status 五层优先级上下文注入链；
  WebFetch 实现 HTML→Markdown 实时转换，WebSearch 集成 Tavily API；
  三级错误分类（retry → circuit_breaker → fatal）+ 指数退避 + 六窗口熔断器 + MicroCompact 上下文压缩，
  保障长会话稳定性；交互式 REPL 支持 /plan、/grillme、/git、/journal、/remember、/memory 等斜杠命令。

- **Plan 模式 + 意图树 + Grill Me — 防止 Agent 跑偏**：
  设计需求澄清→结构化计划→偏离追踪三阶段闭环。Grill Me 需求澄清模式在用户描述模糊需求时不急于写代码，
  而是加载 5 类 Checklist 模板（auth / database / API / frontend / testing）多轮反问，直至关键决策点全部覆盖；
  将澄清结果生成为 Markdown 格式意图树（~/.agent/plans/{branch}.md），支持任务层级分解、依赖拓扑标注、
  进度追踪，中断会话后自动恢复；计划锁定后，每次用户输入和 Write 工具调用均在文件范围、语义相关度、
  依赖顺序三个维度检测偏离，三档灵敏度（strict / normal / loose），用户改变主意时自动评估影响范围并重新规划。

- **Git 协作风险预警系统 — 解决企业生产中 Git 易踩的坑**：
  围绕 Git 操作的三大“高发事故区”构建 10 模块预警体系，Agent 定位为信息型顾问（不自动执行写操作）：
  Push 前自动检查目标分支是否有新提交需 rebase、其他本地/远程分支是否修改了相同文件，
  构建文件→分支→修改者的倒排索引评估冲突风险等级；提交前将变更文件与当前意图树的活跃目标做匹配，
  标记非计划范围内的可疑改动（“你说了要改 A，怎么还改了 B？”），防止 WIP 混入；
  通过观察团队 Git 历史自动学习分支命名惯例、PR 大小分布、合并偏好，发现不符合惯例的行为主动提示；
  Merge 冲突发生时分别讲述“你的分支做了什么” vs “对方做了什么”，分析冲突根因并给出三种解决建议。

- **Mnemosyne 记忆图谱 — 跨会话知识积累**：
  基于 better-sqlite3 构建实体-关系-访问日志三表图数据库，支持 12 种关系类型；
  引入记忆衰退机制（weight × e^(-decay_rate × days_since_access)），长期未用的记忆自动降权；
  会话结束时基于规则匹配自动从对话历史抽取三元组，实体合并更新而非简单去重；
  每次会话启动时搜索与当前 query 相关的实体及 1-hop 邻居注入上下文，注入时记录访问以重置衰退。

- **语义 Blame + 代码考古 — 不只告诉你谁写的，还告诉你为什么**：
  对任意代码行调用 `git log -L` 追踪完整变更历史，提取每次修改的 commit message +
  关联 Issue/PR 编号，结合 Mnemosyne 记忆图谱查找历史 Bug 修复记录，
  将多维信息合成为一个完整的叙事：“这行是张三在 commit abc123 加的，当时 Issue #342 报告并发崩溃，
  排查发现连接池无上限 → 后来李四又加了超时重试 → ⚠️ 这个 Bug 在 6 月复现过一次，原因是配置被误改。”
  适用于代码审查、Bug 排查、新人上手理解遗留代码三种场景。

- **个人技术知识库 —“第二大脑”**：
  检测对话中的 20+ 信号短语（“原来如此”“解决方案是”“最佳实践”“TIL”等）自动提取结构化知识条目；
  每次会话启动时搜索相关历史知识注入上下文；
  支持 /remember 手动保存、/journal search 关键词/标签/类型全文检索、Markdown 导出。
