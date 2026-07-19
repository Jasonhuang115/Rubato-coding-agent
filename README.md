# Rubato

> 面向个人的编程助手。它记得你的项目、理解你的工作习惯，并在动手前和你把事情想清楚。

Rubato 不是一次性完成指令的代码生成器。它围绕一个人的长期编程工作而设计：跨会话积累项目决策与排障经验，按你的节奏澄清需求、制定计划、执行修改，并把每次有效的记忆反馈给下一次检索。

名字来自古典音乐术语 *rubato*（弹性节奏）——新任务先慢下来理解，目标明确后稳步推进，简单问题则直接回答。

## 为什么是个人助手

长期写代码，真正稀缺的不是再调用一次模型，而是让助手逐渐知道：这个项目为什么这样组织、你偏好怎样取舍、哪些坑刚踩过、哪些改动不该轻易碰。Rubato 把这些上下文留在本地、可检索、可更新，也始终把执行权留给你。

| 你需要的事 | Rubato 的做法 |
|------------|---------------|
| 接续上次工作 | 通过项目级会话、Mnemosyne 记忆图谱和个人知识库恢复上下文 |
| 避免误解需求 | 先澄清关键决策，维护可恢复的意图树，并提醒偏离 |
| 安心执行修改 | 读写与危险操作经过权限策略和五层 Sandbox，Git 操作提供风险说明 |
| 越用越贴合 | 记忆的引用与忽略会回流到检索策略，让下一次更容易找到真正有用的经验 |

## 核心能力

### 长期项目记忆

Rubato 会把对话、项目扫描和手动记录沉淀为本地 SQLite 知识图谱。它保存的不只是文件名，也包括配置、错误、设计决策、依赖关系和可复用的个人经验。

- 同一事实出现新版本时保留历史并标记旧版为 `superseded`，而非直接删除
- 支持 FTS5 全文、向量相似度与图遍历三路检索，RRF 融合后只注入活跃记忆
- 支持 `/remember`、`/memory search` 和 `/journal search`，让重要结论可以显式沉淀

### 先理解，再执行

Plan 模式和 Grill Me 将模糊需求转成可执行计划。它会针对认证、数据库、API、前端、测试等关键决策追问，并在后续输入和工具调用偏离计划时提示你。计划可跨会话恢复，适合需要连续几天推进的个人项目。

### 可控的动手能力

Rubato 提供读写文件、代码搜索、Bash、Web、Git 顾问和可递归的子 Agent。所有工具调用经过统一的 Security Runtime；路径越界、危险 Shell、敏感环境变量、SSRF 和高风险 Git 操作都有独立防线。它会帮你做事，但不替你偷偷越权。

### 贴合个人的 Git 顾问

它不仅能执行 Git 命令，还会根据你的项目状态解释风险：改动是否偏离计划、是否可能和其他分支冲突、某段代码为什么会这样写，以及当前工作流是否符合已观察到的个人习惯和团队协作习惯。

---

## 自进化记忆：让每次对话留下可用经验

Mnemosyne 不是静态的 `MEMORY.md`。它是一个会维护时效、合并重复信息、根据实际回答效果调节检索的本地知识图谱。重点不在“存得更多”，而在于让下一次拿到更合适的上下文。

**参考论文：**

| 论文 | 借鉴了什么 |
|------|-----------|
| [MemStrata](https://arxiv.org/abs/2606.26511) (2026) | 事实时效管理——同 key 出现新值自动标记旧版过期，不靠向量相似度（AUROC 仅 0.59，接近瞎猜） |
| RecMem (2026) | 懒惰合并——攒够 N 条相似记忆才触发一次 LLM 抽象，省 87% token |
| EvoRAG (2026) | 反馈反向传播——用户引用了某条记忆就回溯给三元组加分，忽略了就降权 |
| SegMem-RAG (AAAI 2026) | 自适应路由——检索策略权重随反馈自动收敛 |

**六维记忆评分：**

```
Evaluator(记忆) = 0.25×准确度 + 0.15×新鲜度 + 0.15×相关度
                + 0.10×冲突度 + 0.15×频率   + 0.20×反馈分
```

- ≥ 0.85 → 升级为"原则"（持久注入 system prompt）
- 0.55–0.85 → 活跃，正常检索
- < 0.15 + 非保护 → 遗忘

**从检索到学习的闭环：**

```
项目扫描 / 对话提取 / 手动记录 → entities
                 ↓
查询改写 → FTS5 + Vector + Graph → RRF 融合 → 注入记忆并记录来源
                                                     ↓
回答文本 → 高置信度引用归因（名称、内容片段、路径、API、技术词）
                 ↓                         ↓
             referenced                   ignored
                 ↓                         ↓
        记忆加分 + 来源信用          记忆降分 + 来源信用
                         ↓
           按 session + memory 聚合 → 检索策略权重平滑更新
                         ↓
       懒惰合并 / 时效淘汰 / 六维评分 → 下一次检索
```

归因会在每轮回答后写入，避免长会话压缩丢失信号；中断而没有回答的会话不会把记忆误判为 ignored。多来源结果会分别回溯到 `fts5`、`vector`、`graph`，权重具有样本阈值、平滑更新和安全下限，避免早期噪声让任一路检索失效。

**检索架构（三路 RRF 融合）：**

```
query → generateEmbedding(query)
           ↓
  ┌────────┼────────┐
FTS5全文  向量相似度  图遍历
LIKE搜索  cosine   1-hop邻居
  └────────┼────────┘
           ↓
    RRF 加权融合排序
    (权重随反馈自动调整)
           ↓
    过滤 status=active
    (superseded/deprecated 排除)
           ↓
       Top-5 注入
```

**记忆类型与进化规则：**

| 类型 | 同 key 新值 | 示例 |
|------|-----------|------|
| config / error / api / deploy | 自动 supersede 旧版 | `port=8000` → `port=8080`，旧版标记过期 |
| note / concept / file / function | 合并追加 | 新知识追加到已有实体 |

## 深度工作能力

### Subagent 递归系统

父 agent 可以 spawn 子 agent，子 agent 还可以继续 spawn 孙 agent（最多 3 层）。共享 `agentLoop()` 引擎，换 tool pool 和 system prompt。

```
Parent (depth=0, AgentTool ✅)
  ├─ General (depth=1, canSpawn=true)
  │   ├─ General (depth=2, canSpawn=true)
  │   │   └─ General (depth=3, canSpawn=false — 硬限制)
  │   └─ Explore (canSpawn=false, 只读)
  └─ Verify (canSpawn=false, 对抗性审查)
```

**内置 Subagent 类型**：Explore / General / Verify，均可自定义（`.rubato/agents/*.md`）。支持 background 异步执行 + worktree 隔离。结果自动写回文件，主 agent 在后续 turn 中 Read + merge。

### Plan 模式 + Grill Me 意图追踪

防跑偏三阶段闭环：

```
用户需求 → [Grill Me 需求澄清] → [Plan 意图树] → [按树执行]
                                                   ↓
                                       [Grill Me 偏离追踪] ← 每次输入/工具调用
```

- **需求澄清** — 5 类 Checklist（auth/database/API/frontend/testing），反问直达关键决策
- **意图树** — Markdown 序列化到 `.agent/plans/{branch}.md`，跨会话自动恢复
- **偏离追踪** — 3 档灵敏度（strict/normal/loose），文件范围 + 语义 + 依赖三维度检测

### Git 顾问系统

Agent 定位为信息型顾问，所有写操作需用户确认。

| 模块 | 功能 |
|------|------|
| preflight | Push 前检查远程差异 + 同文件冲突风险 |
| team-radar | 纯本地分析，检测谁在改相同文件 |
| intent-verify | 提交前对比意图树，"你说了改 A 怎么还改了 B？" |
| archaeology | 自然语言查代码历史 |
| semantic-blame | 结合 Mnemosyne 讲述"为什么这么写" |
| conflict-narrator | 冲突时讲双方故事 + 3 种方案 |
| workflow-learner | 自动学习分支命名/PR 大小/合并偏好 |
| newbie-guide | 用当前项目实例解释 Git 概念 |

---

## 快速开始

```bash
git clone git@github.com:Jasonhuang115/Rubato-coding-agent.git
cd Rubato-coding-agent
npm install
npm run build

# API Key（Shell 环境变量优先于 .env 文件）
export DEEPSEEK_API_KEY=sk-your-key
export TAVILY_API_KEY=tvly-your-key   # Web Search

# 全局命令
npm link

# 交互模式
rubato

# 单次执行
rubato -n "帮我写一个 hello world"
```

---

## REPL 命令

| 命令 | 说明 |
|------|------|
| `/plan` | 查看当前意图树 |
| `/plan new <描述>` | 开启需求澄清模式 |
| `/grillme on/off/strict/normal/loose` | 偏离追踪 |
| `/git` / `/git health` | Git 状态 / 分支健康 |
| `/remember <标题>` | 手动存入记忆 |
| `/memory` | 记忆统计 |
| `/memory list` | 查看对话中积累的记忆 |
| `/memory list all` | 查看全部记忆（含自动扫描） |
| `/memory search <q>` | 搜索记忆 |
| `/journal search <q>` | 搜索知识 |
| `/model` | 查看/切换模型 |
| `/help` | 所有命令 |
| `/exit` | 退出 |

---

## 架构

```
src/
├── agent/                   # Agent 核心
│   ├── loop.ts              # Async generator 核心循环
│   ├── subagent.ts          # 递归子 agent 引擎（spawn/worktree/background）
│   ├── agent-defs.ts        # 自定义 agent 加载器
│   ├── read-guard.ts        # 读写守卫
│   └── planner/             # 意图树 + Grill Me
├── cli/                     # 命令行入口 + REPL（含多行输入）
├── context/                 # 优先级上下文注入链
│   ├── system-prompt.ts     # 委托 PromptAssembler
│   └── compression.ts       # MicroCompact + Agent Compact
├── memory/                  # 自进化 RAG（Mnemosyne）
│   ├── store.ts             # SQLite + FTS5
│   ├── evaluator.ts         # 五维评分
│   ├── consolidator.ts      # 懒惰合并
│   ├── embedding/           # trigram-hash (384-dim)
│   └── journal/             # 知识提取 & 回忆
├── model/                   # LLM 提供商（DeepSeek/Anthropic/OpenAI）
├── prompt/                  # 四层 Prompt 架构
│   ├── static.ts            # 静态层（~1200 tokens, 可缓存）
│   ├── capability.ts        # 能力层（~800 tokens, 工具动态）
│   ├── dynamic.ts           # 动态层（~600 tokens, 会话级）
│   └── assembler.ts         # PromptAssembler + ModelProfile + Token 预算
├── runtime/                 # Agent Runtime
│   ├── agent-runtime.ts     # 生命周期容器（状态机 + EventBus）
│   ├── state-machine.ts     # IDLE→PLANNING→EXECUTING→VERIFYING→DONE
│   ├── event-bus.ts         # 类型化 pub/sub
│   ├── tool-runtime.ts      # SandboxedDispatcher
│   ├── budget-manager.ts    # Agent 树资源控制（depth + agent count）
│   └── session/             # JSONL 会话持久化
├── security/                # Security Runtime
│   ├── runtime.ts           # PolicyEngine + CompositeSandbox 统一入口
│   ├── permissions/         # 权限策略（policy/config）
│   └── sandbox/             # 5 层 Sandbox
│       ├── shell-sandbox.ts # 危险模式检测（rm -rf /, mkfs, dd, fork bomb）
│       ├── fs-sandbox.ts    # 路径越界 + symlink 解析 + 敏感路径
│       ├── network-sandbox.ts # SSRF + 私有 IP 拦截
│       ├── git-sandbox.ts   # force-push / hard-reset / clean -fd
│       └── env-sandbox.ts   # API key / secret / token 过滤
├── tools/                   # 12 工具
│   ├── agent.ts             # AgentTool（递归 spawn）
│   ├── fs/                  # Read / Write / Edit / Grep / Glob
│   ├── shell/               # Bash
│   ├── git/                 # Git 顾问系统
│   ├── web/                 # WebFetch + WebSearch
│   ├── mcp/                 # MCP 协议
│   └── registry.ts          # Tool 注册/分发（纯 router）
└── shared/
    └── core-types.ts        # 核心类型
```

---

## 数据存储

```
~/.rubato/                       # 用户级
├── mnemosyne/memory.db          #   记忆图谱 (SQLite)
│   ├── entities                 #     实体（active/superseded/deprecated）
│   ├── relations                #     关系（12 种关系类型）
│   ├── access_log               #     访问记录（驱动衰减）
│   ├── feedback_log             #     反馈信号（驱动进化）
│   ├── strategy_weights         #     检索策略权重（自适应）
│   ├── pending_consolidation    #     待合并组（懒惰合并）
│   └── query_rewrite_rules      #     查询改写规则
├── journal/journal.db           #   个人技术知识库
├── global/memory.db             #   跨项目全局记忆
├── models/                      #   ONNX 嵌入模型
└── soul.md                      #   人格定义
```

---

## 配置

```yaml
# ~/.rubato/config.yml 或 .rubato.yml
model:
  provider: deepseek
  model: deepseek-chat
  maxRetries: 3

permissions:
  bash: auto      # Sandbox 拦截具体危险操作，权限默认放行
  read: auto
  write: auto
  edit: auto
  web: auto

mnemosyne:
  bootstrap_on_first_open: true
  bootstrap_max_files: 500

session:
  cleanupPeriodDays: 30
```

### 自定义 Subagent

`.rubato/agents/*.md`：

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

### MCP 服务器

`.agent/mcp.json` 或 `~/.rubato/mcp.json`：

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-server-filesystem", "/path/to/allowed/dir"]
    }
  }
}
```

---

## 测试

```bash
npm test              # 265 tests, 15 suites
```

| Suite | 测试 | 覆盖 |
|-------|------|------|
| memory | 42 | CRUD、FTS5、手动记忆、关系、反馈、评分、嵌入、整理、引用归因 |
| security-sandbox | 58 | Shell/Fs/Network/Git/Env Sandbox + SecurityRuntime 集成 |
| runtime / prompt / security-policy / capability | 94 | Runtime、Prompt、策略与能力边界回归 |
| agent-loop-lifecycle | 2 | 会话收尾与记忆反馈时序 |
| subagent-recursion / recursive-subagent | 19 | resolveTools 工具链、BudgetManager 资源控制、递归边界 |
| tools | 13 | Read/Write/Edit/Bash/Grep/Glob/Web/Todo |
| context | 10 | CLAUDE.md、Memory.md、Soul、Git Status、Mnemosyne |
| model | 10 | DeepSeek、OpenAI、Anthropic、Router |
| permissions | 9 | 策略引擎、规则匹配、Allow/Deny |
| agent | 8 | AgentLoop、Retry、CircuitBreaker、Compaction |

---

## 技术栈

- **TypeScript** + Node.js (ES2022, ESM)
- **better-sqlite3** — SQLite + FTS5 全文搜索 + WAL 模式
- **trigram-hash embedding** — 384 维，零依赖，本地即时生成，无需 GPU
- **RRF (Reciprocal Rank Fusion)** — 三路检索融合排序
- **openai** v4 + **@anthropic-ai/sdk** — LLM 提供商
- **vitest** — 测试框架

---

## 参考论文

| 论文 | 出处 | 借鉴内容 |
|------|------|---------|
| [MemStrata](https://arxiv.org/abs/2606.26511) | arXiv 2606.26511 (2026) | 事实时效管理——(subject,relation,object) 三元组 supersession，旧版标记过期而非删除 |
| RecMem | 2026 | 懒惰巩固——相似记忆积累 N 次才触发 LLM 合并，省 87% token |
| EvoRAG | 2026 | 反馈反向传播——response-level feedback 回溯到 triplet-level 权重更新 |
| SegMem-RAG | AAAI 2026 | 自适应检索路由——无监督学习优化多源检索策略 |
| [RRF](https://plg.uwaterloo.ca/~gvcormac/cormack06-rrf.pdf) | SIGIR 2009 | Reciprocal Rank Fusion 融合多路检索排序 |

## License

MIT
