# Rubato 源码学习档案

> 这份文件是跨对话的学习锚点。每次课程开始先读取它，结束时更新进度。

## 1. 长期目标

- 学习者主要熟悉 Python，部分不常用的 Python 概念也需要复习。
- 最终能够解释 Rubato 中每一个手写源码、测试、脚本和配置文件。
- “逐行理解”允许把共同完成一个功能的连续代码作为一个代码块讲解。
- 不只知道代码做什么，还要理解：输入输出、状态变化、调用关系、设计原因、异常路径、测试方式和面试追问。
- 最终能够不依赖 AI 独立追踪调用链、定位问题、完成小型修改并为修改补测试。

## 2. 固定教学格式

每个代码块都按以下顺序讲解：

1. 代码位置与它在调用链中的位置。
2. 这几行代码整体完成什么。
3. TypeScript / JavaScript / Node.js 语法。
4. 对应的 Python 写法或概念；必要时先复习 Python。
5. 输入、返回值和副作用。
6. 正常路径、边界情况和异常路径。
7. 为什么采用当前设计，以及可替代方案。
8. 对应测试与调试办法。
9. 面试可能如何追问。
10. 学习者用自己的话复述，或完成一个很小的练习。

### 节奏偏好

- 使用“源码驱动快节奏”：优先展示 Rubato 的真实代码并解释其实际行为，不先展开大段通用语言教程。
- TypeScript、JavaScript、Node.js 或遗忘的 Python 概念只在当前代码确实用到时就地补充。
- 理解检查必须直接基于刚讲过的项目代码，优先采用调用结果判断、代码修改、错误定位和运行链追踪。
- 已经理解的基础概念不重复出脱离项目的抽象题。
- 2026-08-08 起进入面试冲刺模式：面试在次日，暂缓“每个文件逐行穷尽”的长期目标，先覆盖面试高频主链；检查题不再作为继续课程的阻塞条件。
- 冲刺教学形式改为逐题模拟面试：一次提出一个基于 Rubato 真实实现的问题；学习者先作答，再给出面试评价、遗漏点、优化答案和连续追问。
- 模拟面试必须以简历可见信息为入口，不能假设面试官提前阅读源码。参考简历：`黄庄晟-香港中文大学-游戏AI开发工程师（Agent方向）.pdf`。Rubato 可见要点为项目动机、ReAct 与 12 类工具、Subagent/worktree、文件式记忆、Plan/权限/Git 风险；只有候选人主动提到实现后，面试官才沿回答追问具体模块。

## 3. 学习范围

需要覆盖：

- 根目录：`package.json`、`tsconfig.json`、`vitest.config.ts`、`bin/`、`scripts/` 和必要配置。
- `src/` 下全部手写 TypeScript 源码。
- `test/` 下全部测试；测试跟随对应实现学习，而不是最后集中背诵。
- README 中体现架构和行为契约的部分。

默认不逐行学习：

- `node_modules/` 第三方依赖源码。
- `dist/` 编译产物；只选取少量文件说明 TypeScript 如何编译成 JavaScript。
- `package-lock.json` 的每个依赖条目；只解释 lockfile 的用途和关键结构。
- 测试 fixture 中纯粹重复、仅作为输入数据的内容；仍需说明它为何存在。

## 4. 课程路线

### 阶段 A：运行语言与启动链

- [x] A0 学习契约、阅读方法、JavaScript/TypeScript/Node.js 三者关系
- [ ] A1 `package.json`、`tsconfig.json`、`vitest.config.ts`、`bin/rubato`、构建脚本
- [ ] A2 `src/cli/options.ts`、`config-loader.ts`
- [ ] A3 `src/cli/entry.ts`：从模块加载到 `main()`
- [ ] A4 REPL 输入、剪贴板、流式渲染和命令处理

### 阶段 B：核心类型与 Agent Runtime

- [ ] B1 `src/shared/core-types.ts`（随用随学，再完整回顾）
- [ ] B2 `src/model/`：Provider 抽象和厂商协议适配
- [ ] B3 `src/runtime/context-assembler.ts` 与 `src/context/`
- [ ] B4 `src/agent/loop.ts`
- [ ] B5 `src/runtime/step-executor.ts`
- [ ] B6 `src/runtime/tool-runtime.ts` 与压缩控制
- [ ] B7 session 的 catalog、storage、manager、meta

### 阶段 C：工具、权限与安全

- [ ] C1 registry、ReadGuard、路径处理
- [ ] C2 Read/Grep/Glob
- [ ] C3 Write/Edit/Bash
- [ ] C4 Web、Todo、Plan、Skill、MCP、记忆工具
- [ ] C5 permissions、policy engine 和 sandbox 各层
- [ ] C6 scrub 与安全加固测试

### 阶段 D：Prompt 与 Plan Mode

- [ ] D1 prompt 类型、静态提示、动态提示和 assembler
- [ ] D2 AgentModeController 与 Plan 命令
- [ ] D3 Plan 工具限制、提交和批准流程

### 阶段 E：Subagent 与 Worktree

- [ ] E1 Agent/Task 工具和自定义 agent 定义
- [ ] E2 registry、scheduler、task-runner
- [ ] E3 subagent-runtime、conversation inbox、artifact store
- [ ] E4 coverage、redaction、trace sink
- [ ] E5 worktree manager、并发限制和生命周期测试

### 阶段 F：文件式记忆系统

- [ ] F1 类型、路径、card、catalog、repository
- [ ] F2 observation、outcome、access、control events
- [ ] F3 bootstrap、project scan、extractor、fast extractor
- [ ] F4 runtime、scheduler、release、hard purge
- [ ] F5 dream、dream runner、dream worker
- [ ] F6 user model、上下文召回和 CLI 命令

### 阶段 G：Git 工具与综合掌握

- [ ] G1 Git hooks、preflight、advisor、branch health
- [ ] G2 archaeology、semantic blame、team radar 等解释型工具
- [ ] G3 从一次用户输入完整追踪到持久化结果
- [ ] G4 独立修改、测试、调试和模拟面试

## 5. 当前进度

- 当前课程：记忆系统专项面试深挖
- 当前入口：先还原旧 SQLite/Mnemosyne 自进化 RAG 的存储、检索、动态反馈、遗忘机制和论文映射；再逐条学习当前文件式记忆的生命周期与设计取舍。详细事实记录在 `docs/source-study/MEMORY_INTERVIEW_DOSSIER.md`。
- 已知基础：学习者大致了解 Agent Runtime、Subagent、文件式记忆、Git 工具和 Plan Mode 的架构概念，但不了解具体实现。
- 教学注意：不能假设 Python 的生成器、异步迭代器、协议类型、闭包、事件循环等概念仍然熟练；遇到时先复习。
- A0 第一次理解检查结果：
  - 已初步掌握：TypeScript 最终编译为 JavaScript；`build` 用于正式构建。
  - 需要巩固：Node.js 才是执行 JavaScript 的运行环境；`interface` 的静态契约作用；可选字段 `?`；静态类型不能验证运行时外部数据；`dev` 与“检测”不同；不能按括号位置区分类型与运行时值。
  - 典型误区：把字符串字面量 `"utf8"` 判断为类型信息。实际上它是传给 `fs.readFile` 的运行时参数。
- A0 第二次理解检查结果：
  - 已掌握：`interface` 编译后不存在，主要用于静态检查；可选字段 `?` 的基本语义；能够正确判断 `{ content: "ok" }` 与 `{ content: "failed", isError: true }` 符合接口，而字符串形式的 `isError` 不符合。
  - 仍需确认：应表述为 `: string` 整体在编译后消失，而不是含糊地说 `string`；没有实际写出删除类型后的 JavaScript；仍把 `build` 误认为直接运行程序。
  - 精确命令区别：`dev` 用 `tsx` 直接执行 TypeScript 源码；`build` 用 `tsc` 检查并生成 `dist` JavaScript，不启动应用；`test` 用 Vitest 执行测试。
- A0 最终结果：通过。学习者最终能够正确把 `function multiply(x: number, y: number): number` 转换为删除全部类型标注后的 JavaScript，并记住 `tsx` 用于开发期直接执行 TypeScript。
- A1.1 状态：已讲解 `package.json` 第 1–22 行。学习者表示已理解 npm、bin、CLI 与 IDE 的区别，并要求后续加快速度、完全基于项目代码教学和出题。
- 面试冲刺顺序：① 启动/构建与 Agent Runtime；② Provider/Context/Prompt/Session；③ 工具/权限/安全；④ Plan/Subagent/Worktree；⑤ 文件记忆/Git；⑥ 面试问答与项目陈述。
- 下一步：完成冲刺第 1 轮的代码检查后，立即进入第 2 轮，不因小题错误长期停留。

## 6. 每次课程结束时必须更新

- 当前课程和读到的准确文件/行号。
- 已覆盖的代码块。
- 学习者已经能独立解释的内容。
- 仍模糊或答错的概念。
- 本节练习及结果。
- 下一次从哪里继续。

## 7. 恢复学习的固定提示词

如果开启了新对话，只需发送：

> 请读取 `docs/source-study/LEARNING_LEDGER.md`，继续 Rubato 源码课程。严格从“当前进度”恢复，并在本节结束后更新学习档案。
