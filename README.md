# coding-agent

从零构建的 Coding Agent，核心理念：**新手友好，伴随成长，有记忆**。

灵感来自 Claude Code，但不是它的替代品——而是专注于四个差异化创新点：需求澄清与意图树追踪、结构化知识记忆、Git 顾问、个人技术知识库。

**Phase 1 + Phase 2 已完成** — 完整的 Agent 骨架 + 四大创新模块，50 个测试全部通过。

## 进度

| 阶段 | 状态 | 内容 |
|------|------|------|
| Phase 1 | ✅ 完成 | Agent 骨架：核心循环、9 工具、多提供商、权限、上下文注入 |
| Phase 2 | ✅ 完成 | 四大创新：意图树 & Grill Me、Mnemosyne 记忆图、Git 顾问、技术 Journal |

---

## 四大创新点

### 1. Plan 模式 + 意图树 + Grill Me

防止 Agent "跑偏"的核心机制：

```
用户提出需求
  ↓
[Grill Me — 需求澄清]  AI 反问确认，直到信息充分
  ↓
[Plan 模式 — 生成意图树]  结构化计划 → .agent/plans/{branch}.md
  ↓
[按意图树执行]  依赖排序，逐步实现
  ↓
[Grill Me — 偏离追踪]  每次输入/工具调用检查是否偏离计划
  ↓
用户改变主意 → 更新意图树 → 重新计算依赖 → 继续
  ↓
跨会话 → 自动恢复未完成的计划
```

**Grill Me 两种模式：**
- **需求澄清模式** — 用户提出模糊需求时，AI 不急于写代码，而是加载对应 Checklist（auth/database/API/frontend/testing），持续追问直到关键决策点都被覆盖。用户可随时说"先按默认方案来"跳过剩余问题。
- **偏离追踪模式** — 计划锁定后，每次用户输入和写工具调用都会检查是否偏离。3 档灵敏度：`strict`（任何计划外操作都提醒）、`normal`（持续偏离才提醒）、`loose`（只拦明显跑偏）。

**意图树 Markdown 格式：**
```markdown
# Plan: 用户认证系统
**Status:** in_progress | **Progress:** 3/7 | **Updated:** 2026-07-15

## Tasks
- [ ] 数据库层 — users 表
  - [x] 创建 users 表（含索引和约束）
- [ ] 业务逻辑 **← current**
  - [ ] POST /register 注册接口
  - [ ] POST /login 登录接口
- [ ] 认证中间件 (depends: root/1/2)
- [ ] 安全加固 ⛔
```

### 2. Mnemosyne 记忆图谱

超越静态 MEMORY.md 的结构化知识网络。

- **三元组存储** — `(entity) → [relation] → (entity)` 模型：文件、函数、类、概念、错误、配置等作为节点，关系包括 `DEPENDS_ON`、`FIXED_BY`、`IMPLEMENTS`、`CONFIGURES`、`TESTED_BY` 等
- **记忆衰退** — `weight × exp(-decay_rate × days_since_access)`，长期不使用自动降权
- **自动提取** — 会话结束时从对话历史中提取三元组，规则匹配 + 关键词抽取
- **上下文注入** — 每次对话开始时，搜索与当前 query 相关的实体及 1-hop 邻居，注入 system prompt
- **跨项目全局记忆** — `~/.coding-agent/global/` 记录用户偏好（技术栈、命名风格、工具选择）

### 3. Git 顾问系统（信息型，不自动执行）

Agent 是 Git 顾问，不是 Git 执行者。所有写操作必须用户明确确认。

**面向新手：**
- **操作拦截与解释** — 当用户说"帮我提交"时，先展示当前状态（分支、变更文件、远程对比），用通俗语言解释接下来会发生什么，再询问确认
- **Git 概念解释** — 用当前项目的实际状态解释 rebase/merge/stash/reset 的区别，而非教科书定义

**面向中级：**
- **Push 前检查** — 自动检查目标分支是否有新提交（需 rebase）、其他分支是否有冲突风险、本地测试是否跑过
- **分支健康检查** — 会话开始时注入分支摘要，标记过期分支和需要同步的分支

**面向所有用户：**
- **代码考古** — 自然语言查询代码历史："这个判断条件为什么加？"→ 追踪 git log → 展示 commit message + diff + 关联 issue
- **语义 Blame** — 传统 `git blame` 只告诉你谁写的，我们结合 Mnemosyne 告诉你为什么这么写、当时修了什么 bug、后来又有谁改过
- **提交意图验证** — 对比意图树和实际变更文件，提醒"你说了要改 A，怎么还改了 B？"
- **团队协作雷达** — 纯本地分析，检测远程分支是否有其他人修改了相同的文件，评估冲突风险
- **工作流自学习** — 观察团队 Git 行为，自动学习分支命名规则、PR 大小习惯、合并偏好
- **Merge 冲突叙事** — "你的分支做了什么" vs "对方分支做了什么" vs "为什么冲突"，给出 3 种解决建议

### 4. 个人技术知识库（Personal Tech Journal）

在日常对话中积累技术知识，变成专属"第二大脑"。

- **自动提取** — 检测对话中的信号短语（"原来如此"、"这个 bug 是因为"、"解决方案是"、"最佳实践"等），自动提取为结构化知识条目
- **触发式回忆** — 每次会话开始时用当前 context 搜索知识库，找到高度相关的历史知识自动注入
- **手动保存** — `/remember <标题>` 随时保存
- **全功能搜索** — 按关键词、标签、类型、项目搜索；支持全文检索
- **知识导出** — 导出为 Markdown 文件

---

## 快速开始

```bash
# 安装
git clone https://github.com/dengpan19/coding-agent.git
cd coding-agent
npm install
npm run build

# 设置 API Key（也可放在 .env 文件中）
export DEEPSEEK_API_KEY=sk-xxx
export ANTHROPIC_API_KEY=sk-ant-xxx
export OPENAI_API_KEY=sk-xxx
export TAVILY_API_KEY=tvly-xxx  # Web Search 需要

# 交互模式（默认）
npm run dev

# 单次执行
npm run dev -- -n "帮我写一个 hello world"

# 指定提供商和模型
npm run dev -- -p anthropic -m claude-sonnet-4-20250514 "重构这个文件"

# 管道输入
echo "解释这个函数" | coding-agent -n
```

## REPL 命令

交互模式下可用的斜杠命令：

### 意图树 & Grill Me

| 命令 | 说明 |
|------|------|
| `/plan` | 查看当前意图树和进度 |
| `/plan new <描述>` | 开启需求澄清模式，AI 会多轮反问确认细节 |
| `/plan list` | 列出所有已保存的计划 |
| `/plan done` | 标记当前计划完成并归档 |
| `/grillme` | 查看 Grill Me 状态（开关 + 灵敏度） |
| `/grillme on` / `off` | 开启 / 关闭偏离追踪 |
| `/grillme strict` | 严格模式 — 任何计划外操作都提醒 |
| `/grillme normal` | 默认模式 — 持续偏离才提醒 |
| `/grillme loose` | 宽松模式 — 只拦明显跑偏 |

### Git

| 命令 | 说明 |
|------|------|
| `/git` | 显示当前 Git 状态（分支、变更文件、领先/落后远程、最近提交） |
| `/git health` | 分支健康检查 — 哪些过期了、需要同步、状态异常 |

### 知识库 & 记忆

| 命令 | 说明 |
|------|------|
| `/journal` | 查看最近 5 条知识 |
| `/journal search <关键词>` | 搜索个人技术知识库 |
| `/journal stats` | 知识库统计（总数、类型分布、热门标签） |
| `/remember <标题>` | 手动将当前上下文保存到知识库 |
| `/memory` | Mnemosyne 记忆图谱统计（实体数、关系数） |
| `/memory search <关键词>` | 搜索记忆图谱中的实体和关系 |

### 通用

| 命令 | 说明 |
|------|------|
| `/help` | 显示所有命令 |
| `/exit` / `/quit` | 退出 |
| `Ctrl+C` | 退出 |

## 配置

### API Key

支持两种方式设置 API Key（优先级：Shell 环境变量 > `.env.local` > `.env`）：

```bash
# 项目级 .env 文件（推荐，不要提交到 Git）
echo 'DEEPSEEK_API_KEY=sk-xxx' > .env
echo 'TAVILY_API_KEY=tvly-xxx' >> .env

# 全局 .env（对所有项目生效）
echo 'DEEPSEEK_API_KEY=sk-xxx' > ~/.coding-agent/.env
```

### config.yml

在项目根目录或 `~/.coding-agent/config.yml` 创建：

```yaml
model:
  provider: deepseek              # deepseek | openai | anthropic | groq | openrouter | ollama
  model: deepseek-chat
  baseURL: https://custom.com/v1  # 可选：自建代理
  maxRetries: 3

permissions:
  bash: confirm                   # auto | confirm | manual
  read: auto
  write: confirm
  edit: confirm
  web: confirm
  rules:                          # 可选：细粒度规则
    - tool: bash
      pattern: "npm test"
      action: allow
    - tool: bash
      pattern: "rm -rf"
      action: deny

embedding:
  source: local_onnx              # local_onnx | api (Phase 2: 向量检索)

mnemosyne:
  bootstrap_on_first_open: true
  bootstrap_max_files: 50

session:
  cleanupPeriodDays: 30
```

### 命令行参数

```
coding-agent [options] [prompt]

Options:
  -d, --dir <path>    工作目录（默认：当前目录）
  -m, --model <name>  模型名称
  -p, --provider <n>   提供商
  -n, --one-shot      单次执行后退出（非交互模式）
  -h, --help          帮助
```

---

## 架构

```
src/
├── agent/              # Async generator 核心循环
│   ├── loop.ts         #   主循环：流式调用 → 工具执行 → 偏离检查 → 等待输入
│   └── read-guard.ts   #   读写守卫
├── model/              # ModelProvider 接口 + 7 个实现
│   └── router.ts       #   自动路由
├── tools/              # 9 个工具
│   ├── read.ts, write.ts, edit.ts   # 文件操作
│   ├── bash.ts                      # Shell 执行
│   ├── grep.ts, glob.ts             # 代码搜索
│   ├── web.ts                       # WebFetch + WebSearch (Tavily)
│   └── todo.ts                      # 任务管理
├── permissions/        # 权限策略引擎（auto/confirm/manual + 规则匹配）
├── context/            # 上下文链注入（优先级排序）
│   ├── system-prompt.ts   #   11 模块分层 System Prompt
│   ├── claude-md.ts       #   CLAUDE.md 注入
│   ├── memory-md.ts       #   MEMORY.md 注入
│   ├── git-status.ts      #   Git 状态注入
│   ├── mnemosyne-source.ts#   Mnemosyne 记忆注入
│   └── compression.ts     #   MicroCompact 压缩
├── plan/               # Phase 2a: 意图树 & Grill Me
│   ├── tree.ts            #   意图树数据结构 + Markdown 序列化
│   ├── gatherer.ts        #   Grill Me 需求澄清（5 类 Checklist）
│   ├── planner.ts         #   结构化计划生成
│   ├── grillme.ts         #   偏离追踪（3 档灵敏度）
│   └── manager.ts         #   统一门面
├── memory/             # Phase 2b: Mnemosyne 记忆图谱
│   ├── store.ts           #   SQLite 图存储（实体 + 关系 + 访问日志 + 衰退）
│   ├── extractor.ts       #   三元组自动抽取
│   └── global.ts          #   跨项目全局记忆
├── git/                # Phase 2c: Git 顾问系统
│   ├── advisor.ts         #   Git 操作拦截与解释
│   ├── newbie-guide.ts    #   Git 概念用项目上下文解释
│   ├── preflight.ts       #   Push 前检查
│   ├── branch-health.ts   #   分支健康检查
│   ├── archaeology.ts     #   代码考古（自然语言查历史）
│   ├── semantic-blame.ts  #   语义 Blame（为什么这么写）
│   ├── intent-verify.ts   #   提交意图验证
│   ├── team-radar.ts      #   团队协作雷达
│   ├── workflow-learner.ts#   工作流自学习
│   └── conflict-narrator.ts#  Merge 冲突叙事
├── journal/            # Phase 2d: 个人技术知识库
│   ├── store.ts           #   SQLite 知识库存储
│   ├── extractor.ts       #   信号检测 + 自动提取
│   └── recall.ts          #   触发式回忆
├── cli/                # 命令行入口
│   ├── entry.ts           #   参数解析 + REPL + 命令处理
│   ├── stream-renderer.ts #   行缓冲 Markdown→ANSI 渲染器
│   └── config-loader.ts   #   配置 + .env 加载
├── session/            # JSONL 会话持久化
├── embedding/          # ONNX + sqlite-vec 基础设施
└── core-types.ts       # 核心类型定义
```

### 数据存储

```
.agent/                       # 项目级数据
├── plans/{branch}.md         #   意图树 Markdown
└── workflow-profile.json     #   Git 工作流学习档案

~/.coding-agent/              # 用户级数据
├── .env / .env.local         #   全局 API Key
├── mnemosyne/memory.db       #   项目记忆图谱 (SQLite)
├── global/memory.db          #   跨项目全局记忆 (SQLite)
├── journal/journal.db        #   个人技术知识库 (SQLite)
└── models/                   #   ONNX 嵌入模型
```

### System Prompt 架构

分层设计，11 个独立模块组合：

| 序号 | 模块 | 内容 |
|------|------|------|
| 1 | Identity | 身份 + 能力范围 |
| 2 | Security | 安全红线 + 双用途工具规则 |
| 3 | Confidentiality | 不透露工具/模型供应商 |
| 4 | Behavior | 语气风格 + 专业客观 + 主动 |
| 5 | Code Conventions | 一致风格 + 错误处理 + 测试 |
| 6 | Tool Usage | 优先专用工具 + 并行读串行写 |
| 7 | Task Management | TodoWrite + 编码前规划 |
| 8 | Plan Guidance | Grill Me 行为指令 + 当前计划注入 |
| 9 | Git Policy | 不自动提交/push + 写操作需确认 |
| 10 | Environment | 工作目录 + 平台 + Shell |
| 11 | Communication | 引用格式 + Markdown 规范 |

---

## 工具清单

| 工具 | 类型 | 并行 | 说明 |
|------|------|------|------|
| Read | read | ✅ | 读取文件，最多 2000 行 |
| Grep | read | ✅ | 正则搜索文件内容 |
| Glob | read | ✅ | 文件名模式匹配 |
| WebFetch | read | ✅ | HTTP GET + HTML→Markdown 转换 |
| WebSearch | read | ✅ | Tavily 搜索引擎 |
| Write | write | ❌ | 创建/覆盖文件 |
| Edit | write | ❌ | 精确字符串替换 |
| Bash | write | ❌ | Shell 命令执行 |
| TodoWrite | write | ❌ | 任务列表管理 |

## 技术栈

- **TypeScript** + Node.js (ES2022, ESM)
- **openai** v4 — DeepSeek 等 OpenAI 兼容 API
- **@anthropic-ai/sdk** — Anthropic 流式 + prompt caching
- **better-sqlite3** — 本地 SQLite（记忆图谱 + 知识库 + 全局记忆）
- **vitest** — 测试框架（50 个测试）
- **chalk** — 终端 ANSI 颜色

---

## 测试

```bash
npm test              # 运行所有测试（50 tests, 5 suites）
npm run test:watch    # watch 模式
```

## License

MIT
