# Rubato

Rubato 是一个本地运行的 coding agent。它把模型推理、代码工具、Plan Mode、并行子任务、Git 工作流和文件式记忆组织在同一个终端工作流中。

README 按六个部分介绍当前系统：基本使用、Agent Runtime、Subagent、Plan Mode、记忆系统，以及 Git 操作。

## 1. Rubato 基本情况与使用方式

### 核心能力

- 支持 DeepSeek、Anthropic、OpenAI 及多种 OpenAI-compatible provider
- 从 Home、普通目录或代码仓库全局启动
- 默认进入连续对话的交互式 REPL，也支持 one-shot 和管道输入
- 在 workspace 中读取、检索、修改文件并运行构建、测试和命令
- 保存项目会话，支持恢复、压缩和跨会话长期记忆
- 使用 Plan Mode 调查并批准复杂方案，使用 Subagent 并行探索、验证和实现
- 感知当前 Git 分支、工作树、提交历史和团队工作流
- 通过 Skill 与 MCP 扩展能力

终端中的 `Mode: interactive` 表示当前运行的是可连续对话的 REPL。

### 安装

在 Rubato 源码目录执行：

```bash
npm install
cp .env.example .env
npm run build
npm link
```

`npm link` 会注册全局 `rubato` 命令。之后可以从任意目录启动：

```bash
# 当前目录作为 workspace
rubato

# 指定一个项目作为 workspace
rubato -d /absolute/path/to/repository

# 带首条问题进入交互模式
rubato -d /absolute/path/to/repository "解释这个项目"

# 单轮执行后退出
rubato -n -d /absolute/path/to/repository "运行测试并解释失败原因"

# 管道输入自动采用单轮模式
printf '总结这个项目\n' | rubato -d /absolute/path/to/repository
```

启动目录就是本次会话的 workspace。从 Home 启动时，Home 是 workspace；处理代码时推荐进入仓库后运行，或者用 `-d` 明确指定仓库，使项目上下文、会话、计划和项目记忆落在正确的 scope。

### CLI 参数

```text
-d, --dir <path>       工作目录，默认是当前目录
-m, --model <name>     覆盖模型名称
-p, --provider <name>  覆盖 provider
-c, --continue         接续当前项目最近一次会话
-r, --resume [id]      恢复指定会话；省略 id 时显示选择器
-n, --one-shot         单轮执行后退出
-h, --help             显示帮助
```

### 模型、API key 与搜索

Rubato 按以下位置读取环境变量：

1. 启动 Rubato 时已有的 shell 环境变量；
2. 当前 workspace 的 `.env`、`.env.local`；
3. `~/.rubato/.env`、`~/.rubato/.env.local`。

已有变量保持最高优先级，后续文件只补充缺失项。项目 `.env` 由 Rubato 主进程读取，建议只加载自己信任的项目配置。

```dotenv
CODING_AGENT_PROVIDER=deepseek
CODING_AGENT_MODEL=deepseek-chat

DEEPSEEK_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# CODING_AGENT_API_KEY=sk-...

# WebSearch 使用 Tavily
TAVILY_API_KEY=tvly-...
```

| Provider | 接口类型 | 凭据变量 |
| --- | --- | --- |
| `deepseek` | DeepSeek API | `DEEPSEEK_API_KEY` |
| `anthropic` / `claude` | Anthropic API | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI-compatible | `OPENAI_API_KEY` |
| `groq`、`openrouter` | OpenAI-compatible | `OPENAI_API_KEY` 或 `CODING_AGENT_API_KEY` |
| `ollama` | 本地 OpenAI-compatible | 按本地服务配置 |
| `together`、`fireworks`、`vllm` | OpenAI-compatible | `OPENAI_API_KEY` 或 `CODING_AGENT_API_KEY` |

自定义 provider 可设置 `CODING_AGENT_BASE_URL`。完整示例见 [.env.example](.env.example)。交互中可用 `/model` 查看模型，用 `/model <name>` 切换并保存全局偏好。

### 常用 REPL 命令

```text
/help                         查看帮助
/exit、/quit                  保存并退出
/clear                        保存当前会话并开始新会话
/compact                      压缩较早的上下文
/paste                        把剪贴板全文作为一条消息发送
/model [name]                 查看或切换模型
/sessions                     列出当前项目会话
/sessions resume <#|id>       恢复会话
/scrub --dry-run [path]       扫描持久化数据中的密钥
/scrub [path]                 脱敏 session、trace 和任务产物
```

### 配置与开发

项目配置使用 `.rubato.yml`、`.rubato.yaml`、`rubato.yml` 或 `rubato.yaml`，全局配置使用 `~/.rubato/config.yml`。全局配置后合并，CLI 和环境变量对 provider、model、base URL 的优先级更高。

```yaml
model:
  provider: deepseek
  model: deepseek-chat
  maxRetries: 3

permissions:
  bash: auto       # auto | confirm | manual
  read: auto
  write: auto
  edit: auto
  web: auto

memory:
  enabled: true
  learningEnabled: true
  profileMaxTokens: 1000
  bootstrapEnabled: true
  dreamAutoRun: true
  dreamMaxRunsPerStart: 2

subagents:
  maxConcurrent: 4
  maxWriteConcurrent: 2
  maxTasksPerSession: 32

worktree:
  baseRef: fresh   # fresh | head
```

开发命令：

```bash
npm run dev -- -d /path/to/project
npm run build
npm test
npm run test:watch
```

## 2. Agent Runtime：工具与运行逻辑

### 一次会话如何启动

Rubato 启动后先确定 workspace、配置和模型，然后组装根 Agent 的动态上下文：

```text
CLI 参数与环境
  → workspace / provider / model
  → 项目规则与 CLAUDE.md
  → 已验证的全局和项目记忆
  → Git 分支、工作树和近期提交
  → 当前 Runtime Mode 与可用 Skill
  → 根 Agent system prompt
```

随后创建项目级 session，进入模型—工具循环。用户输入、Assistant 输出、工具事件和压缩记录会持续写入 session。

### 模型—工具循环

```text
用户输入
  → 组装本轮 messages
  → 模型流式输出
  → 文本直接渲染到终端
  → tool call 进入权限与安全检查
  → 执行工具并生成 tool result
  → tool result 返回模型继续推理
  → 模型完成本轮回答
```

Read、Grep、Glob 等并发安全的读取工具可以在同一 step 中并行执行；Write、Edit、Bash 和控制类工具按顺序执行。这样的调度让检索保持并发，同时让文件修改、命令和模式转换具有确定的先后顺序。

### 内置工具

Rubato 注册 15 个核心工具：

| 类别 | 工具 | 用途 |
| --- | --- | --- |
| 文件与搜索 | `Read`、`Grep`、`Glob` | 阅读文件、查找文本和枚举路径 |
| 修改与执行 | `Write`、`Edit`、`Bash` | 创建/修改文件，运行构建、测试和 Git 命令 |
| Web | `WebFetch`、`WebSearch` | 读取网页，通过 Tavily 搜索 |
| 任务组织 | `TodoWrite` | 管理 default mode 中的临时待办 |
| 规划提交 | `SubmitPlan` | 提交 Plan Mode 生成的最终 Markdown |
| 多 Agent | `Subagent`、`Task` | 异步创建与查询 Subagent 任务 |
| 扩展 | `Skill` | 调用已加载 Skill |
| 记忆 | `MemoryFeedback`、`MemoryPropose` | 记录记忆效果，提交可审计候选 |

MCP server 提供的工具会动态追加，并以 `mcp:<server>:<tool>` 命名。

### 上下文、压缩与会话恢复

当前进程中的用户消息、Assistant 回复、工具结果、模式状态和最近文件构成 Agent 的工作上下文。当上下文接近模型窗口时，Runtime 会先整理陈旧工具结果，再把较早对话压缩为摘要，同时保留近期消息和最近访问的文件路径。`/compact` 可以手动触发同一流程。

session 事件以 JSONL 追加，并通过 `seq`、`prev_hash`、`hash` 形成 hash chain。`-c`、`-r` 和 `/sessions resume` 从会话摘要、目标和关键事件组装紧凑恢复上下文。

### Skill 与 MCP 扩展

Skill 按以下优先级加载，后者覆盖同名 Skill：

1. Rubato 内置 Skill；
2. `~/.rubato/skills/` 全局 Skill；
3. `<workspace>/.rubato/skills/` 项目 Skill。

推荐结构为 `.rubato/skills/<name>/SKILL.md`。`context: inline` 把指令加入根 Agent，`context: fork` 使用独立 Subagent 执行。加载后 Skill 同时成为 `/<skill-name>` 命令。

MCP 配置从 `<workspace>/.agent/mcp.json` 和 `~/.rubato/mcp.json` 加载：

```json
{
  "servers": {
    "example": {
      "command": "npx",
      "args": ["-y", "example-mcp-server"],
      "env": { "EXAMPLE_SETTING": "value" }
    }
  }
}
```

### 工具执行安全

Runtime 在工具执行前统一应用权限策略和安全检查：

- 文件工具验证 workspace 边界、canonical path、symlink 和敏感路径；
- Bash 检查命令结构、危险操作、工作目录和敏感路径引用；
- Bash 子进程过滤 API key、token、password 和云凭据环境变量；
- WebFetch 校验 URL scheme，并拦截常见私网、loopback 和 link-local 地址；
- Git 写操作经过 Git policy 与对应的提交、推送检查；
- session、trace 和任务产物写入前进行脱敏。

默认权限偏向顺畅使用，工具类型也可配置为 `confirm` 或 `manual`。这层检查覆盖 Rubato 发起的工具调用；对于来源未知或包含主动攻击代码的仓库，建议配合独立系统用户、虚拟机或容器运行。

## 3. Subagent 机制

Subagent 用于把边界清晰、能够独立推进的工作从根 Agent 中拆出。每个 Subagent 都使用 fresh context，只接收自包含的任务说明、项目规则、允许的工具和预期输出，因此适合并行检索、专项研究、对抗验证和隔离实现。

### 内置角色

| 类型 | 能力 | 典型用途 |
| --- | --- | --- |
| `explore` | Read、Grep、Glob | 定位文件、符号、调用链和项目约定 |
| `research` | 项目读取 + WebFetch/WebSearch | 综合仓库证据与外部资料 |
| `verify` | 只读对抗检查 | 检查结论、边界条件、回归与测试缺口 |
| `general` | 复杂只读分析 | 多范围分析和证据汇总 |
| `worker` | Read、Write、Edit、Bash，独立 worktree | 实现一个自包含改动并测试、提交 |

项目可以在 `<workspace>/.rubato/agents/*.md` 定义自定义角色。需要 Write、Edit 或 Bash 的自定义 Agent 必须声明 `isolation: worktree`。

### 调度模型

根 Agent 通过 `Subagent` 工具提交后台任务，每个任务带有：

- `description`：简短任务名；
- `prompt`：目标、范围、约束、必要上下文和交付物；
- `subagent_type`：角色；
- 必填的 `timeout_ms`：仅用于防止永久卡死的宽松兜底，不是工作预算；
- 可选的模型、coverage、worktree isolation 和文件 scope。

所有任务都在后台异步运行，工具立即返回唯一 task ID、当前状态、任务目录和绝对报告路径。`maxConcurrent` 满时任务保持 `queued`，FIFO 获得运行槽后转为 `running`，最终只会成为 `finished` 或 `failed`。根 Agent 不等待任务；终态变化会唤醒同一 session 的下一次串行 root run。

默认调度上限：

```text
并发任务             4
并发写任务           2
每个根会话任务数     32
任务产物 TTL          30 天
产物软上限            2 GiB
```

v1 只允许根 Agent 派发任务。Subagent 不能递归派发；writer 在独立 worktree 中运行，避免多任务工作区覆盖。

### Writer 与 worktree

`worker` 任务必须提供非空、仓库相对的 `scope`。Runtime 会检查活跃 writer 的 scope，阻止相互重叠的写任务，然后：

```text
根仓库当前提交
  → 创建 Rubato worker branch
  → 创建独立 Git worktree
  → worker 实现、测试、stage、commit
  → 返回 commit / diff / changed files / patch 证据
  → 根 Agent 在主工作树逐个集成
```

worker 运行时把可见文本持续追加到 `report.md`，并要求结束时工作树干净且已有提交。根 Agent 根据报告、结果和 diff 决定 merge、cherry-pick、继续修复或保留分支。

### 任务产物与管理

每个任务会保存 `task.json`、`result.json`、`report.md`、`transcript.jsonl`、`coverage.json` 和 `changes.patch`。这些文件位于：

```text
~/.rubato/projects/<project-sha256>/runs/<root-session-id>/tasks/<task-id>/
```

常用命令：

```text
/tasks                        列出任务
/tasks <id>                   查看详情
/tasks cancel <id>            取消任务
/tasks cleanup <id>           清理任务状态和产物
/tasks pin|unpin <id>         保留或解除保留
/tasks stats                  查看产物占用
/tasks prune                  清理过期产物
/trace [task-id]              查看根 trace 或任务 transcript 路径
```

## 4. Plan 模式

Plan Mode 是 Agent Runtime 的一种会话模式。它用于先调查项目、澄清关键决策并形成可直接执行的方案，再由用户决定是否进入实现阶段。模式只由用户显式切换：

```text
/plan on       进入 Plan Mode
/plan off      退出 Plan Mode，不执行待确认计划
/plan status   查看当前模式、阶段和最近计划路径
/plan          等同于 /plan status
```

进入后终端提示符变为 `▸ Plan:`。此时普通输入都会交给规划 Runtime；`/clear` 会清除当前会话和待确认计划，同时保留当前模式。

### 调查和澄清

Plan Mode 先使用仓库证据回答能够从环境中确定的问题，再沿着决策依赖逐项澄清。需要用户选择时，每次只问一个问题，同时给出推荐答案和简短理由。规划会覆盖目标、范围、接口、数据流、异常与失败处理、兼容性、测试和验收标准，直到方案足以直接实施。

整个规划过程使用 Markdown。Runtime 向模型公开的工具集合固定为：

```text
Read  Grep  Glob
WebFetch  WebSearch
Subagent  Task
SubmitPlan
```

其中 `Subagent` 只可启动 `explore`、`research`、`general` 和 `verify` 类型的只读后台任务；`Task` 只可查询任务。Runtime 会在工具执行前再次校验当前模式，因此写文件、编辑、Shell、动态 MCP 工具和具有写权限的 Subagent 不会在 Plan Mode 中执行。

### 提交、修订和批准

方案完整后，Agent 通过 `SubmitPlan` 提交最终 Markdown。计划按项目绝对路径的 SHA-256 隔离，保存在：

```text
~/.rubato/projects/<project-sha256>/plans/plan-<session-id>.md
```

设置 `RUBATO_HOME` 时会使用对应的数据根目录。同一个 planning session 的后续修订会原子覆盖同一文件。

提交后 CLI 展示完整计划和保存路径，并询问是否执行：

```text
执行这个计划？输入 y 执行，或直接说明需要修改的地方：
```

- 输入 `y`、`yes`、`是`、`执行`、`开始执行` 或 `按计划执行`：计划被批准，Runtime 自动切回 default mode，并立即把完整计划作为执行上下文交给正常 Agent。
- 输入 `n`、`no`、`否` 或 `继续规划`：保留 Plan Mode，继续调整方案。
- 输入其他文字：作为计划反馈进入下一轮规划，新的 `SubmitPlan` 会更新本地 Markdown。
- 输入 `/plan off`：退出 Plan Mode，不触发执行。

计划批准代表可以开始实现；Git commit、push、PR 和其他外部操作仍遵循各自的正常授权规则。

## 5. 记忆系统：短期与长期记忆

Rubato 的记忆由短期会话上下文和长期文件记忆组成。短期层保证当前任务连续性，长期层负责跨会话保留稳定的用户偏好、约束和项目事实。

### 短期记忆

短期记忆包括当前进程中的：

- 用户消息与 Assistant 回复；
- 工具调用和结果；
- 当前 Plan Mode 状态、Todo 和任务结果；
- 最近读取的文件与压缩摘要。

它在当前轮立即生效。接近上下文上限时，Runtime 会整理较早内容，根 Agent 保留约 60 条近期消息，Subagent 保留约 24 条，并重新提供最近访问的文件路径。

每个事件同时进入项目级 hash-chained session JSONL。恢复会话时，Rubato 使用目标、摘要和关键事件建立紧凑上下文。

### 长期记忆

长期记忆存放在 `~/.rubato/memory`，由 Markdown、TSV、YAML 和 JSONL 文件组成：

- `PROFILE.md`：有 token 预算上限的常驻用户画像；
- `catalog.tsv`：可精确 Grep 的记忆目录；
- `cards/<id>.md`：带 scope、证据、置信度和 revision 的详细记忆；
- observation、candidate 和 Dream 文件：学习与发布过程；
- immutable release、manifest 和 `CURRENT`：经过验证的读取面。

新 Agent 上下文会验证 `CURRENT`、manifest、文件 hash 和 purge epoch，然后注入全局画像和项目事实索引。需要详细信息时，Agent 先 Grep `catalog.tsv`，再 Read 指向的 card。

### 学习与发布

```text
用户消息
  → fast extractor / 会话收尾 extractor
  → observation（回指 session seq 与 hash）
  → reducer operation
  → candidate / review
  → deterministic publisher
  → immutable release
  → 原子切换 CURRENT
```

明确的“请记住”“以后默认”“我更正一下”等表达进入快速路径；正常关闭根会话时，完整 transcript 会再次被幂等处理。用户本人写下的消息是画像证据来源；API key、token、密码、私钥和策略中的敏感类别在学习入口过滤。

同一会话的重复表达只保留最强证据。明确偏好、约束、目标和纠正优先，推断性习惯通过跨会话证据积累。冲突进入 review，并通过 revision 与 supersede 关系保留来历。

一条偏好发布后，当前会话继续通过原始用户消息生效；下一次创建 Agent 上下文时，最新 release 成为跨会话长期记忆。

### 用户画像与项目事实

- **用户画像**记录用户偏好、约束、目标和纠正，主要进入全局 `PROFILE.md` 和对应 card；
- **项目事实**由确定性扫描器从 `package.json`、目录结构、`tsconfig` 和 Git 历史生成，以 `authority: repository` card 和 reference index 提供给 Agent。

项目事实使用 checkout content hash，只在仓库状态变化时更新。当前工作树是项目事实的最高优先级来源；当前请求和系统规则优先于所有历史记忆。

### Dreaming

Dream 是异步的记忆归纳与复核流程：

```text
Extractor → Critic → Reconciler → structured candidate
                                  ↓
                         deterministic publisher
```

默认满足任一条件时排队：

- 新增 5 个已关闭且 hash 校验通过的根会话；
- 有 20 个 pending/review candidate；
- 最老的 observation 已等待 24 小时。

Dream 队列和租约写入文件，进程重启后可以继续。`/memory dream` 创建任务，`/memory dream --run` 立即处理；启动维护最多处理 `dreamMaxRunsPerStart` 个任务。Dream worker 产出结构化 candidate，publisher 负责最终发布、复核和 `CURRENT` 切换。

### 纠正与生命周期

- `/profile correct` 发布新 revision，并 supersede 先前值；
- `/memory retire` 停止使用一条记忆，保留审计历史；
- `/memory undo` 通过新 release 回到指定历史状态；
- `/profile forget` 执行 hard purge，并写入防复活 ledger。

`retire` 是可逆生命周期操作，`forget` 用于隐私删除。可先执行 `/profile forget <key> --dry-run` 查看影响范围。

### 记忆命令

```text
/remember <text>
/memory stats
/memory list
/memory search <query>
/memory bootstrap
/memory bootstrap --check
/memory dream
/memory dream --run
/memory retire <id-or-logical-key>
/memory undo [target-release-id]

/profile show
/profile why <logical-key>
/profile correct <key> <new-value>
/profile forget <key> [--dry-run]
/profile export [--include-secret]
/profile pause-learning
/profile resume-learning
```

`/remember` 会转换成当前会话里的明确用户陈述，并走完整证据链。`/journal recent/search/stats` 是同一套文件记忆命令的兼容入口。

### 数据目录

默认数据根目录是 `~/.rubato`，可用 `RUBATO_HOME` 覆盖。项目 ID 是项目绝对路径的完整 SHA-256。

```text
~/.rubato/
├── config.yml
├── .env / .env.local
├── mcp.json
├── skills/
├── memory/
│   ├── global/
│   │   ├── CURRENT
│   │   ├── POLICY.yml
│   │   ├── releases/<release-id>/
│   │   │   ├── manifest.json
│   │   │   ├── manifest.sha256
│   │   │   ├── PROFILE.md
│   │   │   ├── INDEX.md
│   │   │   ├── catalog.tsv
│   │   │   └── cards/<memory-id>.md
│   │   ├── observations/YYYY/MM/YYYY-MM-DD.jsonl
│   │   ├── candidates/{pending,review,rejected,published}/
│   │   └── dreams/<run-id>/
│   ├── projects/<project-sha256>/
│   ├── access.jsonl
│   ├── outcomes.jsonl
│   ├── control-events.jsonl
│   └── purge-ledger.jsonl
└── projects/<project-sha256>/
    ├── sessions/<session-id>.jsonl
    ├── sessions.json
    ├── session-catalog.tsv
    ├── plans/plan-<session-id>.md
    └── runs/<root-session-id>/
        ├── trace.jsonl
        └── tasks/<task-id>/...
```

release 内容受 manifest hash 保护。校验通过的 `CURRENT` release 是 Agent 的长期记忆读取面；校验异常会停止该 scope 的记忆注入并报告错误。更底层的预算、敏感类别、Dream 租约和 utility 策略位于 `~/.rubato/memory/global/POLICY.yml`。

## 6. Git 相关操作

Rubato 把 Git 作为 Agent Runtime、Plan Mode、Subagent 和项目记忆共同使用的项目事实来源与协作边界。

### 启动时的 Git 上下文

在 Git 仓库启动时，根 Agent 会获得：

- 当前分支；
- `git status --short` 工作树状态；
- 最近 5 条提交；
- 默认分支与本地分支健康度；
- 已存在的 merge conflict 摘要。

`/git` 或 `/git status` 显示当前分支、领先/落后远端的提交数、变更文件和最近提交。`/git health` 分析本地分支相对默认分支的 ahead/behind、最后提交时间与同步建议。

### 读操作与写操作

Agent 可以使用 `git status`、`git diff`、`git log`、`git branch`、`git show` 等只读命令理解仓库。commit、push、merge、rebase、cherry-pick 等写操作通过 Bash 执行，并受权限、安全策略和用户请求范围约束。

默认 Git policy：

- commit、push 和创建 PR 由用户明确提出；
- push 前检查远端同步、未提交文件、分支重叠和潜在冲突；
- destructive Git 操作进入高风险检查；
- 根工作树保持用户当前状态，worker 的实现位于独立 worktree。

### Pre-push 检查

当 Bash 即将执行 `git push` 时，Runtime 会执行 preflight：

```text
远端默认分支同步状态
  + 当前未提交变更
  + 其他本地/远程分支的文件重叠
  + Team Radar 冲突风险
  → warnings 与建议
```

### 冲突分析与历史解释

启动或上下文组装时发现 merge conflict，Rubato 会读取双方分支对冲突文件的提交和 diff，组织为：

- 当前分支做了什么；
- 目标分支做了什么；
- 冲突形成的原因；
- 保留当前、保留对方或合并双方的建议。

Git archaeology 和 semantic blame 能结合 `git blame`、`git log -L` 与文件历史解释某行代码由谁、何时、在哪个 commit 引入，以及相关提交的修改脉络。

### Subagent 分支集成

writer Subagent 在 Rubato 创建的 branch/worktree 中实现并提交。任务返回后，根 Agent 按顺序集成：

1. 确认根工作树干净并检查 worker 的 commit、diff、测试和 scope；
2. 使用普通 merge 集成完整 worker 分支，或在需要线性历史/选择性提交时 cherry-pick；
3. 发生冲突时检查 status 和双方内容，在根工作树解决、stage 并重新运行测试；
4. 集成成功后清理 worktree；需要继续调查时保留分支和产物。

### 团队工作流学习

会话结束时，Rubato 从本地 Git 历史统计团队模式，并写入：

```text
<workspace>/.agent/workflow-profile.json
```

该 profile 包含常见分支前缀、PR 文件/行数分布、merge/squash/rebase 倾向和活跃时间，用于给后续 Git 操作提供贴合当前仓库的建议。
