# 第四章 Agent Runtime 源码研究笔记

## 研究边界

- 上游仓库：`https://github.com/earendil-works/pi.git`
- 固定 tag：`v0.84.3`
- 固定 commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- 主范围：低层 `Agent`、Coding Agent `AgentSession` / `SessionManager` / extensions / resources / runtime services，以及 Harness v2 的 Session、lane、reducer、JSONL storage、`NodeExecutionEnv` 和 `AgentHarness` scaffold。
- 排除：Pi `main`、把 `packages/agent/docs/harness.md` 的目标规格冒充当前运行事实、应用 UI 自己的状态实现。
- 核验方式：逐文件读取固定源码和测试源码。`upstream/pi/node_modules`、`packages/agent/node_modules` 和 Vitest CLI 均不存在，因此没有运行上游测试；下文 `test` 仅表示静态核对测试与断言。

证据类型：

- `contract`：公开类型、接口、注释或明确标注的 implementation specification。
- `source`：固定 commit 实现直接表现的行为。
- `test`：固定 commit 的测试源码；本次未执行。
- `inference`：组合多处证据得到的教学结论，不能冒充源码原词。

## 最小心智模型

当前真正可运行的产品链：

```text
interactive / print / rpc host
  -> AgentSessionRuntime       // 跨 session/cwd 替换整个 runtime
  -> AgentSession              // 资源、扩展、持久化、重试、压缩、树导航
  -> Agent                     // 单 active Run、事件 settlement、transcript
  -> runAgentLoop              // Turn、模型请求、工具循环
```

当前 Harness v2 必须拆开理解：

```text
已实现：Session v4 / lane / JSONL storage / reducer / ExecutionEnv / tools
未实现：AgentHarness prompt / resume / abort / queue / drive / watch / lane orchestration
```

## 16 条 evidence map 候选

### AR-01 [contract + source + test] Core `AgentState` 的所有权边界

**结论：** `AgentState` 只包含 system prompt、model、thinking level、tools、messages，以及当前 Run 的 streaming message、pending tool ids 和 error。`Agent` 拥有 transcript、生命周期事件、工具执行与 steer/follow-up 队列，不拥有项目资源、JSONL、UI 或任意业务 application state。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentState`
- 辅助行：333-358
- file：`packages/agent/src/agent.ts`
- symbol：`createMutableAgentState`, `Agent`
- 辅助行：61-95, 167-177

**测试锚点：** `packages/agent/test/agent.test.ts`，`should create an agent instance with default state`、`should update state with mutators`。

### AR-02 [contract + source] Run / Turn 的教学映射

**结论：** 本书把 `agent_start -> agent_end` 映射为一个 Run；`turn_start -> turn_end` 是一次 assistant response 加其工具调用/结果。Core 没有公开 `Run` class，只有私有 `ActiveRun` 与事件边界；Session 则跨多个 Run。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentEvent`
- 辅助行：421-443
- file：`packages/agent/src/agent.ts`
- symbol：`ActiveRun`, `Agent.runPromptMessages`, `Agent.runContinuation`
- 辅助行：161-165, 409-435

### AR-03 [source + test] 一个 `Agent` 同时只允许一个 active Run

**结论：** active Run 存在时，新的 `prompt()` / `continue()` 会拒绝；运行中的输入必须进入 steer/follow-up 队列或等待。`abort()` 只发协作式 AbortSignal，`reset()` 也要求先 idle。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.prompt`, `Agent.continue`, `Agent.abort`, `Agent.reset`, `Agent.runWithLifecycle`
- 辅助行：313-388, 486-509

**测试锚点：** `packages/agent/test/agent.test.ts`，`should throw when prompt() called while streaming`、`should throw when continue() called while streaming`。

### AR-04 [source + test] async event listener 属于 Core Run settlement

**结论：** `processEvents` 先归约状态，再按订阅顺序逐个 `await` listener。即使已发 `agent_end`，`prompt()`、`waitForIdle()` 与 `isStreaming=false` 仍要等其 listener 完成；`agent_end` 表示无后续 loop event，不等于已经 idle。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.subscribe`, `Agent.waitForIdle`, `Agent.finishRun`, `Agent.processEvents`
- 辅助行：240-253, 323-330, 529-590

**测试锚点：** `packages/agent/test/agent.test.ts`，async subscribers 与 `waitForIdle` 两个测试，辅助行 190-261。

### AR-05 [source + test] `AgentSession` 的一次用户操作可跨多个 Core Run

**结论：** `AgentSession` 服务 interactive、print、rpc，叠加 persistence、extensions、retry、compaction、bash 和 tree navigation。`_runAgentPrompt` 在 `agent.prompt()` 后可能因 retry、auto-compaction 或 `agent_end` handler 新排队消息多次 `agent.continue()`，最终才发 `agent_settled`。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSession`, `_runAgentPrompt`, `_handlePostAgentRun`, `_emitAgentSettled`
- 辅助行：1-14, 307-408, 607-615, 1074-1115

**测试锚点：** `packages/coding-agent/test/suite/regressions/6363-agent-settled-event.test.ts`，`agent_settled` 与 session-level idle tests。

### AR-06 [source] Core event 到扩展、UI 与 Session persistence 的顺序

**结论：** `AgentSession` 是 Core `Agent.subscribe()` 的 async listener：先更新队列显示，再 await extension event，再同步通知 AgentSession listeners，最后在 `message_end` append 到 `SessionManager`。Core 会等待整个 handler，因此 message persistence 属于 Run settlement；AgentSession 自己的 UI listeners 是同步调用，不等待 Promise。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSession.constructor`, `_handleAgentEvent`, `_emitExtensionEvent`, `subscribe`
- 辅助行：382-408, 620-836

### AR-07 [contract + source + test] Coding Agent Session 是 append-only JSONL entry tree

**结论：** 每个 entry 有 `id/parentId/timestamp`；append 接到当前 leaf 并推进 leaf。加载时 `_buildIndex` 把物理最后 entry 设为 leaf。`branch(id)` 只移动内存 leaf，下一次 append 才形成新 child；旧 entry 不改不删。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/session-manager.ts`
- symbol：`SessionEntryBase`, `SessionManager._buildIndex`, `_appendEntry`, `getBranch`, `getTree`, `branch`
- 辅助行：46-53, 958-977, 1044-1067, 1260-1365

**测试锚点：** `packages/coding-agent/test/session-manager/tree-traversal.test.ts` 与 `agent-session-branching.test.ts`。

### AR-08 [source + test] 恢复从 leaf 路径和最新 compaction 重建 context

**结论：** `buildSessionPath` 从 leaf 沿 parent 回 root；model/thinking 从整条路径归约。`buildContextEntries` 再选择最新 compaction，用 summary、`firstKeptEntryId` 后保留尾部和 compaction 后 entries 组成上下文；其他 branch 不自动进入模型。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/session-manager.ts`
- symbol：`buildSessionPath`, `getSessionContextSettings`, `buildContextEntries`, `buildSessionContext`
- 辅助行：334-469

**测试锚点：** `packages/coding-agent/test/session-manager/build-context.test.ts`，`describe("buildSessionContext")`。

### AR-09 [source + test] Resume、同文件 branch 与 fork 是不同操作

**结论：** `open()` / `continueRecent()` 恢复并继续写同一文件；`branch()` 在同一文件移动 leaf；`createBranchedSession()` 抽取 root-to-leaf 路径到新 id/file 并记录 `parentSession`；`forkFrom()` 跨 cwd 复制全部非 header entries。不要把这些都简写成“恢复会话”。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/session-manager.ts`
- symbol：`SessionManager.open`, `continueRecent`, `branch`, `createBranchedSession`, `forkFrom`
- 辅助行：1354-1512, 1531-1631

**测试锚点：** `packages/coding-agent/test/session-manager/file-operations.test.ts`、`agent-session-branching.test.ts`。

### AR-10 [contract + source + inference] Application state 不由 Core Session 自动拥有

**结论：** Session 自动保存的只是已定义 entry。扩展状态必须显式 `appendCustomEntry(customType, data)`，reload 时扫描并自行重建；`CustomEntry` 不进 LLM context，`CustomMessageEntry` 才进。因此 UI 路由、业务工作流、审批状态等 application state 不会因使用 Agent/Session 就自动持久化，宿主必须自持或显式映射。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/session-manager.ts`
- symbol：`CustomEntry`, `CustomMessageEntry`, `sessionEntryToContextMessages`, `appendCustomEntry`, `appendCustomMessageEntry`
- 辅助行：94-153, 379-407, 1121-1188
- file：`packages/coding-agent/src/core/extensions/runner.ts`
- symbol：`ExtensionRunner.bindCore`
- 辅助行：314-351

### AR-11 [source] Extension runner 是 Coding Agent 的可编程控制面

**结论：** 扩展可注册 command/tool/provider 和 hooks。command 在 prompt preflight 直接执行；`before_agent_start` 可注入消息/改 system prompt；`context` 每次请求前转换 messages；`tool_call` 可 block，`tool_result` 可改 content/details/error/usage。session replacement/reload 会 invalidate 旧 context。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/extensions/types.ts`
- symbol：`ExtensionAPI`, `ExtensionCommandContext`, `ExtensionEvent`
- 辅助行：355-396, 1068-1139, 1232-1295
- file：`packages/coding-agent/src/core/extensions/runner.ts`
- symbol：`getCommand`, `emitToolCall`, `emitToolResult`, `emitContext`, `emitBeforeAgentStart`, `invalidate`
- 辅助行：543-569, 652-669, 877-1014, 1081-1145
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`_tryExecuteExtensionCommand`, `dispose`
- 辅助行：846-867, 1287-1313

### AR-12 [contract + source + test] ResourceLoader 与 cwd-bound runtime services

**结论：** `ResourceLoader` 统一暴露 extensions、skills、prompts、themes、AGENTS files 和 system/append prompt。`createAgentSessionServices` 为一个 cwd 创建 `ModelRuntime`、`SettingsManager`、`DefaultResourceLoader`，处理扩展 providers 与 flags，但不创建 AgentSession；cwd 变化时这一组 services 整体重建。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/resource-loader.ts`
- symbol：`ResourceLoader`, `DefaultResourceLoader`, `DefaultResourceLoader.reload`
- 辅助行：30-52, 159-275, 409-547
- file：`packages/coding-agent/src/core/agent-session-services.ts`
- symbol：`AgentSessionServices`, `createAgentSessionServices`, `createAgentSessionFromServices`

**测试锚点：** `packages/coding-agent/test/resource-loader.test.ts`。

### AR-13 [source] `AgentSessionRuntime` 拥有跨 Session 的整体替换

**结论：** `/new`、resume、fork、import 不是在原 `AgentSession` 上换几条 message；runtime 先 abort/settle、发 shutdown、invalidate/dispose 旧 session，再按目标 cwd 重建 services/session，最后 rebind host。`AgentSession` 只负责同文件 `navigateTree`。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/agent-session-runtime.ts`
- symbol：`AgentSessionRuntime`, `teardownCurrent`, `switchSession`, `newSession`, `fork`, `importFromJsonl`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSession.navigateTree`
- 辅助行：3019 起

### AR-14 [contract + source + test] `NodeExecutionEnv` 是宿主注入的 Node adapter

**结论：** Harness 的 `ExecutionEnv` 抽象组合 FileSystem 与 Shell；`NodeExecutionEnv` 才实现 cwd/path、spawn、abort/timeout、stream callbacks、文件 I/O/rename/remove 与 best-effort cleanup。它从独立 `./node` entrypoint 导出，说明 Core/Harness 不会凭空获得 OS 能力。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/harness/types.ts`
- symbol：`FileSystem`, `Shell`, `ExecutionEnv`
- 辅助行：222-315
- file：`packages/agent/src/harness/env/nodejs.ts`
- symbol：`NodeExecutionEnv`
- 辅助行：347-695
- file：`packages/agent/src/node.ts`
- symbol：Node entrypoint exports

**测试锚点：** `packages/agent/test/harness/nodejs-env.test.ts`，`describe("NodeExecutionEnv")`。

### AR-15 [contract + source + test + inference] Harness v2 基础件已实现，但 driver 仍是 scaffold

**结论：** `harness.md` 是 durable runtime 的 implementation specification：Session 管 tree/facts/lanes/usage，Harness 驱动 operations。当前 `Session` 已实现 lane/view/entry/record queries，`validateRecordLog` / `reduceLaneState` 已能纯推导恢复状态；但 `AgentHarness.create` 只接受无 record session，restore、prompt、resume、abort、queue、drive、watch、lane API 全部抛 `HarnessNotImplemented`，hooks/events registration 也不可用。因此不能宣称 Harness v2 已接管 Coding Agent 或已支持崩溃恢复。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/docs/harness.md`
- symbol：`0.1 What this is`, `0.2 System model`, `Part 8 - Build order`
- 辅助行：80-109, 2782-2815
- file：`packages/agent/src/harness/session/session.ts`
- symbol：`Session.view`, `createLane`, `moveLane`, `appendRecord`, `findOpenOperations`
- 辅助行：115-132, 186-220
- file：`packages/agent/src/harness/reducer.ts`
- symbol：`validateRecordLog`, `reduceLaneState`
- 辅助行：312-390, 506-667
- file：`packages/agent/src/harness/agent-harness.ts`
- symbol：`HarnessNotImplemented`, `UnavailableRegistry.on`, `AgentHarness.create`, `unavailable`
- 辅助行：74-82, 219-235, 305-451

**测试锚点：** `packages/agent/test/harness/agent-harness-scaffold.test.ts`、`reducer.test.ts`、`harness/session/testing/conformance.ts`。

### AR-16 [contract + source + test] 当前 Session v4 storage 的原子性边界

**结论：** 当前 `SessionStorage` 只有单项 append entry/record、lane 和 fact 写入，没有 `commit(Transaction)`。JSONL storage 用 Promise `tail` 串行化，每项先 append 一行再 apply；append 失败不推进 state。fork 与 torn-tail repair 采用 sibling `.tmp` + atomic rename，失败保留原文件。目标规格中的 entries/registers/usage 多写 all-or-none transaction 尚未落地，不能把“原子文件发布”扩大成“operation transition 已事务化”。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/harness/session/types.ts`
- symbol：`SessionStorage`
- 辅助行：290-326
- file：`packages/agent/src/harness/session/jsonl/storage.ts`
- symbol：`publishFileAtomically`, `JsonlSessionStorage.load`, `fork`, `enqueue`, `appendMutation`
- 辅助行：23-46, 69-120, 134-190, 258-275
- file：`packages/agent/docs/harness.md`
- symbol：`1.4 Transactions`, `Part 8 - Build order`

**测试锚点：**

- `packages/agent/src/harness/session/testing/conformance.ts`：共享 backend conformance。
- `packages/agent/test/harness/session/jsonl-storage.test.ts`：跨 lane sequence、payload validation、append failure。
- `packages/agent/test/harness/session/jsonl.test.ts`：partial fork、rename failure、torn-tail/interior corruption。

## Ownership 边界

| 层 | 当前固定版本真正拥有 | 明确不自动拥有 |
|---|---|---|
| Low-level `Agent` | 单 active Run、transcript、模型/工具快照、队列、AbortSignal、事件 settlement | JSONL、项目资源、扩展命令、UI/业务 state |
| Coding Agent `AgentSession` | 现行产品 runtime：资源、extensions、消息持久化、retry/compaction/bash、同文件 tree navigation、`agent_settled` | 跨 session/cwd replacement；宿主 UI/业务 state |
| `AgentSessionRuntime` | new/resume/fork/import 时 teardown/recreate/rebind cwd-bound runtime | Agent Loop 本身；用户界面决策 |
| Harness v2 Session 基础件 | durable entry/record、lane pointer、facts、queries、reducer、JSONL conformance | 已完成的 prompt/tool/recovery driver |
| Harness v2 `AgentHarness` | scaffold-safe 配置/资源访问与 close | prompt、resume、abort、queue、drive、watch、lane orchestration |
| Application | UI、路由、业务实体、审批/任务状态、跨会话协调 | 不会被 Core Session 自动推断或持久化 |

## 必须谨慎表述的边界

1. 上游依赖不存在，本次只静态核对测试源码；不能写“Vitest 已通过”。
2. `Run` 是本书的事件边界教学术语，不是 Core 公共类型。
3. 一个 `AgentSession` 用户操作可能跨多个 Core Run；产品层稳定点是 `agent_settled`，不是第一次 `agent_end`。
4. Coding Agent `SessionManager` 是 `CURRENT_SESSION_VERSION = 3`；Harness 包下另有 Session v4。两者不是同一 JSONL schema。
5. `packages/agent/docs/harness.md` 是目标 implementation specification，其 transaction/register/program-counter 设计不能当成当前运行行为。
6. Harness v2 的 Session、lane、reducer、ExecutionEnv 有实现和测试源码，但 `AgentHarness` driver 仍明确未实现。
7. atomic rename 只覆盖 fork publication 与 torn-tail repair；普通多步骤 operation 没有多写 transaction 原子性。
8. Application state 不由 Core Session 自动拥有，只有宿主自己的持久层或显式 custom entry 才算保存。
