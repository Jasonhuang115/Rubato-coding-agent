# Rubato

从零构建的 Coding Agent，核心理念：**新手友好，伴随成长，有记忆**。

灵感来自 Claude Code，但不是替代品——差异化创新点：Subagent 并行系统 + 自进化 RAG 记忆 + 意图树追踪 + Git 顾问。

> 以下全文由 Rubato 编码，也由 Rubato 跑 SWE-bench 测试。没有调用外部 Agent 框架。

## 进度

| 阶段 | 状态 | 内容 |
|------|------|------|
| Phase 1 | ✅ | Agent 骨架：核心循环、9 工具、多提供商、权限、上下文注入 |
| Phase 2 | ✅ | Subagent 系统 + 自进化 RAG + 工作树隔离 + SWE-bench 评测 |

---

## 创新点

### 1. Subagent 系统

父 agent 可以 spawn 子 agent 并行处理任务——共享同一套 `agentLoop()` 引擎，只换 tool pool 和 system prompt。

```
Parent (11 tools, 50 turns)
  ├─ AgentTool → spawnSubagent()
  │   ├─ Explore   (Read/Grep/Glob/Bash, 15 turns)
  │   ├─ General   (all tools minus Agent, 15 turns)
  │   ├─ Verify    (read-only adversarial, 10 turns)
  │   └─ Custom    (.rubato/agents/*.md)
  │       ├─ isolation: "worktree" → git worktree
  │       └─ run_in_background: true → async handle
  └─ 结果自动回到父 agent 上下文
```

- **3 种内置类型** — explore（只读搜索）、general（全工具）、verify（对抗性审查）
- **自定义 agent** — `.rubato/agents/*.md` 用 YAML frontmatter 定义，自动加载
- **工作树隔离** — 子 agent 在独立 git worktree 中运行，互不干扰
- **后台执行** — 异步 spawn，结果写入文件，父 agent 随时 Read 查看
- **转录记录** — 每个子 agent 的 turn 历史存入 SessionStore JSONL

### 2. 自进化 RAG 记忆（Mnemosyne）

不是静态 MEMORY.md，而是一个**会自己进化**的知识图谱。

```
Seeder（项目扫描播种）
  ↓
活跃记忆（FTS5 + 向量 + 图检索）
  ↓
Evaluator（五维评分：准确度 × 新鲜度 × 频率 × 冲突 × 相关度）
  ↓
┌─ 高分 → 升级为"原则"（固定注入）
├─ 中分 → 保持活跃
└─ 低分 + 非保护 → 遗忘
       低分 + 保护 → 保留但不再注入
  ↓
Consolidator（聚类 → 抽象 → 遗忘，每 5 次对话触发）
```

- **统一入口** — 自动提取 + 手动 `/remember` + MEMORY.md 导入 → 同一张 entities 表
- **FTS5 全文搜索** + **向量相似度**（384-dim trigram-hash）+ **图遍历**（1-hop 扩展）
- **RRF 融合** — Reciprocal Rank Fusion 合并三路检索结果，动态权重随反馈调整
- **查询重写** — 失败查询 → 成功检索的映射自动学习
- **Protected 记忆** — 手动上传的知识永不被自动删除
- **播种器** — 首次打开项目自动扫描 package.json、目录结构、Git 历史、配置文件

### 3. Plan 模式 + Grill Me 意图追踪

防止 Agent "跑偏"的核心机制：

```
用户需求 → [Grill Me 需求澄清] → [Plan 意图树] → [按树执行]
                                                    ↓
                                        [Grill Me 偏离追踪] ← 每次输入/工具调用
```

- **需求澄清模式** — 5 类 Checklist（auth/database/API/frontend/testing），反问直达关键决策
- **偏离追踪** — 3 档灵敏度 strict/normal/loose
- **意图树** — Markdown 序列化到 `.agent/plans/{branch}.md`，跨会话恢复

### 4. Git 顾问系统

Agent 是 Git 顾问，不是 Git 执行者。所有写操作需确认。

- **操作解释** — commit/push/merge 前用实际状态解释后果
- **代码考古** — "这个判断条件为什么加？"→ git log → commit message + diff
- **分支健康** — 标记过期分支、需要同步的分支
- **语义 Blame** — 结合 Mnemosyne 告诉你为什么这么写
- **冲突叙事** — "你的 vs 对方的 vs 为什么冲突" + 3 种解决方案

---

## 快速开始

```bash
git clone https://github.com/dengpan19/rubato.git
cd rubato
npm install
npm run build

# 设置 API Key
mkdir -p ~/.rubato
cat > ~/.rubato/.env << 'EOF'
DEEPSEEK_API_KEY=sk-your-key
TAVILY_API_KEY=tvly-your-key   # Web Search
EOF

# 全局命令
npm link

# 启动
rubato
```

## REPL 命令

| 命令 | 说明 |
|------|------|
| `/plan` | 查看当前意图树和进度 |
| `/plan new <描述>` | 开启需求澄清模式 |
| `/grillme on/off/strict/normal/loose` | 偏离追踪控制 |
| `/git` / `/git health` | Git 状态 / 分支健康 |
| `/remember <标题>` | 手动保存到记忆图谱 |
| `/memory stats` | 记忆图谱统计 |
| `/memory search <关键词>` | 搜索记忆图谱 |
| `/journal search <关键词>` | 搜索个人知识（同 /memory） |
| `/exit` | 退出 |

## 配置

```yaml
# ~/.rubato/config.yml 或项目根 .rubato.yml
model:
  provider: deepseek
  model: deepseek-chat
  maxRetries: 3

permissions:
  bash: confirm
  write: confirm
  web: confirm

mnemosyne:
  bootstrap_on_first_open: true   # 首次打开自动扫描项目
  bootstrap_max_files: 500
```

## 自定义 Agent

创建 `.rubato/agents/*.md`：

```markdown
---
name: code-reviewer
description: Expert code reviewer
tools: [Read, Grep, Glob, Bash]
model: inherit
readonly: true
maxTurns: 10
---

You are an expert code reviewer. When reviewing:
1. Check for correctness first
2. Then performance
3. Then style
Report issues with file paths and line numbers.
```

AgentTool 会自动发现并列出所有自定义 agent。

## 架构

```
src/
├── agent/
│   ├── loop.ts              # Async generator 核心循环
│   ├── subagent.ts          # 子 agent spawn + worktree + background
│   ├── agent-defs.ts        # 自定义 agent .rubato/agents/*.md 加载器
│   └── read-guard.ts        # 读写守卫
├── tools/
│   ├── agent.ts             # AgentTool（spawn 子 agent）
│   ├── read/write/edit.ts   # 文件操作
│   ├── bash.ts              # Shell
│   ├── grep/glob.ts         # 搜索
│   ├── web.ts               # WebFetch + WebSearch (Tavily)
│   └── todo.ts              # 任务管理
├── memory/                  # 自进化 RAG
│   ├── store.ts             # SQLite + FTS5 + 反馈日志 + 策略权重
│   ├── seeder.ts            # 项目扫描播种（deps/structure/git/config）
│   ├── evaluator.ts         # 五维评分引擎
│   ├── consolidator.ts      # 聚类 → 抽象 → 遗忘
│   ├── rewriter.ts          # 查询重写学习
│   ├── fusion.ts            # 三路检索 RRF 融合
│   ├── vector-search.ts     # 向量相似度搜索
│   └── extractor.ts         # 三元组自动抽取
├── context/                 # 上下文注入链
│   ├── system-prompt.ts     # 11 模块分层 System Prompt
│   ├── mnemosyne-source.ts  # Mnemosyne 评分过滤注入
│   ├── claude-md/memory-md/soul/git-status.ts
│   └── compression.ts       # MicroCompact
├── embedding/               # 向量嵌入
│   ├── setup.ts             # ONNX 懒下载 + trigram-hash embedding
│   └── generate.ts          # Embedding 生成入口
├── plan/                    # 意图树 & Grill Me
├── git/                     # Git 顾问系统
├── journal/                 # 个人知识提取 & 回忆
├── permissions/             # 权限策略引擎
├── model/                   # 7 个 LLM 提供商
├── session/                 # JSONL 会话持久化
├── cli/                     # 命令行入口 + REPL
└── core-types.ts            # 核心类型
```

## 测试

```bash
npm test              # 85 tests, 6 suites
```

| Suite | 测试 | 内容 |
|-------|------|------|
| memory | 35 | CRUD、FTS5、手动记忆、关系、反馈、评分、嵌入、整理 |
| tools | 13 | Read/Write/Edit/Bash/Grep/Glob/Web/Todo |
| context | 10 | CLAUDE.md、Memory.md、Soul、Git Status、Mnemosyne |
| model | 10 | DeepSeek、OpenAI、Anthropic、Router |
| agent | 8 | AgentLoop、Retry、CircuitBreaker、Compaction |
| permissions | 9 | Auto/Confirm/Manual、Rules、Deny |

## SWE-bench 评测

```bash
# 安装
pip3 install swebench datasets

# 下载数据集 + 跑 N 个实例
bash scripts/swebench-quickstart.sh 10

# 评分（需要 Docker）
python3 -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path predictions.json \
  --run_id rubato-v0.2
```

## 技术栈

- **TypeScript** + Node.js (ES2022, ESM)
- **better-sqlite3** — SQLite + FTS5 + WAL 模式
- **openai** v4 + **@anthropic-ai/sdk** — LLM 提供商
- **vitest** — 测试（85 tests）
- **SWE-bench** — 评测框架

## License

MIT
