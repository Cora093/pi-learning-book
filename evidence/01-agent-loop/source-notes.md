# 第一章 Agent Loop 源码研究笔记

## 研究边界

- 上游仓库：`https://github.com/earendil-works/pi.git`
- 固定 tag：`v0.84.3`
- 固定 commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- commit 标题：`Release v0.84.3`
- 范围：`packages/agent` 的低层循环、`Agent` 状态封装，以及 `packages/ai` 中被循环直接依赖的消息流类型。
- 排除：Harness、Coding Agent UI、provider 的具体 HTTP 协议实现；这些属于后续章节。
- 核验方式：逐文件读取固定源码和对应单元测试。尝试运行 `agent-loop.test.ts` 与 `agent.test.ts`，但 submodule 未安装 `node_modules`，本机缺少 `upstream/pi/node_modules/vitest/dist/cli.js`，因此本文中的“测试证据”表示已静态核对测试源码，不表示本次运行通过。

状态说明：

- `verified-source`：已读取固定 commit 的实现。
- `verified-contract`：已读取固定 commit 的公开类型或注释契约。
- `verified-test-source`：已读取固定 commit 的测试及断言，但本次未执行。
- `inference`：由多个已核验 symbol 组合得到，文中会明确标注。

## 先给出最小心智模型

在本章语境中，可以先把一次执行看成两层：

```text
Run
├─ agent_start
├─ Turn 1
│  ├─ turn_start
│  ├─ 一次模型流 -> 一个最终 AssistantMessage
│  ├─ 该消息中的 0..N 个工具调用 -> 0..N 个 ToolResultMessage
│  └─ turn_end
├─ Turn 2 ...（由工具结果、steering 或 follow-up 触发）
└─ agent_end
```

这里 `Turn` 有公开类型注释定义；`Run` 没有独立的公开领域类型，本文用它指 `agent_start` 到 `agent_end` 的一次 `prompt()` / `continue()` 生命周期。这一区分分别由 E01、E02 支持。

一条有工具调用的代表性端到端路径是：

```text
Agent.prompt
  -> runWithLifecycle（创建 AbortController，isStreaming=true）
  -> runAgentLoop（加入 prompt，发 agent_start / turn_start / prompt message events）
  -> runLoop
  -> streamAssistantResponse
       transformContext
       -> convertToLlm
       -> streamFunction(model, llmContext, options + signal)
       -> start / delta* / done|error
       -> 最终 AssistantMessage
  -> 从 AssistantMessage.content 取出 toolCall
  -> prepare / validate / beforeToolCall
  -> execute / afterToolCall
  -> ToolResultMessage
  -> turn_end
  -> prepareNextTurn
  -> shouldStopAfterTurn
  -> steering poll
  -> 下一 Turn，或 follow-up poll，或 agent_end
  -> 等待事件 listener 完成
  -> finishRun（isStreaming=false）
```

这条组合路径是 `inference`，不是单个函数的原文注释；组成它的实现锚点是：

- `v0.84.3` | `4e58f324fae8ebfa98a3d45181fb248072a2afac` | `packages/agent/src/agent.ts` | `Agent.prompt`, `Agent.runPromptMessages`, `Agent.runWithLifecycle`, `Agent.processEvents`
- `v0.84.3` | `4e58f324fae8ebfa98a3d45181fb248072a2afac` | `packages/agent/src/agent-loop.ts` | `runAgentLoop`, `runLoop`, `streamAssistantResponse`, `executeToolCalls`

## 逐条证据

### E01 [类型契约] 一个 Turn 是一次 assistant 响应，加上由该响应产生的工具调用与工具结果

**结论：** `turn_start` / `turn_end` 包围的是一个 assistant 响应以及该响应的整批工具执行；一次工具往返不是两个 Turn。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentEvent`
- 辅助行：432-434

**直接证据：** `AgentEvent` 的注释原文把 turn 定义为 “one assistant response + any tool calls/results”，而 `turn_end` 同时携带 `message` 与 `toolResults`。

**验证：** `verified-contract`

### E02 [推断] 一个 Run 是一次 `Agent` 活跃生命周期，可以包含多个 Turn

**结论：** 本文把 `agent_start` 到 `agent_end` 称为一个 Run；工具结果、steering 或 follow-up 都可能让同一个 Run 再开始 Turn。Pi 在这层没有公开的 `Run` 消息类型，只有私有 `ActiveRun` 和生命周期事件。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`ActiveRun`, `Agent.runWithLifecycle`
- 辅助行：161-165, 486-535

**补充锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runAgentLoop`, `runLoop`
- 辅助行：95-117, 155-275

**推断依据：** `runAgentLoop` 只发一次 `agent_start`；`runLoop` 可反复发 `turn_start` / `turn_end`；退出时只发一次 `agent_end`。`runWithLifecycle` 在外层持有一个 `AbortController` 和 idle promise。

**验证：** `inference`

### E03 [源码事实] 新 prompt 与 continue 的差异是“是否把新输入加入本次增量并为它发消息事件”

**结论：** `runAgentLoop` 把 prompts 复制进当前上下文和返回的 `newMessages`，并为每条 prompt 发 `message_start` / `message_end`；`runAgentLoopContinue` 从已有上下文直接请求模型，返回值只包含本次新产生的消息，不重发已有输入的消息事件。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runAgentLoop`, `runAgentLoopContinue`
- 辅助行：95-143

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`describe("agentLoopContinue with AgentMessage") > it("should continue from existing context without emitting user message events")`
- 辅助行：1505-1545

**验证：** `verified-source`, `verified-test-source`

### E04 [源码事实] 低层 continue 拒绝空上下文和 assistant 尾消息

**结论：** `agentLoopContinue` / `runAgentLoopContinue` 要求上下文非空，并直接拒绝 role 为 `assistant` 的尾消息；自定义尾消息能否继续，最终由 `convertToLlm` 是否把它转换成 provider 可接受的 `user` 或 `toolResult` 负责。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`agentLoopContinue`, `runAgentLoopContinue`
- 辅助行：56-93, 120-143

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should throw when context has no messages")`, `it("should allow custom message types as last message (caller responsibility)")`
- 辅助行：1486-1503, 1547-1606

**验证：** `verified-source`, `verified-test-source`

### E05 [类型契约] 模型边界是返回 `AssistantMessageEventStream` 的 `StreamFn`

**结论：** Agent Loop 不直接依赖某个 provider；它把 `Model + Context + SimpleStreamOptions` 交给注入的 `StreamFn`。请求、模型或运行时失败按契约不能 throw/reject，而应在流里以 `error` 协议事件和最终 `stopReason: "error" | "aborted"` 的 `AssistantMessage` 表示。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`StreamFn`
- 辅助行：18-32

**补充锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/types.ts`
- symbol：`StreamFunction`, `AssistantMessageEvent`
- 辅助行：324-336, 527-551

**验证：** `verified-contract`

### E06 [源码事实] 每次模型请求前按固定顺序变换上下文并重新解析 API key

**结论：** 每个 Turn 的模型边界顺序是 `transformContext`（可选）→ `convertToLlm` → 构造 `Context` → `getApiKey`（可选）→ `streamFunction`；因此长 Run 的每次模型请求都可以拿到更新后的短期凭据。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`streamAssistantResponse`
- 辅助行：281-312

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should apply transformContext before convertToLlm")`
- 辅助行：221-272

**验证：** `verified-source`, `verified-test-source`

### E07 [源码事实] 流式 partial 在内部上下文中原位更新，最终消息替换 partial

**结论：** 收到 `start` 后，loop 把 partial assistant message 放到当前上下文并发 `message_start`；text/thinking/tool-call 增量更新上下文最后一项并发 `message_update`；`done` 或 `error` 时用 `response.result()` 的最终消息替换 partial，再发 `message_end`。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`streamAssistantResponse`
- 辅助行：314-371

**补充锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/utils/event-stream.ts`
- symbol：`EventStream.result`, `AssistantMessageEventStream`
- 辅助行：64-82

**验证：** `verified-source`

### E08 [类型契约] `AssistantMessage` 是循环控制与可观测结果的共同载体

**结论：** 最终 assistant 消息同时携带 content blocks、provider/model 元数据、usage、`stopReason`、可选 `errorMessage` / `rawStopReason` / `endTurn`。`StopReason` 的全集是 `pending | stop | length | toolUse | error | aborted | deferred`；其中 `pending` 用于 partial，终止流的 `done` 只允许 `stop | length | toolUse | deferred`，`error` 只允许 `aborted | error`。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/types.ts`
- symbol：`StopReason`, `AssistantMessage`, `AssistantMessageEvent`
- 辅助行：405, 427-447, 527-551

**验证：** `verified-contract`

### E09 [源码事实] Agent Loop 只对三类 stop reason 做特殊控制，其余是否继续主要看 content 与队列

**结论：** `error` / `aborted` 会立即以空 `toolResults` 结束当前 Turn 和 Run；`length` 且消息含 tool calls 时走“全部拒绝执行”路径；除此之外，是否进入工具循环由 `message.content` 是否含 `toolCall` 决定，而不是强制要求 `stopReason === "toolUse"`。`AssistantMessage.endTurn` 在当前循环控制中未被读取。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runLoop`
- 辅助行：192-224

**补充锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/types.ts`
- symbol：`AssistantMessage.endTurn`
- 辅助行：441-445

**验证：** `verified-source`

### E10 [源码事实] 正常工具循环把整批 ToolResultMessage 加回上下文后才开始下一 Turn

**结论：** loop 从最终 assistant content 中收集全部 `toolCall`，执行整批并把结果逐条加入 `currentContext.messages` 与 `newMessages`，随后发 `turn_end`；只要该批没有满足 terminate 规则，就保留 `hasMoreToolCalls=true`，使下一 Turn 把工具结果交回模型。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runLoop`, `executeToolCalls`
- 辅助行：202-224, 411-431

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should handle tool calls and results")`
- 辅助行：274-369

**验证：** `verified-source`, `verified-test-source`

### E11 [源码事实] `length` 截断消息中的所有工具调用都不会执行，但会生成错误结果并继续

**结论：** 只要 assistant message 的 `stopReason` 是 `length`，其中每个 tool call 都只发 start/end 和错误 `ToolResultMessage`，不会调用真实工具；该批明确返回 `terminate: false`，从而让模型获得错误结果并有机会重新发出完整调用。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`failToolCallsFromTruncatedMessage`
- 辅助行：374-405

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should not execute tool calls from a length-truncated assistant message")`
- 辅助行：371-442

**验证：** `verified-source`, `verified-test-source`

### E12 [源码事实] 工具级失败被规范化为 `isError: true` 的 ToolResult，而不是自动终止 Run

**结论：** 工具不存在、参数准备或校验失败、`beforeToolCall` 阻止、`execute` throw、`afterToolCall` throw，都会被转换成文本错误结果并最终形成 `ToolResultMessage`；除非 terminate 规则成立或外层停止条件介入，模型仍会看到错误并可继续下一 Turn。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`prepareToolCall`, `executePreparedToolCall`, `finalizeExecutedToolCall`, `createErrorToolResult`, `createToolResultMessage`
- 辅助行：600-790

**验证：** `verified-source`

**测试缺口：** 本次读取的 `agent-loop.test.ts` 覆盖 blocked tool 的错误结果，但没有为“未知工具”和“工具 execute throw”设置独立断言。

### E13 [源码事实] Steering 在当前 Turn 完整结束后注入，Follow-up 只在 agent 原本会停下时注入

**结论：** steering 首次在 Run 开始时轮询，之后在 assistant 与其整批工具结果完成、`turn_end`、`prepareNextTurn`、`shouldStopAfterTurn` 之后轮询，并在下一次模型请求前加入上下文；follow-up 只有在没有工具续轮且没有 steering 时才轮询。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runLoop`
- 辅助行：163-190, 224-268

**类型契约锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentLoopConfig.getSteeringMessages`, `AgentLoopConfig.getFollowUpMessages`
- 辅助行：233-257

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should inject queued messages after all tool calls complete")`
- 辅助行：681-785

**验证：** `verified-source`, `verified-contract`, `verified-test-source`

### E14 [源码事实] Agent 的 steering/follow-up 队列默认一次只取最老一条，也可配置一次取完

**结论：** `QueueMode` 是 `all | one-at-a-time`；`Agent` 对两个队列都默认 `one-at-a-time`。队列 drain point 由 E13 所述循环位置决定，而调用 `steer()` / `followUp()` 本身只入队，不会立即写入 transcript。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`QueueMode`
- 辅助行：44-50

**补充锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`PendingMessageQueue.drain`, `Agent.constructor`, `Agent.steer`, `Agent.followUp`
- 辅助行：125-159, 216-238, 282-290

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent.test.ts`
- symbol：`it("should support steering message queue")`, `it("should support follow-up message queue")`, `it("continue() should keep one-at-a-time steering semantics from assistant tail")`
- 辅助行：481-499, 656-698

**验证：** `verified-source`, `verified-test-source`

### E15 [源码事实] `Agent.continue()` 遇到 assistant 尾消息时优先消费 queued steering，再消费 follow-up

**结论：** 高层 `Agent.continue()` 比低层 continue 多一个恢复分支：尾消息为 assistant 时，先 drain steering 并把它作为新 prompt Run；没有 steering 才 drain follow-up；两者都没有才报错。消费 steering 时跳过新 Run 的第一次 steering poll，避免同一 drain point 多取一条而破坏 `one-at-a-time`。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.continue`, `Agent.runPromptMessages`, `Agent.createLoopConfig`
- 辅助行：360-388, 409-423, 445-483

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent.test.ts`
- symbol：`it("continue() should process queued follow-up messages after an assistant turn")`, `it("continue() should keep one-at-a-time steering semantics from assistant tail")`
- 辅助行：618-698

**验证：** `verified-source`, `verified-test-source`

### E16 [源码事实] `shouldStopAfterTurn` 是比队列和普通工具续轮更强的优雅停止点

**结论：** callback 在当前 assistant、全部工具执行、`turn_end` 和 `prepareNextTurn` 完成后运行；返回 true 时直接发 `agent_end`，不会再轮询本 Turn 之后的 steering 或 follow-up，也不会发下一次模型请求。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runLoop`
- 辅助行：224-259

**类型契约锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentLoopConfig.shouldStopAfterTurn`
- 辅助行：212-222

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should stop after the current turn when shouldStopAfterTurn returns true")`
- 辅助行：1104-1199

**验证：** `verified-source`, `verified-contract`, `verified-test-source`

### E17 [源码事实] `terminate` 只有整批所有最终结果都为 true 才阻断工具驱动的下一 Turn

**结论：** `shouldTerminateToolBatch` 要求 finalizedCalls 非空且 `every(result.terminate === true)`。单个结果 terminate、同批另一结果未 terminate 时仍继续；这个提示在整批执行和结果发出后才判断，不会跳过同批剩余工具。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`shouldTerminateToolBatch`, `executeToolCallsSequential`, `executeToolCallsParallel`
- 辅助行：433-553, 582-584

**类型契约锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentToolResult.terminate`
- 辅助行：360-375

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should stop after a tool batch when every tool result sets terminate=true")`, `it("should continue after parallel tool calls when not all tool results terminate")`
- 辅助行：1201-1251, 1371-1434

**验证：** `verified-source`, `verified-contract`, `verified-test-source`

### E18 [源码事实] `terminate` 不是无条件 `agent_end`，排队消息仍可让 Run 继续

**结论：** terminate 只把 `hasMoreToolCalls` 设为 false；当前 Turn 之后仍会执行 `prepareNextTurn`、`shouldStopAfterTurn` 和 steering poll，内层停止后仍会做 follow-up poll。因此它表示“不因本批工具结果自动再请求模型”，不是不可覆盖的 Run 终止信号。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runLoop`
- 辅助行：211-268

**验证：** `verified-source`

**测试缺口：** 当前测试分别覆盖 terminate 和队列，但没有覆盖“terminate 后同一 Run 恰有 steering/follow-up”的组合场景；此结论来自明确控制流，建议后续若把 terminate 对外解释为“停止 Agent”时补组合测试。

### E19 [源码事实] `Agent.abort()` 发出协作式取消信号，不是同步强杀

**结论：** 每个 active Run 有一个 `AbortController`；`abort()` 只调用 controller.abort()。同一 signal 被传给模型 stream、工具、before/after hooks 和事件 subscribers；这些参与者需要响应 signal，Run 才能收敛。无 active Run 时 `abort()` 是 no-op。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`ActiveRun`, `Agent.signal`, `Agent.abort`, `Agent.runWithLifecycle`, `Agent.processEvents`
- 辅助行：161-165, 313-321, 486-509, 584-590

**补充锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`streamAssistantResponse`, `prepareToolCall`, `executePreparedToolCall`, `finalizeExecutedToolCall`
- 辅助行：281-312, 600-758

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent.test.ts`
- symbol：`it("should pass the active abort signal to subscribers")`, `it("should handle abort controller")`
- 辅助行：263-299, 501-506

**验证：** `verified-source`, `verified-test-source`

**测试边界：** abort 测试验证了 signal 传播，但测试 helper 产生的 error event 内部 `AssistantMessage.stopReason` 仍是 `stop`，不满足 E05 的流契约；所以该测试没有真正覆盖 `runLoop` 的 `stopReason === "aborted"` 分支。

### E20 [源码事实] 合约内的模型 error/aborted 与异常 throw 是两条不同路径

**结论：** 合约内失败由最终 assistant message 表示，`runLoop` 正常发 `turn_end` 和 `agent_end`；若 streamFn 或 loop hook 违反契约直接 throw，高层 `Agent.runWithLifecycle` 会捕获异常，合成零 usage、空文本、`stopReason: error|aborted` 的 assistant 消息并补发 `message_start`、`message_end`、`turn_end`、`agent_end`。低层 loop 自身不负责把 throw 转成事件。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runLoop`
- 辅助行：192-200

**补充锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.runWithLifecycle`, `Agent.handleRunFailure`
- 辅助行：486-527

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent.test.ts`
- symbol：`it("emits full lifecycle events for thrown run failures")`
- 辅助行：159-188

**验证：** `verified-source`, `verified-test-source`

### E21 [源码事实] Run 的完成包含异步事件订阅者的完成

**结论：** `Agent.processEvents` 按订阅顺序 await listeners；即使已经发出 `agent_end`，`prompt()`、`continue()`、`waitForIdle()` 和 `state.isStreaming=false` 都要等 `agent_end` listener 完成后才结算。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.subscribe`, `Agent.waitForIdle`, `Agent.runWithLifecycle`, `Agent.finishRun`, `Agent.processEvents`
- 辅助行：240-253, 323-330, 486-509, 529-590

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent.test.ts`
- symbol：`it("should await async subscribers before prompt resolves")`, `it("waitForIdle should wait for async subscribers")`
- 辅助行：190-261

**验证：** `verified-source`, `verified-test-source`

### E22 [源码事实] 同一个 `Agent` 不允许两个 Run 并发

**结论：** active Run 存在时，新的 `prompt()` 和 `continue()` 都会拒绝；运行中的新输入应该进入 steering/follow-up 队列，而不是启动第二个 loop。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.prompt`, `Agent.continue`, `Agent.runWithLifecycle`
- 辅助行：347-388, 486-489

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent.test.ts`
- symbol：`it("should throw when prompt() called while streaming")`, `it("should throw when continue() called while streaming")`
- 辅助行：542-616

**验证：** `verified-source`, `verified-test-source`

### E23 [源码事实] 全局工具执行默认 parallel，但任一工具声明 sequential 会让整批串行

**结论：** `Agent` 默认 `toolExecution="parallel"`。批选择规则是：全局配置为 sequential，或本批任一已注册工具的 `executionMode` 为 sequential，就把整批交给串行执行器；只有两者都不要求串行时才走并行执行器。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.constructor`
- 辅助行：216-238

**补充锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`executeToolCalls`
- 辅助行：411-426

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should force sequential execution when a tool has executionMode=sequential even with default parallel config")`, `it("should force sequential execution when one of multiple tools has executionMode=sequential")`, `it("should allow parallel execution when all tools have executionMode=parallel")`
- 辅助行：787-1029

**验证：** `verified-source`, `verified-test-source`

### E24 [源码事实] Parallel 模式把“并发完成顺序”和“对话持久化顺序”分开

**结论：** parallel 模式先按 assistant 源顺序串行 preflight 每个调用，再用 `Promise.all` 并发执行允许的调用；每个 `tool_execution_end` 在该调用完成后立即发，所以按实际完成顺序出现，但最终 `ToolResultMessage` 与 `turn_end.toolResults` 按 assistant 源顺序发出和持久化。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`executeToolCallsParallel`
- 辅助行：489-553

**类型契约锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`ToolExecutionMode`, `AgentLoopConfig.toolExecution`
- 辅助行：34-42, 259-268

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should emit tool_execution_end in completion order but persist tool results in source order")`
- 辅助行：586-679

**验证：** `verified-source`, `verified-contract`, `verified-test-source`

### E25 [推断] Core loop 没有内建最大 Turn 数或最大工具轮数

**结论：** `runLoop` 的内外层都是条件循环，`AgentLoopConfig` 没有 max-turn 字段；只要模型持续发工具调用或消息队列持续供给消息，Core 可以继续运行。需要上层通过 abort、`shouldStopAfterTurn`、工具 terminate、队列管理或 provider 的最终停止来建立预算。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runLoop`
- 辅助行：155-275

**补充锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentLoopConfig`
- 辅助行：149-293

**验证：** `inference`

## 事件顺序不变量

以下是由上述证据项组合出的高置信不变量；每条只引用已经带完整固定版本锚点的证据编号：

1. 正常 Run 以 `agent_start` 开始、`agent_end` 结束；每次模型请求属于一个 `turn_start` / `turn_end` 区间。（E01、E02）
2. 最终 assistant `message_end` 先于它引出的所有工具事件；全部 ToolResultMessage 又先于该 Turn 的 `turn_end`。（E07、E10）
3. Steering 不会打断正在流式生成的 assistant，也不会跳过该 assistant 已请求的同批工具。（E13）
4. Parallel 只改变工具的真实执行重叠与 `tool_execution_end` 顺序，不改变模型下一轮看到的 ToolResultMessage 源顺序。（E24）
5. `error` / `aborted` assistant 结束路径不会执行它 content 中潜在的工具调用。（E09）
6. `length` 工具调用会生成一一对应的错误 ToolResultMessage，因此 provider transcript 仍能保持 assistant tool call 与 tool result 的配对。（E11）
7. 工具 terminate 先完成整批和 `turn_end`，只阻断自动工具续轮；`shouldStopAfterTurn` 才是绕过后续队列 poll 的明确 Run 结束点。（E16、E17、E18）

## 建议第一章使用的代表性案例

用同一个案例即可解释大部分核心机制：

1. 用户发出“读取 A 和 B，再总结”。
2. Turn 1 的 assistant message 含两个 tool calls。
3. 两个只读工具以 parallel 执行；B 先完成，因此 UI 先收到 B 的 `tool_execution_end`。
4. transcript 仍按 A、B 的 tool-call 源顺序写入两个 ToolResultMessage。
5. Turn 1 结束后注入一条 steering：“总结时只比较错误处理”。
6. Turn 2 的模型输入包含 assistant tool calls、A/B 工具结果和 steering。
7. assistant 返回无工具调用的 `stop` 消息；没有 follow-up，Run 发 `agent_end`。

该案例能同时承载 E01、E10、E13、E23、E24，且不需要提前引入 Harness。

## 尚未由运行验证或仍需谨慎表述的点

1. 本次无法执行 upstream 单元测试，因为 submodule 没有安装依赖；`verified-test-source` 仅表示断言源码已核对。
2. abort 现有测试不构造契约一致的 `stopReason: "aborted"` 最终消息，所以只能确认 AbortSignal 传播，不能声称该测试覆盖 aborted 分支。（E19）
3. terminate 与 steering/follow-up 同时出现的组合没有直接测试；实现清楚表明队列仍可让 Run 继续，但 Book 应把 terminate 描述成“阻断工具驱动的下一轮”，不要简写成“立刻停止 Agent”。（E18）
4. `Run` 是本书为教学建立的术语映射，不是 core 暴露的独立类型；源码中真正可观察的边界是 `agent_start` / `agent_end` 和高层 `ActiveRun`。（E02）
5. `endTurn` 明确只保留供调试且当前不参与 Agent 控制流；不要把 provider 的该标志当作 Core 的停止条件。（E09）
