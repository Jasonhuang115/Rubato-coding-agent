# coding-agent

从零构建的 Coding Agent，灵感来自 Claude Code。

**Phase 1 已完成** — 可工作的 Agent 骨架，多提供商支持，50 个测试全部通过。

## 进度

| 阶段 | 状态 | 内容 |
|------|------|------|
| Phase 1 | ✅ 完成 | Agent 骨架：核心循环、工具系统、权限、上下文、CLI |
| Phase 2 | 🔜 规划中 | 创新点：Mnemosyne 记忆图、Ink TUI、智能压缩、沙箱 |

### Phase 1 已实现

- **多提供商支持** — DeepSeek、OpenAI、Anthropic、Groq、OpenRouter、Ollama、vLLM
- **9 个工具** — Read、Write、Edit、Bash、Grep、Glob、WebFetch、WebSearch、TodoWrite
- **ReadGuard** — Write/Edit 拒绝未在会话中读取过的文件
- **读写分离** — Read 类工具并行执行（最多 10 个），Write 类串行
- **流式渲染** — 纯 ANSI StreamRenderer，逐 token 输出
- **权限系统** — auto/confirm/manual 三模式 + 硬黑名单
- **上下文注入** — CLAUDE.md、MEMORY.md、Git 状态自动注入
- **上下文压缩** — MicroCompact（消息压缩）+ Snip（内容截断）
- **错误恢复** — 三级分类（retry → circuit_breaker → fatal）+ 指数退避
- **会话持久化** — JSONL 格式，SessionMeta 追踪
- **5 个扩展点** — ContextSource、SmartCompressor、MemoryStore、MetaConsumer、TodoWrite，为 Phase 2 预留

### Phase 2 规划

- Mnemosyne 记忆图（sqlite-vec 向量搜索 + 三元组抽取）
- Ink v7 TUI（React 组件树，交互式确认对话框）
- 智能压缩（廉价模型摘要替代规则压缩）
- 沙箱隔离（Docker/工作树级别）
- 子 Agent 编排

## 快速开始

```bash
# 安装
git clone https://github.com/dengpan19/coding-agent.git
cd coding-agent
npm install
npm run build

# 设置 API Key（任选一个）
export DEEPSEEK_API_KEY=sk-xxx
export ANTHROPIC_API_KEY=sk-ant-xxx
export OPENAI_API_KEY=sk-xxx

# 运行
npm run dev -- "帮我写一个 hello world"

# 指定提供商和模型
npm run dev -- -p anthropic -m claude-sonnet-4-20250514 "重构这个文件"
```

## 配置

在项目根目录或 `~/.coding-agent/config.yml` 创建配置：

```yaml
model:
  provider: deepseek        # deepseek | openai | anthropic | groq | ollama | ...
  model: deepseek-chat
  baseURL: https://your-custom-api.com/v1  # 可选

permissions:
  bash: confirm
  read: auto
  write: confirm
  edit: confirm
  web: confirm
```

支持的命令行参数：

```
-d, --dir <path>    工作目录
-m, --model <name>  模型名称
-p, --provider <n>   提供商
-h, --help          帮助
```

也支持管道输入：

```bash
echo "解释这个函数的作用" | coding-agent
```

## 技术栈

- **TypeScript** + Node.js (ES2022, ESM)
- **openai** v4 — DeepSeek 等 OpenAI 兼容 API
- **@anthropic-ai/sdk** — Anthropic 流式 + prompt caching
- **@photostructure/sqlite-vec** + **better-sqlite3** — Phase 2 向量存储
- **vitest** — 测试框架（50 个测试）

## 测试

```bash
npm test              # 运行所有测试
npm run test:watch    # watch 模式
```

## 架构

```
src/
├── agent/          # Async generator 核心循环
├── model/          # ModelProvider 接口 + 多实现
├── tools/          # 9 个工具 + Registry
├── permissions/    # 权限策略引擎
├── context/        # 上下文链 + 压缩
├── cli/            # 命令行入口 + ANSI 渲染
├── session/        # JSONL 持久化
├── embedding/      # ONNX + sqlite-vec 基础设施
└── memory/         # Mnemosyne 脚手架
```

## License

MIT
