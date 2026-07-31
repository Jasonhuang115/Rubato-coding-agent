# Rubato

Rubato 是一个本地运行的 coding agent。它支持多模型、工具调用、会话恢复、任务拆分，并使用一套可审计的文件式记忆。

记忆系统不使用 RAG、向量库、embedding、知识图谱或自动 top-k 召回。正常运行时不打开或创建 SQLite `memory.db`。长期记忆是普通 Markdown/TSV/JSONL 文件：启动时只注入经过校验且有明确预算的 `PROFILE.md`；需要细节时，Agent 用 Grep 搜索精确的 `catalog.tsv`，再用 Read 打开对应 card。

记忆分成两半，权限不同：用户画像来自用户本人写下的证据；项目事实（代码结构、配置、依赖、Git 历史）由确定性扫描器从当前 checkout 推导，写成 `authority: repository` 的 card，只作为参考注入标题索引。

## 快速开始

```bash
npm install
cp .env.example .env
npm run build
npm link

rubato
rubato -d /path/to/project "解释这个项目"
rubato -n "修复当前测试"
```

常用参数：

```text
-d, --dir <path>      工作目录
-m, --model <name>    覆盖模型
-p, --provider <name> 覆盖 provider
-c, --continue        接续当前项目最近一次会话
-r, --resume [id]     恢复指定会话
-n, --one-shot        单轮执行后退出
```

API key 可放在项目的 `.env` / `.env.local`，也可放在 `~/.rubato/.env`。Shell 环境变量优先。支持的变量见 [.env.example](.env.example)。

## 文件记忆如何工作

```text
用户消息
  └─> hash-chained session JSONL
       ├─> Fast path：识别明确的“记住/以后/默认/纠正”
       └─> Session close：提取可追溯 observation
              └─> 确定性 User Model / Reducer
                    ├─> 低风险且证据充分：发布新 release
                    ├─> 证据不足或敏感：candidate / review
                    └─> 达到阈值：进入 durable Dream queue

Dream runner（启动时后台执行，或 /memory dream --run）
  └─> Dream worker（Extractor → Critic → Reconciler）
       └─> 只生成并校验结构化 operation/candidate
            └─> 确定性策略决定发布、复核或拒绝

项目扫描（无模型调用）
  └─> package.json / 目录结构 / tsconfig / git log
       └─> content hash 比对 → 只在 checkout 变化时发布 repository card

新会话
  ├─> 校验 CURRENT、manifest、文件 hash、purge epoch
  ├─> 注入有 token 上限的 PROFILE.md
  ├─> 注入项目事实的“标题 + 地址”索引（不含正文）
  └─> 按需 Grep catalog.tsv → Read cards/<id>.md
```

几个重要边界：

- 只有用户本人写下的内容能成为用户画像证据。Assistant、工具输出和模型猜测不能伪造用户偏好。
- 项目事实用 `authority: repository` 与用户画像隔离：它不进入 `PROFILE.md`，只作为 reference；工作树与它冲突时以工作树为准。
- 同一会话的重复表达只取最强证据，避免靠复读把置信度刷高。
- 明确偏好、约束、目标和纠正走快速路径；习惯和推断要跨会话积累，冲突时进入复核。
- Dreaming 可以归纳、合并、挑战或暂停候选项，但 LLM 不能直接编辑 `CURRENT`、release 或执行删除。
- 使用次数、搜索/读取记录和任务结果与“这条记忆是否可信”分开保存；效果反馈只能对已经匹配的结果重新排序，不能把猜测变成事实，也不能召回新条目。
- 当前请求、系统安全规则和仓库事实始终高于历史记忆。

### 为什么不是 RAG

Rubato 的主要问题不是“从海量文档中找语义相似段落”，而是维护少量、长期、可纠正的用户事实与工作习惯。文件方案让每条记忆都有稳定地址、证据链、生命周期和 Git/Unix 工具可读性：

- 没有 embedding 模型、向量索引、RRF 融合或检索权重调参。
- 不根据当前 query 自动拼接若干相似片段。
- `PROFILE.md` 是小而稳定的常驻画像；详细信息保持外置。
- `catalog.tsv` 和 card 可以直接用 Grep/Read 检查，召回过程可解释。
- 发布、回滚和隐私删除都有独立、可审计的文件状态。

## 动态更新与生命周期

写入不是直接修改画像，而是经过下面几层：

1. 会话事件先以 hash chain 写入 JSONL，并在正常结束时追加 `session_closed`。
2. 提取器只接受能回指到用户事件序号与 hash 的 observation。
3. Reducer 按 logical key、scope、上下文和证据强度生成 ADD、REINFORCE、CONTEXTUALIZE、SUPERSEDE、CONFLICT 等操作。
4. Publisher 在锁和双重 CAS 下创建全新的不可变 release；`CURRENT` 只在全部文件与 manifest 写完并校验后原子切换。
5. 旧信息可被 supersede 或 retire；需要隐私删除时走 hard purge，不能用普通回滚恢复。

Dream queue 使用持久化时钟，而不是进程内定时器。默认在以下任一条件满足时排队：

- 新增 5 个已关闭且 hash 校验通过的会话；
- 有 20 个 pending/review candidate；
- 最老的未处理 observation 已等待 24 小时。

进程重启后会从文件状态继续，不会因为计时器丢失而漏掉任务。队列里的租约（`POLICY.yml` 的 `dream.lease_minutes`）过期后会被回收，崩溃的 worker 不会把任务永久占住。

排队和执行是两件事：

- `/memory dream` 只入队，不调用模型。
- `/memory dream --run` 显式排空队列，会调用模型。
- 启动时有一次后台维护：先做项目事实扫描，再按 `dreamMaxRunsPerStart` 排空少量队列。它不阻塞第一次输入，退出时会被取消；队列为空时连 provider 都不会构造。用 `memory.dreamAutoRun: false` 可以完全关掉。

无论从哪个入口执行，模型都拿不到发布权限：Dream 最多留下待复核 candidate，`CURRENT`、release 和删除仍由确定性策略决定。

项目事实扫描是幂等的：每条事实带 content hash，只有 checkout 真的变了才会发布新 release；不再成立的事实会被退役，同一 scope 里的用户 card 不受影响。学习暂停或记忆关闭时也不扫描。

### 软退役、纠正与彻底遗忘

- `/profile correct`：发布新 revision，并让旧值进入 superseded 历史；适合“我现在改主意了”。
- `/memory retire`：停止使用某条记忆，但保留可审计历史且可以回滚。
- `/memory undo`：以新的 release 回到指定历史状态，不修改旧 release。
- `/profile forget`：隐私级 hard purge。它清理 release、observation、candidate、Dream、session、摘要、访问/结果记录和相关派生物，并写入防复活 ledger。

彻底遗忘前建议先预览：

```text
/profile forget <logical-key> --dry-run
/profile forget <logical-key>
```

`retire` 是可逆的生命周期操作，`forget` 是不可逆的隐私删除，两者不要混用。

## 记忆命令

```text
/remember <text>
```

把内容转换为当前会话中的明确用户消息，因此它会进入同一条证据链，而不是旁路写文件。

```text
/memory stats
/memory search <query>
/memory list
/memory dream            仅入队
/memory dream --run      入队并立即排空队列（会调用模型）
/memory bootstrap        重新扫描项目事实
/memory bootstrap --check 只校验，不写入
/memory retire <id-or-logical-key>
/memory undo [target-release-id]
```

`/memory search` 搜索经过校验的 `catalog.tsv`；它不是语义检索。匹配集合只由文本决定，达到最小使用次数的效果评分只能在已匹配结果内部调整顺序。

`/memory bootstrap --check` 会报告与 checkout 一致、已过期、尚未记录和已不再成立的项目事实，并且不写任何 release。

```text
/profile show
/profile why <logical-key>
/profile correct <logical-key> <new-value>
/profile forget <logical-key> [--dry-run]
/profile export
/profile pause-learning
/profile resume-learning
```

`/profile why` 会展示 card revision、scope、confidence 以及对应的用户证据。暂停学习会同时停掉项目事实扫描和 Dream 执行，但不会隐藏已经发布的记忆。

`/journal list/search/stats/recent` 仍作为 `/memory` 的兼容别名，但不再连接旧数据库。

## 磁盘布局

默认数据根目录是 `~/.rubato`，也可用 `RUBATO_HOME` 覆盖。

```text
~/.rubato/
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
│   ├── projects/<full-project-sha256>/
│   │   └── ...与 global 相同的 release/observation/candidate/dream 结构
│   ├── access.jsonl
│   ├── outcomes.jsonl
│   ├── control-events.jsonl
│   └── purge-ledger.jsonl
├── projects/<full-project-sha256>/
│   ├── sessions/<session-id>.jsonl
│   ├── sessions.json
│   └── session-catalog.tsv
└── sessions/                         # 兼容的非项目级会话
```

release 内的 `PROFILE.md`、`INDEX.md`、`catalog.tsv` 和 card 全部由 manifest hash 覆盖。校验失败时会 fail closed，不会退回读取旧 release 或未发布 candidate。

## 配置

项目配置写在 `.rubato.yml`，全局配置写在 `~/.rubato/config.yml`。

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-20250514
  maxRetries: 3

memory:
  enabled: true
  learningEnabled: true
  profileMaxTokens: 1000
  bootstrapEnabled: true
  dreamAutoRun: true
  dreamMaxRunsPerStart: 2
  dreamSessionThreshold: 5
  dreamCandidateThreshold: 20
  dreamMaxAgeHours: 24
  autoPublishExplicitLowRisk: true
  utilityLearningRate: 0.2
  utilityMinUses: 5

session:
  cleanupPeriodDays: 30
```

更底层的记忆策略保存在 `~/.rubato/memory/global/POLICY.yml`，它是全局上限而不是默认值：

- `profile_max_tokens`：注入预算的硬上限。项目里的 `.rubato.yml` 只能调低，不能调高。
- `prohibited_sensitive_categories`：快速路径拒绝学习的类别（认证凭据、身份证件、健康、政治、宗教、财务、性取向、亲密关系）。删掉某一项就等于允许它进入学习；写入一个没有识别器的类别会被明确报告为无法执行，而不是假装检查过。
- `dream.lease_minutes`、`dream.max_retries`：队列租约与重试上限。
- `utility.alpha`、`utility.minimum_uses`：`.rubato.yml` 不写 `utilityLearningRate` / `utilityMinUses` 时使用这里的值。

旧配置中的 `embedding` 和 `mnemosyne` 字段会被警告并忽略，不会启用兼容运行时。

## 从旧 Mnemosyne 数据库迁移

旧 SQLite 数据绝不会在启动或普通命令中自动打开。迁移是一个显式、一次性的离线脚本，不属于 CLI：

```bash
npm run migrate:legacy -- /absolute/path/to/memory.db /absolute/path/to/review-candidates
```

`/memory migrate` 不执行迁移，只提示这条命令。迁移边界有意保持很窄：

- `better-sqlite3` 是 optional dependency，只在运行该脚本时动态加载；CLI 的依赖图里没有它。
- 数据库以 `readonly: true` 和 `fileMustExist: true` 打开。
- 迁移结果只是待复核 candidate，不会写 `CURRENT` 或自动发布。
- embedding、检索权重、反馈日志和图关系不会进入新运行时。
- 没有旧数据要迁移时，可以不安装 `better-sqlite3`。

## 开发

```bash
npm run build
npm test
npm run dev
```

`npm run build` 会先清理 `dist/`，防止已经删除的旧模块以陈旧 JavaScript 的形式混入发布包。

核心目录：

```text
src/agent/             Agent 主循环、规划与子任务
src/context/           CLAUDE.md、Soul、verified file-memory、Git context
src/memory-files/      文件记忆、项目事实扫描、发布、Dreaming、迁移与隐私删除
src/runtime/session/   hash-chained 会话和项目 session catalog
src/security/          权限、sandbox、持久化数据清理
src/tools/             Agent 工具
test/                  单元、集成与安全回归测试
```

正常运行时的入口依赖图由测试锁定：CLI、context assembler 和 agent loop 均不得依赖 legacy memory、数据库驱动或旧的自动注入源。
