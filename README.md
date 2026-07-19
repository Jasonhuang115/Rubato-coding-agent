# Rubato

从零构建的 AI Coding Agent。名字来自古典音乐术语 *rubato*（弹性节奏）——好的 Agent 应该适应用户的节奏，而非相反。

**核心理念：有记忆、会追问、懂 Git、能进化。**

> 全文由 Rubato 自己编写，SWE-bench 测试也由 Rubato 自己跑。未调用任何外部 Agent 框架。

## 进度

| 阶段 | 状态 | 内容 |
|------|------|------|
| Phase 1 | ✅ | Agent 骨架：核心循环、12 工具、多提供商、权限、上下文注入 |
| Phase 2 | ✅ | 自进化 RAG + Subagent + 意图树 + Git 顾问 + SWE-bench |
| Phase 3 | ✅ | Agent Runtime：状态机、EventBus、递归 SubAgent、Security Runtime (5 Sandbox)、Prompt 四层架构、ToolRuntime、BudgetManager |

---

## 四大创新

### 1. 自进化 RAG 记忆系统

不是静态 MEMORY.md，而是一个**会自己变聪明**的知识图谱。记忆越用越准——被引用过的记忆自动强化，被忽略的自动降权，过时的自动退休。

**参考论文：**

| 论文 | 借鉴了什么 |
|------|-----------|
| [MemStrata](https://arxiv.org/abs/2606.26511) (2026) | 事实时效管理——同 key 出现新值自动标记旧版过期，不靠向量相似度（AUROC 仅 0.59，接近瞎猜） |
| RecMem (2026) | 懒惰合并——攒够 N 条相似记忆才触发一次 LLM 抽象，省 87% token |
| EvoRAG (2026) | 反馈反向传播——用户引用了某条记忆就回溯给三元组加分，忽略了就降权 |
| SegMem-RAG (AAAI 2026) | 自适应路由——检索策略权重随反馈自动收敛 |

**五维记忆评分：**

```
Evaluator(记忆) = 0.25×准确度 + 0.15×新鲜度 + 0.15×相关度
                + 0.10×冲突度 + 0.15×频率   + 0.20×反馈分
```

- ≥ 0.85 → 升级为"原则"（持久注入 system prompt）
- 0.55–0.85 → 活跃，正常检索
- < 0.15 + 非保护 → 遗忘

**数据流：**

```
Seeder(项目扫描播种) → entities 表
     ↓
每次对话 → Extractor(信号检测) → 新实体 + 自动 embedding
     ↓
会话结束 → FeedbackCollector(引用/忽略标记) → 策略权重自调
     ↓
Consolidator(懒惰合并) → 攒够 3 条相似记忆才触发 LLM 抽象
     ↓
Evaluator(五维评分) → 升级/保留/遗忘
```

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

### 2. Subagent 递归系统

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

### 3. Plan 模式 + Grill Me 意图追踪

防跑偏三阶段闭环：

```
用户需求 → [Grill Me 需求澄清] → [Plan 意图树] → [按树执行]
                                                   ↓
                                       [Grill Me 偏离追踪] ← 每次输入/工具调用
```

- **需求澄清** — 5 类 Checklist（auth/database/API/frontend/testing），反问直达关键决策
- **意图树** — Markdown 序列化到 `.agent/plans/{branch}.md`，跨会话自动恢复
- **偏离追踪** — 3 档灵敏度（strict/normal/loose），文件范围 + 语义 + 依赖三维度检测

### 4. Git 顾问系统

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
npm test              # 158 tests, 9 suites
```

| Suite | 测试 | 覆盖 |
|-------|------|------|
| memory | 35 | CRUD、FTS5、手动记忆、关系、反馈、评分、嵌入、整理 |
| security-sandbox | 55 | Shell/Fs/Network/Git/Env Sandbox + SecurityRuntime 集成 |
| subagent-recursion | 22 | resolveTools 工具链、BudgetManager 资源控制、canSpawn |
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
