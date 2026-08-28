# 第五章 Agent Application Engineering 源码研究笔记

## 研究边界

- 上游仓库：`https://github.com/earendil-works/pi.git`
- 固定 tag：`v0.84.3`
- 固定 commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- 范围：低层 `Agent` / Agent Loop、Coding Agent `AgentSession` / `SessionManager`、`pi-ai` 的消息与 Usage、`pi-telemetry` contract、Session stats/export，以及本仓库尚未实施的统一比较接口。
- 排除：Pi `main`、任何未落地的 Harness v2 driver 行为、提前实现 `comparisons/`、凭空描述 LangGraph 内部实现。
- 核验方式：逐文件静态读取固定源码、文档与测试源码，并全局搜索 production call site。`upstream/pi/node_modules`、`packages/agent/node_modules`、`packages/coding-agent/node_modules` 均不存在，因此本次没有运行上游测试；下文 `test` 只表示测试源码证据，不表示测试已通过。

证据类型：

- `contract`：公开类型、接口、schema 或文档声明。
- `source`：固定 commit 的实现直接表现的行为。
- `test`：固定 commit 的测试源码；本次未执行。
- `inference`：组合多处证据得到的应用工程结论，不能冒充 Pi 的类型或术语。

## 先给第五章的总边界

```text
Pi 已提供                    应用仍必须补齐
Agent/AgentSession events  -> trace id、接收时间、关联与存储策略
stopReason / isError       -> failure taxonomy、业务结果与可重试策略
Usage / SessionStats       -> run/case 粒度指标、latency、成功率
Session JSONL / HTML       -> dataset schema、标注、evaluator、回归门禁
Agent primitives          -> Autonomous / Workflow / Hybrid 的产品编排
```

## 16 条 evidence map 候选

### AE-01 [contract + source + test] `AgentEvent` 是可重建 Run 的实时事件骨架

**结论：** 低层 `Agent` 发出 `agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`。它足以按 `toolCallId` 关联一次 Run 内的模型流与工具调用，但事件本身没有统一 event id、run id 或接收时间；`message` 才自带 provider/model/usage/stopReason/timestamp。因此它是 trace 原料，不是完成品 trace store。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentEvent`, `AgentContext`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runAgentLoop`, `runLoop`, `streamAssistantResponse`, `executeToolCallsSequential`, `executeToolCallsParallel`

**测试锚点：** `packages/agent/test/agent.test.ts`、`packages/agent/test/agent-loop.test.ts` 的生命周期与工具事件断言。

### AE-02 [contract + source + test] 产品级 trace 的终点是 `agent_settled`

**结论：** `AgentSessionEvent` 在 Core 事件外补充 `willRetry`、`agent_settled`、队列、compaction、retry、summarization retry、entry append 和 bash update。一次用户操作可能跨自动重试、压缩和多个 Core Run；评测 Run 的 wall-clock 终点应取 `agent_settled`，不能取第一次 `agent_end`。事件 listener 仍不自动计时，应用要在收到事件时记录单调时钟。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSessionEvent`, `_handleAgentEvent`, `_handlePostAgentRun`, `_emitAgentSettled`, `waitForIdle`
- file：`packages/coding-agent/src/core/extensions/types.ts`
- symbol：`AgentSettledEvent`, `ExtensionEvent`

**测试锚点：** `packages/coding-agent/test/suite/regressions/6363-agent-settled-event.test.ts`、`agent-session-retry.test.ts`。

### AE-03 [contract + source + test + inference] Typed telemetry schema 已定义，但未自动接入当前 Agent Loop

**结论：** `pi-telemetry` 定义 backend-neutral `TelemetryContext/TelemetrySpan`、no-op 与内存实现；Agent 包定义 `pi.ai.request` 和一组 `pi.harness.*` span schema，包含 provider/model/stop reason/token/cost/chunk count/TTFC 等字段。固定源码的 production call site 只导出 schema/helper，并让 `ProviderRequestOptions` 携带可选 `telemetryContext`；全局静态搜索未发现 `Agent`、`AgentSession` 或 provider 自动调用 `startAiSpan/startHarnessSpan`。所以这些是可复用 contract，不是“开箱即有完整 tracing”。Harness driver 本身仍是 scaffold，更不能宣称 harness spans 已实际覆盖运行。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/telemetry/src/index.ts`
- symbol：`TelemetryContext`, `TelemetrySpan`, `createTypedSpanStarter`
- file：`packages/telemetry/src/noop.ts`
- symbol：`NOOP_TELEMETRY_CONTEXT`
- file：`packages/telemetry/src/memory.ts`
- symbol：`InMemoryTelemetryContext`
- file：`packages/agent/src/harness/telemetry.ts`
- symbol：`AI_TELEMETRY_SCHEMA`, `HARNESS_TELEMETRY_SCHEMA`, `startAiSpan`, `startHarnessSpan`
- file：`packages/ai/src/types.ts`
- symbol：`ProviderRequestOptions.telemetryContext`

**测试锚点：** `packages/telemetry/test/telemetry.test.ts`、`packages/agent/test/harness/telemetry.test.ts`；均只静态核对，未运行。

### AE-04 [source + test + inference] Session 是可复盘记录，不等于完整实验 trace

**结论：** `AgentSession` 在 `message_end` 后把 user/assistant/toolResult 写入 append-only Session entry；Session 还保存 model/thinking/compaction/branch/custom entries。`exportToJsonl()` 只导出当前 root-to-leaf branch 并重写 parent 链，`exportToHtml()` 导出全部 entries、leafId、可选 system prompt/tool definitions 用于人工复盘。两种导出都没有 case id、evaluator result、wall latency 或成功标签，因此只能作为 dataset 原料。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`_handleAgentEvent`, `exportToHtml`, `exportToJsonl`
- file：`packages/coding-agent/src/core/session-export.ts`
- symbol：`exportSessionToJsonl`
- file：`packages/coding-agent/src/core/export-html/index.ts`
- symbol：`exportSessionToHtml`, `exportFromFile`

**测试锚点：** `packages/coding-agent/test/export-jsonl-share.test.ts`、`suite/regressions/5596-missing-theme-export.test.ts`。

### AE-05 [contract + source + inference] `stopReason` 是协议终止原因，不是业务成功分类

**结论：** `StopReason` 有 `pending | stop | length | toolUse | error | aborted | deferred`。`pending` 是流中态，`toolUse` 是继续执行工具的控制信号，`length` 表示输出截断，`deferred` 是延迟执行，只有 `error/aborted` 会让 Agent Loop 立即终止。即使是 `stop`，也只代表 provider 正常结束本次响应，不能据此判定用户任务成功。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/types.ts`
- symbol：`StopReason`, `AssistantMessage`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runLoop`, `failToolCallsFromTruncatedMessage`

### AE-06 [source + test + inference] Tool failure 与模型/provider failure 是两条独立轴

**结论：** 找不到 tool、参数校验失败、hook block/throw、tool execute throw、after-hook throw、被 abort 或 length 截断，都会被规范化为 `ToolResultMessage.isError=true` 并发出 `tool_execution_end`；单个工具失败通常仍进入下一轮，让模型有机会修复。它不改 assistant 的 `stopReason`，也不自动使整次任务失败。评测必须同时记录 assistant outcome 与每个 tool outcome。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`prepareToolCall`, `executePreparedToolCall`, `finalizeExecutedToolCall`, `createToolResultMessage`, `shouldTerminateToolBatch`
- file：`packages/ai/src/types.ts`
- symbol：`ToolResultMessage`

**测试锚点：** `packages/agent/test/agent-loop.test.ts` 的 missing/invalid/throwing/blocked tool cases。

### AE-07 [contract + source + inference] Provider 与 runtime 异常最终都可能落为 `stopReason=error`

**结论：** `StreamFn` contract 要求 request/model/runtime failure 通过最终 assistant error message 返回，而不是 reject；各 provider adapter 会设置 `errorMessage/rawStopReason`，部分路径附带 redacted `diagnostics`。若 transform、listener 或自定义 stream 违反 contract 抛错，`Agent.handleRunFailure()` 也合成 `EMPTY_USAGE + stopReason=error` 的 assistant message。仅看最终 stopReason 无法可靠区分 provider、transport、extension、listener 或宿主错误；应用要在边界处保留稳定 `failure.layer/failure.code/retryable`。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`StreamFn`
- file：`packages/agent/src/agent.ts`
- symbol：`runWithLifecycle`, `handleRunFailure`
- file：`packages/ai/src/types.ts`
- symbol：`AssistantMessage`
- file：`packages/ai/src/utils/diagnostics.ts`
- symbol：`AssistantMessageDiagnostic`, `createAssistantMessageDiagnostic`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`_isRetryableError`, `_prepareRetry`

### AE-08 [inference] Application failure 必须由业务验收定义

**结论：** Pi 的公开结果没有 `taskSuccess`、expected state、grader score 或业务 error type。一次 `stop` 可能答非所问，一串 `isError=false` 工具调用也可能修改错文件；反过来，一次中间 tool error 可能被后续修复。第五章应使用五层失败分类：`provider`、`model/protocol`、`tool`、`runtime`、`application`，最终成功只由 Case evaluator 判定。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/types.ts`
- symbol：`AssistantMessage`, `ToolResultMessage`, `StopReason`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`SessionStats`

**边界证据：** `SessionStats` 只有消息数、tool 数、token、cost、contextUsage，没有业务结果字段。

### AE-09 [contract + source] `Usage` 的字段语义必须原样保留

**结论：** `Usage` 分开记录 `input/output/cacheRead/cacheWrite`，可选 `cacheWrite1h` 与 `reasoning`，以及 `totalTokens` 和分项/总 cost。`reasoning` 是 `output` 的子集，不能再加一次；tool result 的可选 Usage 不属于主 LLM context accounting。Session 汇总的 `tokens.total` 重新相加四个主 token 字段，而不是盲信每条 `totalTokens`。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/types.ts`
- symbol：`Usage`, `AssistantMessage`, `ToolResultMessage`
- file：`packages/coding-agent/src/core/usage-totals.ts`
- symbol：`UsageTotals`, `addUsageToTotals`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`getSessionStats`

### AE-10 [source + test] Cost 来自模型价目与 provider usage，不是应用自己猜测

**结论：** `calculateCost()` 用请求总 input（含 cache read/write）选择最高匹配 pricing tier，再按每百万 token 计算 input/output/cacheRead/cacheWrite；Anthropic 1h cache write 按 base input 的 2 倍计价，最后求 total。不同 provider/model、动态 responseModel、免费/订阅路由会让价格口径不同，因此对照实验必须锁定 model/provider/routing 和 cost catalog snapshot，且展示原始 token 与 cost，不能只比较美元总数。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/models.ts`
- symbol：`calculateCost`
- file：`packages/ai/src/types.ts`
- symbol：`Model`, `ModelCost`, `Usage`
- file：`packages/coding-agent/src/core/usage-totals.ts`
- symbol：`getUsageCostBreakdown`

**测试锚点：** `packages/ai/test/models-runtime.test.ts`、`anthropic-cache-write-1h-cost.test.ts`、`packages/coding-agent/test/agent-session-stats.test.ts`。

### AE-11 [contract + source + test] `SessionStats` 是账本统计，不是评测报表

**结论：** `getSessionStats()` 扫描 Session 的全部 entries，包括已压缩掉的历史、branch summary、compaction 和带 Usage 的 tool result，因此反映这个 Session 实际累计消耗；它不只统计当前 branch/context。`contextUsage` 是另一个当前上下文估计，压缩后到下一次有效 assistant response 前可为 `tokens:null`。Stats 可经 SDK/RPC 获取，但没有按 Case/Run/attempt 拆分、p50/p95 latency 或 success rate。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`SessionStats`, `getSessionStats`, `getContextUsage`
- file：`packages/coding-agent/src/modes/rpc/rpc-types.ts`
- symbol：`RpcCommand.get_session_stats`, `RpcResponse.get_session_stats`

**测试锚点：** `packages/coding-agent/test/agent-session-stats.test.ts`、`rpc.test.ts`。

### AE-12 [contract + source + inference] Latency、成功率和分位数必须由实验宿主采集

**结论：** Core events 没有统一事件 timestamp；消息 timestamp 是消息创建时间，不足以直接得到 queue wait、TTFT、tool duration、retry sleep、end-to-end latency。Telemetry schema虽预留 `time_to_first_chunk_ms/chunk_count`，当前未自动接线。应用应至少在同一 monotonic clock 上记录：prompt accepted、首个 assistant `message_start/update`、每个 tool start/end、retry/compaction、`agent_settled`，再由多次 Case attempt 计算 wall latency、TTFT、tool latency、成功率与 p50/p95。成功率分母必须是预先固定的 attempt 数，不能用 Session message 数。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentEvent`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSessionEvent`, `_emitExtensionEvent`
- file：`packages/agent/src/harness/telemetry.ts`
- symbol：`AI_TELEMETRY_SCHEMA`

### AE-13 [source + contract + inference] 固定源码没有内建 dataset/evaluator runner

**结论：** 对 `packages/agent/src`、`packages/coding-agent/src`、`packages/ai/src` 的静态搜索未发现 Dataset、Evaluator、ground truth、pass rate 或 success rate contract。仓库提供 Session JSONL/HTML 与 share export；官方 Coding Agent 文档把发布到 Hugging Face dataset 指向外部 `pi-share-hf`。所以“可导出真实 Session”不等于“已有可重复 evaluation”：第五章必须自己定义 Case dataset、fixture/setup、expected outcome、grader、attempt count、seed/temperature 等运行参数与版本。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/session-export.ts`
- symbol：`exportSessionToJsonl`
- file：`packages/coding-agent/src/modes/interactive/session-share.ts`
- symbol：`exportSessionForShare`
- file：`packages/coding-agent/docs/usage.md`
- symbol：`Exporting and Sharing Sessions`

**测试锚点：** `packages/coding-agent/test/export-jsonl-share.test.ts` 只验证导出结构，不是模型质量评测。

### AE-14 [contract + source + inference] Autonomous / Workflow / Hybrid 是应用设计词，不是 Pi runtime type

**结论：** 固定 production source 没有导出名为 `Autonomous`、`Workflow` 或 `Hybrid` 的 runtime 类型。可教学地定义：Autonomous 是让模型在 Agent Loop 内自主选择工具直到停止；Workflow 是宿主显式控制阶段、门禁和转移；Hybrid 是确定性的外层 workflow 包住一个或多个 agentic Run。Pi 提供 `Agent.prompt/continue`、`shouldStopAfterTurn`、`prepareNextTurn`、extensions 和 Session primitives 供应用组合，但不替应用选择产品形态。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`Agent`, `Agent.prompt`, `Agent.continue`, `Agent.shouldStopAfterTurn`, `Agent.prepareNextTurnWithContext`
- file：`packages/agent/src/types.ts`
- symbol：`AgentLoopConfig`, `ShouldStopAfterTurnContext`, `AgentLoopTurnUpdate`
- file：`packages/coding-agent/src/core/extensions/types.ts`
- symbol：`ExtensionAPI`, `ExtensionEvent`

### AE-15 [project contract + source + inference] 毕业比较必须先冻结同一实验接口

**结论：** 本仓库已规定 `comparisons/shared/` 统一定义 Case dataset、Tool Contract、模型与运行参数、Trace schema、Metrics，Pi/LangGraph 只做 adapter。第五章正文可以说明这个接口必须锁定：同一输入/fixture、同一 provider/model 与 temperature/reasoning/max token/retry/timeout、同名同 schema 同副作用的工具、同一 evaluator 与 attempt 数、同一 latency/token/cost/failure 归一化。当前 `shared/README.md` 明确“不提前设计字段”，所以本章只写原则，不实施 comparison。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentTool`, `AgentLoopConfig`, `AgentEvent`
- file：`packages/ai/src/types.ts`
- symbol：`Model`, `SimpleStreamOptions`, `Usage`

**项目契约锚点：** `comparisons/README.md`、`comparisons/shared/README.md`、`book/comparisons/index.md`（项目 checkout `b7c36a303761a2a1c7650f62a1d73ae8d93e0763`）。

### AE-16 [project contract + inference] Pi 与 LangGraph 只比较 adapter 可观察结果

**结论：** 固定 Pi 源码和本仓库都没有 LangGraph implementation evidence；`comparisons/langgraph/` 仍只是占位。因此第五章不能声称 LangGraph 的内部 loop、state、checkpoint 或性能如何。可比边界应限制为共享 adapter：`runCase(case, config, tools) -> normalized result + trace + metrics`。比较 task success、tool contract 行为、failure layer、wall latency、token/cost 和 trace completeness；Pi 私有事件名、Session tree 或 LangGraph 私有节点数都不能直接当跨框架优劣指标。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentEvent`, `AgentTool`, `AgentToolResult`
- file：`packages/ai/src/types.ts`
- symbol：`AssistantMessage`, `ToolResultMessage`, `Usage`

**项目契约锚点：** `comparisons/pi/README.md`、`comparisons/langgraph/README.md`、`comparisons/shared/README.md`（均未实现 adapter）。

## Failure taxonomy 建议

| 层 | 固定源码可见信号 | 不能直接推出 | 第五章统一字段建议 |
|---|---|---|---|
| Provider / transport | `stopReason=error`、`errorMessage`、`rawStopReason`、可选 `diagnostics`、HTTP response hook | 是否最终任务失败、是否一定可重试 | `failure.layer=provider`, `code`, `retryable`, `attempt` |
| Model / protocol | `length`、不完整 tool args、`toolUse`、`deferred` | 业务正确性 | `failure.layer=model`, `stopReason`, `rawStopReason` |
| Tool | `tool_execution_end.isError`、`ToolResultMessage.isError` | 整次 Run 失败 | `failure.layer=tool`, `toolName`, `toolCallId` |
| Runtime | transform/listener/custom stream throw 后合成 assistant error | 原始责任方；除非边界处另记 | `failure.layer=runtime`, `component`, `code` |
| Application | Pi 无内建字段，由 grader/业务状态判定 | 不能从 `stop` 或 tool success 猜 | `failure.layer=application`, `grader`, `expected/actual` |

## 统一比较接口只写原则，不在本章实施

```text
Case dataset + fixture/setup + expected outcome
                 |
                 v
     shared model/run config + Tool Contract
                 |
          +------+------+
          |             |
       Pi adapter   LangGraph adapter
          |             |
          +------+------+
                 v
 normalized result + trace + failure + metrics
                 |
                 v
      same evaluator / same aggregation
```

建议比较的是：

- Case success / partial score，由同一 evaluator 计算；
- wall latency、TTFT、tool latency、attempt 数与 p50/p95；
- input/output/cache token 和 cost，保留 provider/model/routing；
- provider/model/tool/runtime/application failure 分布；
- trace completeness 与可复盘性。

不应直接比较的是：

- 两边内部 event/node 数；
- 私有 Session/checkpoint 数据结构；
- 不同模型、不同工具 schema 或不同 retry policy 下的总耗时/成功率；
- 单次运行截图或一次 `stopReason=stop`。

## 必须谨慎表述的边界

1. 上游依赖不存在，本次只静态阅读测试源码；不能写“Pi 上游测试已通过”。
2. Core events 与 Session entries 是 trace 原料，不是完整 observability backend。
3. Telemetry contract/schema 已实现并有测试源码，但固定版本未自动接入 Agent/AgentSession production path。
4. Harness telemetry schema 描述目标 vocabulary；高层 `AgentHarness` driver 仍是 scaffold，不能作为已运行事实。
5. `stopReason=stop` 不是 task success；`toolResult.isError=true` 也不必然是最终 task failure。
6. `SessionStats` 是全 Session 累计账本；不是当前 branch 的 Case 报表，也没有 latency/success rate。
7. `reasoning` 已包含在 `output` 中，不能重复计 token；tool usage 与主 LLM context usage 要分开。
8. Session export/share 不是 dataset/evaluation runner；标注、grader、attempt 和聚合都由应用定义。
9. Autonomous / Workflow / Hybrid 是本书的应用设计分类，不是 Pi 公共类型。
10. 第五章完成前不实施 `comparisons/shared` 字段或任一 adapter；正文只冻结公平比较原则。
11. 没有读取或验证 LangGraph 源码，所有 LangGraph 内容只能停留在共享 adapter/实验设计边界。
