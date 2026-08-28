# 第二章 Tool System 源码研究笔记

## 研究边界

- 上游仓库：`https://github.com/earendil-works/pi.git`
- 固定 tag：`v0.84.3`
- 固定 commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- commit 标题：`Release v0.84.3`
- 核心范围：
  - `packages/ai`：模型可见的 Tool、ToolCall、ToolResultMessage 协议，以及参数校验和 provider 适配。
  - `packages/agent`：AgentTool 可执行契约、工具批次调度、事件、错误归一化、abort 与 terminate 控制。
  - `packages/coding-agent`：ToolDefinition、内置/扩展工具包装、扩展拦截与动态激活边界。
- 排除：每个内置文件工具的业务细节、TUI 渲染、Harness v2 的 durable tool state。这些分别属于 Agent Application Engineering、UI 或未来 Harness 专题，不用于解释当前低层 Tool System。
- 核验方式：逐文件读取固定源码和对应测试。`upstream/pi/node_modules` 不存在，本机没有 `upstream/pi/node_modules/vitest/dist/cli.js`，因此本文中的“测试证据”表示已静态核对测试源码，不表示本次运行通过。

状态说明：

- `verified-source`：已读取固定 commit 的实现。
- `verified-contract`：已读取固定 commit 的公开类型或注释契约。
- `verified-test-source`：已读取固定 commit 的测试和断言，但本次未执行。
- `inference`：由多个已核验 symbol 组合得到，文中明确标注。

## 先给出最小心智模型

Pi 的工具系统不是一个接口，而是三层协议：

```text
packages/ai
  Tool(name, description, parameters, constrainedSampling)
  ToolCall(id, name, arguments)
  ToolResultMessage(toolCallId, toolName, content, isError, ...)
       |
       | AgentTool extends Tool
       v
packages/agent
  label + prepareArguments + execute + executionMode
  validation -> hooks -> scheduling -> result normalization -> events
       |
       | ToolDefinition wrapper / Agent hooks
       v
packages/coding-agent
  prompt metadata + renderers + ExtensionContext
  registerTool -> wrapper -> AgentTool
  tool_call / tool_result extension interception
```

一条正常工具调用的代表性路径是：

```text
Context.tools
  -> provider adapter 把 Tool schema 发给模型
  -> AssistantMessage.content 产生 ToolCall
  -> tool_execution_start（携带 raw args）
  -> 按 name 查 AgentTool
  -> prepareArguments(raw args，可选)
  -> validateToolArguments(clone + normalize/coerce + schema check)
  -> beforeToolCall(validated args，可阻止；可原地修改且不复验)
  -> execute(toolCallId, args, signal, onUpdate)
       -> tool_execution_update*（可选）
  -> afterToolCall（可覆盖最终结果）
  -> tool_execution_end
  -> ToolResultMessage
  -> message_start / message_end
  -> 当前批次全部完成后，结果进入 transcript
  -> 除非整批 terminate，否则下一次模型请求读取这些结果
```

这条路径是 `inference`，组成它的实现锚点是：

- `v0.84.3` | `4e58f324fae8ebfa98a3d45181fb248072a2afac` | `packages/ai/src/types.ts` | `Tool`, `ToolCall`, `ToolResultMessage`
- `v0.84.3` | `4e58f324fae8ebfa98a3d45181fb248072a2afac` | `packages/ai/src/utils/validation.ts` | `validateToolArguments`
- `v0.84.3` | `4e58f324fae8ebfa98a3d45181fb248072a2afac` | `packages/agent/src/types.ts` | `AgentTool`, `AgentToolResult`, `AgentEvent`
- `v0.84.3` | `4e58f324fae8ebfa98a3d45181fb248072a2afac` | `packages/agent/src/agent-loop.ts` | `executeToolCalls`, `prepareToolCall`, `executePreparedToolCall`, `finalizeExecutedToolCall`

## 逐条证据

### TS01 [类型契约] provider 可见的 `Tool` 只描述“模型如何调用”，不负责执行

**结论：** `packages/ai` 的 `Tool<TParameters>` 只有 `name`、`description`、TypeBox `parameters` 和可选 `constrainedSampling`。它足以生成 provider tool schema，但没有 `execute`、UI label、进度或执行模式。因此 Tool schema 协议与本地执行协议是分层的。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/types.ts`
- symbol：`Tool`, `ConstrainedSamplingConfig`, `Context.tools`
- 辅助行：497-525

**验证：** `verified-contract`

### TS02 [类型契约] `AgentTool` 才是可执行工具契约

**结论：** `AgentTool` 继承 `Tool`，再增加 `label`、可选 `prepareArguments`、`execute` 和可选 `executionMode`。`execute` 获得 call id、schema 推导后的参数、AbortSignal 和进度回调，返回 `AgentToolResult`。失败契约是 throw，而不是在 content 中自行编码失败。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentTool`, `AgentToolUpdateCallback`, `AgentToolResult`
- 辅助行：360-409

**补充契约：** `AgentToolResult.content` 只允许 text/image，`details` 服务日志/UI；可选 `usage` 是工具自身（例如嵌套模型）的 usage，不计入主 LLM context accounting；`addedToolNames` 表示从该 transcript 点开始可用的新工具；`terminate` 是批次控制提示。

**验证：** `verified-contract`

### TS03 [类型契约] 模型调用与本地结果通过 call id 关联

**结论：** 模型产出的 `ToolCall` 是 AssistantMessage content block，包含 `id`、`name`、对象形态 `arguments`；本地 `ToolResultMessage` 用 `toolCallId` 和 `toolName` 回链，并携带 text/image content、可选 details/usage/addedToolNames、`isError` 与 timestamp。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/types.ts`
- symbol：`ToolCall`, `AssistantMessage`, `ToolResultMessage`, `Message`
- 辅助行：372-380, 427-467

**边界：** `ToolResultMessage` 不包含 `terminate`；terminate 只影响本次执行批次的 loop 控制。`details` 和 tool usage 可以留在统一 transcript，但 provider adapter 主要消费关联 id、content、isError 和动态工具加载信息。

**验证：** `verified-contract`, `verified-source`

### TS04 [源码事实] 工具按 name 精确查找，未知工具变成可回传的错误结果

**结论：** `prepareToolCall` 用 `currentContext.tools?.find(t => t.name === toolCall.name)` 查找第一个匹配工具；找不到不会 throw 出 Agent Loop，而是立即生成 `Tool <name> not found` 的错误结果，并仍走 execution-end 与 ToolResultMessage 事件链。模型因此有机会在下一 Turn 修正工具名。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`prepareToolCall`
- 辅助行：600-614

**验证：** `verified-source`

### TS05 [源码事实] 参数顺序固定为 compatibility preparation 再 schema validation

**结论：** 如果工具定义了 `prepareArguments`，loop 先用 raw `toolCall.arguments` 运行它，把返回值放进一个新的 ToolCall 供校验；然后才调用 `validateToolArguments`。此能力用于恢复旧 session 的旧参数形状，不应把废弃字段永久放宽到公开 schema。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`prepareToolCallArguments`, `prepareToolCall`
- 辅助行：586-618

**测试锚点：**

- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should prepare tool arguments for validation")`
- 辅助行：506-584

**验证：** `verified-source`, `verified-test-source`

### TS06 [源码事实] schema 校验 clone 参数，并做 null 归一化和类型转换

**结论：** `validateToolArguments` 先 `structuredClone` raw/prepared arguments，删除“可选且 schema 不接受 null”的 null 字段，再用 TypeBox `Value.Convert` 转换类型。对于序列化后丢失 TypeBox kind 的 plain JSON schema，还执行显式 JSON Schema primitive coercion。最后用缓存的 TypeBox compiled validator 检查；失败错误包含格式化字段路径和原始 received arguments。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/utils/validation.ts`
- symbol：`normalizeOptionalNulls`, `getValidator`, `validateToolArguments`
- 辅助行：240-280, 310-350

**测试锚点：**

- file：`packages/ai/test/validation.test.ts`
- symbol：`describe("validateToolArguments")`
- 辅助行：36-209

**测试所表达的边界：** string `"42"` 可转 number 42；optional non-nullable null 会被当作缺省删除；nullable null 被保留；非法转换仍抛 `Validation failed`。

**验证：** `verified-source`, `verified-test-source`

### TS07 [源码事实] validation、prepare 或 before hook 失败都被归一化，不向外炸掉 loop

**结论：** `prepareArguments` throw、schema validation throw、`beforeToolCall` throw 均被 `prepareToolCall` 的 catch 捕获，转换成 `{ content: text(error), details: {} }` 且 `isError: true` 的 immediate outcome。工具本体不会执行，但会形成正式 ToolResultMessage。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`prepareToolCall`, `createErrorToolResult`
- 辅助行：600-667, 760-765

**验证：** `verified-source`

### TS08 [源码事实] `beforeToolCall` 在校验后运行，可 block，也可原地修改已校验参数

**结论：** hook 收到 raw `toolCall` 与独立的 validated `args`。返回 `{ block: true }` 时工具不执行，reason 成为错误文本；可同时给 blocked result 设置 terminate。hook 也可原地修改 `args`，实际 execute 会收到修改值，但 core 不进行第二次 schema 校验。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`BeforeToolCallContext`, `BeforeToolCallResult`, `AgentLoopConfig.beforeToolCall`
- 辅助行：55-107, 270-277
- file：`packages/agent/src/agent-loop.ts`
- symbol：`prepareToolCall`
- 辅助行：617-660

**测试锚点：**

- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should execute mutated beforeToolCall args without revalidation")`
- 辅助行：444-504

**教学含义：** 扩展修改 validated args 是可信 hook 权限，不是新的不可信输入边界；hook 作者必须自行维护 schema 不变量。

**验证：** `verified-source`, `verified-contract`, `verified-test-source`

### TS09 [源码事实] 默认并行，但任意 sequential 工具会把整个 assistant 批次降为串行

**结论：** 高层 `Agent` 默认 `toolExecution = "parallel"`。`executeToolCalls` 只要满足任一条件就选择串行：全局 config 是 sequential，或当前 assistant 批次里任一已注册目标工具声明 `executionMode: "sequential"`。不是只让该工具自己串行，而是整个批次按源顺序串行。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.constructor`, `Agent.toolExecution`
- 辅助行：213-237
- file：`packages/agent/src/agent-loop.ts`
- symbol：`executeToolCalls`
- 辅助行：411-425

**测试锚点：**

- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should force sequential execution when one of multiple tools has executionMode=sequential")`, `it("should allow parallel execution when all tools have executionMode=parallel")`
- 辅助行：870-1029

**验证：** `verified-source`, `verified-test-source`

### TS10 [源码事实] 串行模式逐个完成完整生命周期，并在 abort 后不再启动后续 call

**结论：** 串行 loop 对每个 ToolCall 依次执行：start event → prepare/validate/hook → execute → after hook → end event → ToolResultMessage events；只有这一项完全结束才处理下一项。若 signal 在一项结束时已 aborted，立即 break，后续 call 不再产生执行结果。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`executeToolCallsSequential`
- 辅助行：433-487

**验证：** `verified-source`

### TS11 [源码事实] 并行模式先按源顺序 preflight 全批，再并发执行 allowed calls

**结论：** parallel 并不是从第一项开始立即 execute。loop 先按 assistant source order 逐项发 start、查找、prepare、validate 并 await `beforeToolCall`；prepared calls 被保存为异步 thunk。全部 preflight 完成后，`Promise.all` 才同时启动 allowed executes。未知、校验失败或 blocked 的 immediate outcome 在 preflight 阶段就发 execution-end。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`executeToolCallsParallel`, `FinalizedToolCallEntry`
- 辅助行：489-542, 580

**教学含义：** `tool_execution_start` 表示“core 开始处理该 call”，不是“工具副作用已经启动”。在 parallel 模式下，多条 start/preflight event 可能先出现，随后真正的 execute 才并发开始。

**验证：** `verified-source`

### TS12 [源码事实] 并行完成事件按完成顺序，transcript 结果按 assistant 源顺序

**结论：** 每个并发 thunk 在 finalize 后立刻 emit `tool_execution_end`，所以 end event 按实际完成顺序出现。`Promise.all` 返回值仍保持输入 thunk 顺序，core 随后按这个 source order 创建并发出 ToolResultMessage。因此 UI 可以实时显示快工具先结束，模型 transcript 仍具有确定性顺序。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`ToolExecutionMode`
- 辅助行：34-42
- file：`packages/agent/src/agent-loop.ts`
- symbol：`executeToolCallsParallel`
- 辅助行：522-552

**测试锚点：**

- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should emit tool_execution_end in completion order but persist tool results in source order")`
- 辅助行：586-679

**验证：** `verified-source`, `verified-contract`, `verified-test-source`

### TS13 [源码事实] 工具进度是 execution event，不是 transcript 消息

**结论：** `onUpdate(partialResult)` 只排队发 `tool_execution_update`，不创建 ToolResultMessage，也不直接进入模型上下文。core 在 execute promise settle 后关闭 update 接收并 await 已发出的 update event；settle 之后调用旧 callback 会被忽略，包括同批其他工具仍运行时。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`executePreparedToolCall`
- 辅助行：670-710

**测试锚点：**

- file：`packages/agent/test/agent.test.ts`
- symbol：`it("should ignore tool updates after the tool execution settles")`, `it("should ignore a settled parallel tool update while another tool is still running")`
- 辅助行：301-439

**额外边界：** update event 的 `args` 来自 raw `prepared.toolCall.arguments`；execute 收到的是 validated（且可能被 before hook 修改的）`prepared.args`。两者在 compatibility conversion 或 hook mutation 后可能不同。

**验证：** `verified-source`, `verified-test-source`

### TS14 [源码事实] execute throw 变成错误结果，普通 return 永远不自动设置 error

**结论：** `executePreparedToolCall` 捕获 execute throw，生成文本错误结果并设 `isError: true`。`AgentToolResult` 类型本身没有 `isError` 字段；工具正常 return 即使 content 写着“失败”也仍是成功。错误状态属于 runtime envelope，而不是 tool payload。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentToolResult`, `AgentTool.execute`
- 辅助行：360-400
- file：`packages/agent/src/agent-loop.ts`
- symbol：`executePreparedToolCall`, `createErrorToolResult`
- 辅助行：678-710, 760-765

**验证：** `verified-source`, `verified-contract`

### TS15 [源码事实] `afterToolCall` 在执行成功或失败后都能覆盖最终 envelope

**结论：** finalize hook 收到 args、原始 result 与当前 isError。它可以逐字段替换 content、details、usage、terminate 和 isError；省略字段保留原值，不做深合并。若 after hook 自己 throw，core 用 hook error 替换此前结果并设 error，原工具结果及 terminate 被丢弃。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AfterToolCallResult`, `AfterToolCallContext`, `AgentLoopConfig.afterToolCall`
- 辅助行：71-123, 279-292
- file：`packages/agent/src/agent-loop.ts`
- symbol：`finalizeExecutedToolCall`
- 辅助行：713-758

**测试锚点：**

- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should handle tool calls and results")`, `it("should allow afterToolCall to mark a tool batch as terminating")`
- 辅助行：274-369, 1436-1480

**验证：** `verified-source`, `verified-contract`, `verified-test-source`

### TS16 [源码事实] `ToolResultMessage` 是最终模型可见 artifact，并有独立消息事件

**结论：** finalized outcome 被映射为 role `toolResult` 的消息：保留 id/name、content、details、usage、addedToolNames、isError，加 timestamp；非类型安全 JS 工具漏掉 content 时被归一成空数组。然后按顺序发 `message_start` / `message_end`，高层 Agent 在 message_end 时写入自己的 state transcript。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`createToolResultMessage`, `emitToolResultMessage`
- 辅助行：777-796
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.processEvents`
- 辅助行：544-570

**验证：** `verified-source`

### TS17 [源码事实] `length` 截断的 tool calls 全部拒绝执行

**结论：** AssistantMessage 只要 stopReason 为 `length`，其中每个 tool call 都不走真实查找、校验或 execute。core 为每项发 start/end 和明确的截断错误结果，并返回 `terminate: false`，让模型看到错误并重新发出完整调用。原因是流式 JSON salvage 可能得到“可解析且可校验、但静默不完整”的参数。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`failToolCallsFromTruncatedMessage`, `runLoop`
- 辅助行：374-405, 202-216

**测试锚点：**

- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should not execute tool calls from a length-truncated assistant message")`
- 辅助行：371-442

**验证：** `verified-source`, `verified-test-source`

### TS18 [源码事实] abort 是协作式取消，不会强杀正在执行的工具 promise

**结论：** `Agent.abort()` 只 abort 当前 Run 的 controller。preflight 在 before hook 后和 execute 前检查 `signal.aborted`，生成 `Operation aborted` 错误；execute 和 before/after hooks 都收到 signal，调用方负责 honor。core 对正在执行的 `tool.execute` 直接 await，没有 Promise.race 或强制终止，所以忽略 signal 的工具会延迟 Run settlement。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.abort`
- 辅助行：317-321
- file：`packages/agent/src/agent-loop.ts`
- symbol：`prepareToolCall`, `executePreparedToolCall`
- 辅助行：619-660, 670-710
- file：`packages/agent/src/types.ts`
- symbol：`AgentLoopConfig.beforeToolCall`, `AgentLoopConfig.afterToolCall`, `AgentTool.execute`
- 辅助行：270-292, 394-400

**补充：** 串行/并行 preflight 循环都在 signal aborted 后停止准备更多 sibling calls；已经进入 execute 的 calls 仍需自行结束。

**验证：** `verified-source`, `verified-contract`, `inference`

### TS19 [源码事实] terminate 是“整批一致”规则，不会提前跳过 sibling calls

**结论：** `shouldTerminateToolBatch` 要求 finalizedCalls 非空，且每一项最终 result 的 `terminate === true`。单项 true、同批另一项 false/undefined 时仍继续下一次模型调用。判断发生在整批完成之后，所以不会因为先完成的一项 terminate 而取消同批剩余工具。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`shouldTerminateToolBatch`, `executeToolCallsSequential`, `executeToolCallsParallel`
- 辅助行：433-553, 582-584
- file：`packages/agent/src/types.ts`
- symbol：`AgentToolResult.terminate`
- 辅助行：370-374

**测试锚点：**

- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should stop after a tool batch when every tool result sets terminate=true")`, `it("should continue after parallel tool calls when not all tool results terminate")`
- 辅助行：1201-1251, 1371-1434

**验证：** `verified-source`, `verified-contract`, `verified-test-source`

### TS20 [源码事实] terminate 只关闭工具驱动的自动续轮，不等于立即 agent_end

**结论：** 批次 terminate 只把 `hasMoreToolCalls` 设为 false；ToolResultMessage 仍完整加入上下文，`turn_end`、prepareNextTurn、shouldStopAfterTurn、steering 轮询仍运行，外层还会轮询 follow-up。因此 terminate 的精确含义是“不因为这批工具结果自动再请求模型”，排队消息仍可使同一 Run 继续。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runLoop`
- 辅助行：202-274

**验证：** `verified-source`

### TS21 [类型契约] 工具事件与消息事件承担不同职责

**结论：** `AgentEvent` 的工具生命周期是 start/update/end；start 带 raw args，update 带 raw args 与 partialResult，end 带 final result 与 isError。最终持久 artifact 不靠 end event写入，而是之后的 ToolResultMessage `message_start/message_end`。高层 Agent 用 start/end 维护 `pendingToolCalls`，用 message_end 写 transcript。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentEvent`
- 辅助行：421-443
- file：`packages/agent/src/agent.ts`
- symbol：`Agent.processEvents`
- 辅助行：544-580
- file：`packages/agent/src/agent-loop.ts`
- symbol：`emitToolExecutionEnd`, `emitToolResultMessage`
- 辅助行：767-796

**验证：** `verified-contract`, `verified-source`

### TS22 [源码事实] provider adapter 把统一协议翻译为各家原生格式

**结论：** Agent Loop 不处理 OpenAI/Anthropic 工具 wire format。`packages/ai` adapter 把统一 Tool schema 和 Message 转成 provider 格式：OpenAI Chat Completions 使用 function tool（name/description/parameters/strict）、assistant `tool_calls` 和 role `tool` + `tool_call_id`；Anthropic 使用 `input_schema`、assistant `tool_use` 和 user content 中的 `tool_result` + `tool_use_id` + `is_error`。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/api/openai-completions.ts`
- symbol：`convertMessages`, `convertTools`
- 辅助行：1283-1304, 1329-1356, 1446-1457
- file：`packages/ai/src/api/anthropic-messages.ts`
- symbol：`convertToolResult`, `convertMessages`, `convertTools`
- 辅助行：1120-1153, 1252-1292, 1337-1362

**协议差异：** OpenAI 这一路只把 ToolResultMessage 的 text 转为 tool message，image 另行附加，并未发送统一 `isError` 字段；Anthropic 原生支持 `is_error`。因此 `isError` 是 Pi 的统一语义，最终 wire 表达由 provider 能力决定。

**验证：** `verified-source`

### TS23 [类型契约] `constrainedSampling` 是 provider-side schema 约束请求，不替代本地校验

**结论：** Tool 可以请求 JSON-schema strict sampling 或 provider grammar；adapter 仅在 provider 支持时翻译。例如 OpenAI conditional `strict`、Anthropic `strict`。无论 provider 是否约束生成，Agent Loop 仍在本地调用 `validateToolArguments`，所以 provider 约束与 runtime validation 是两道不同边界。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/ai/src/types.ts`
- symbol：`ConstrainedSamplingConfig`, `Tool.constrainedSampling`
- 辅助行：497-519
- file：`packages/ai/src/api/openai-completions.ts`
- symbol：`convertTools`
- 辅助行：1446-1457
- file：`packages/ai/src/api/anthropic-messages.ts`
- symbol：`convertTools`
- 辅助行：1337-1362
- file：`packages/agent/src/agent-loop.ts`
- symbol：`prepareToolCall`
- 辅助行：616-619

**验证：** `verified-contract`, `verified-source`, `inference`

### TS24 [类型契约] Coding Agent 的 `ToolDefinition` 是应用层 superset

**结论：** `packages/coding-agent` 的 `ToolDefinition` 保留 core 所需 name/label/description/parameters/constrainedSampling/prepareArguments/executionMode/execute，同时增加 system-prompt metadata、shell rendering 策略、call/result renderer，并给 execute 注入 `ExtensionContext`。这些 app/UI 能力没有下沉进 Agent core。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/extensions/types.ts`
- symbol：`ToolDefinition`
- 辅助行：448-500

**验证：** `verified-contract`

### TS25 [源码事实] wrapper 只做结构与 context 适配，不重复 core 调度和校验

**结论：** `wrapToolDefinition` 把 ToolDefinition 的 core 字段原样复制为 AgentTool，execute 只额外补 `ExtensionContext`。`wrapRegisteredTool` 再检测执行期间 active tools 的新增量，合并成 `addedToolNames`。注释明确 tool_call/tool_result interception 不在 wrapper，而由 AgentSession 的 agent-core hooks 处理。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`
- symbol：`wrapToolDefinition`, `createToolDefinitionFromAgentTool`
- 辅助行：1-46
- file：`packages/coding-agent/src/core/extensions/wrapper.ts`
- symbol：`wrapRegisteredTool`, `wrapRegisteredTools`
- 辅助行：1-45

**验证：** `verified-source`

### TS26 [源码事实] AgentSession 用 core hooks 集中接入扩展的 tool_call/tool_result

**结论：** AgentSession 安装一次 `agent.beforeToolCall` / `agent.afterToolCall`，执行时读取当前 ExtensionRunner，因此 reload 不需要重装 hook。tool_call 事件收到 validated args，可原地修改或 block；异常被转换为阻止执行的 error。tool_result 事件在 core finalization 前链式覆盖 content/details/isError/usage，之后 app 还统一规范化 result images。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSession._installAgentToolHooks`
- 辅助行：476-537
- file：`packages/coding-agent/src/core/extensions/runner.ts`
- symbol：`ExtensionRunner.emitToolCall`, `ExtensionRunner.emitToolResult`
- 辅助行：877-952
- file：`packages/coding-agent/src/core/extensions/types.ts`
- symbol：`ToolCallEvent`, `ToolCallEventResult`, `ToolResultEvent`, `ToolResultEventResult`
- 辅助行：921-1003, 1105-1129

**边界：** Coding Agent 的 `ToolResultEventResult` 没有 terminate；扩展的 result hook 不能用这个 app API 改 terminate。terminate 可由工具 execute 返回，blocked tool_call 返回，或直接使用 agent-core 的 afterToolCall API 设置。

**验证：** `verified-source`, `verified-contract`

### TS27 [源码事实] app 层工具 registry 与当前 Agent context tools 分离

**结论：** AgentSession 把 built-in definitions 与 extension definitions 都包装成 AgentTool registry，extension 同名项覆盖 built-in registry entry。`setActiveToolsByName` 只从 registry 选当前 tools，忽略未知名字，并同步重建 system prompt；变化在下一 Turn 生效。`prepareNextTurnWithContext` 会把最新 `agent.state.tools` 快照送入下一 provider request。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSession._buildRuntime`, `AgentSession._rebuildRuntimeTools`, `AgentSession.setActiveToolsByName`, `AgentSession._installAgentNextTurnRefresh`
- 辅助行：540-560, 908-954, 2638-2679, 2681-2703

**验证：** `verified-source`

### TS28 [源码事实] 动态工具加载通过 ToolResultMessage 的 transcript load point 连接 app 与 provider

**结论：** extension tool wrapper 比较执行前后的 active tool names，把新增项放进 `AgentToolResult.addedToolNames`；core 将它复制进 ToolResultMessage；支持 native deferred loading 的 provider adapter 把这个结果位置解释为工具加载点，普通 provider 则忽略该字段并在下一请求使用完整 `Context.tools`。这是 app 动态激活、core transcript 和 provider schema 三层的明确连接点。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/extensions/wrapper.ts`
- symbol：`wrapRegisteredTool`
- 辅助行：17-36
- file：`packages/agent/src/agent-loop.ts`
- symbol：`createToolResultMessage`
- 辅助行：777-790
- file：`packages/ai/src/types.ts`
- symbol：`ToolResultMessage.addedToolNames`
- 辅助行：457-463
- file：`packages/ai/src/utils/deferred-tools.ts`
- symbol：`deriveDeferredToolNames`
- 辅助行：1-31

**验证：** `verified-source`, `verified-contract`, `inference`

## 事件顺序速查

### 单个成功工具（串行）

```text
tool_execution_start(raw args)
  prepareArguments?
  validate
  beforeToolCall?
  execute
    tool_execution_update* (partial only)
  afterToolCall?
tool_execution_end(final result, isError=false)
message_start(ToolResultMessage)
message_end(ToolResultMessage)
```

### 单个 validation/unknown/blocked 错误

```text
tool_execution_start(raw args)
  preflight -> immediate error
tool_execution_end(error result, isError=true)
message_start(ToolResultMessage)
message_end(ToolResultMessage)
```

### 两个并行工具 A 慢、B 快

```text
start A -> preflight A
start B -> preflight B
execute A + execute B concurrently
end B
end A
message_start/end result A
message_start/end result B
turn_end(toolResults=[A, B])
```

注意：这里的 end 按完成顺序，最终消息按 assistant source order。

## 错误、abort 与 terminate 对照表

| 情况 | 是否调用 execute | 最终 isError | 是否默认还能给模型一次修正机会 |
| --- | --- | --- | --- |
| 工具不存在 | 否 | true | 是 |
| prepareArguments throw | 否 | true | 是 |
| schema validation 失败 | 否 | true | 是 |
| beforeToolCall throw | 否 | true | 是 |
| beforeToolCall block | 否 | true | 是；若整批都 terminating 则不自动续轮 |
| execute throw | 是 | true | 是 |
| afterToolCall throw | 是 | true，且替换原结果 | 是 |
| stopReason=length 且含 tool calls | 否，整批拒绝 | true | 是，明确要求重发 |
| abort 在 execute 前被观察 | 否 | true | 随后 aborted model/loop 路径结束 |
| abort 时 execute 已运行 | 取决于工具是否 honor signal | 取决于工具 settle 方式 | core 不强杀 promise |
| 单个结果 terminate=true | 是或 blocked | 保持原状态 | 同批并非全 true 时仍续轮 |
| 整批最终结果 terminate=true | 是或 blocked | 保持各项状态 | 不因工具自动续轮，但 steering/follow-up 仍可续 Run |

## Book 必须明确的边界与易错点

1. Tool schema 不是 execute：`packages/ai.Tool` 是 provider-facing 描述，`packages/agent.AgentTool` 才拥有本地副作用。
2. provider strict schema 不是 runtime validation：即使模型端请求 constrained sampling，本地仍必须校验。
3. `tool_execution_start` 不等于副作用已启动：parallel 模式会先把整个批次顺序 preflight。
4. parallel 有两种顺序：completion events 按完成顺序，ToolResultMessage/transcript 按 assistant source order。
5. hook mutation 不复验：before/tool_call 是可信应用层能力，修改后 schema 责任属于 hook。
6. 进度不是消息：`tool_execution_update` 只供 UI/观察者，最终 ToolResultMessage 才进入模型上下文。
7. content 不是错误位：工具必须 throw，或 after hook 显式改 `isError`；返回“错误文本”不自动标错。
8. terminate 不写进 transcript，也不取消 siblings；它是整批完成后的自动续轮提示。
9. abort 是协作式：signal 会透传，但 core 不会强制杀掉忽略 signal 的 tool promise。
10. Coding Agent wrapper 不重新实现 core：它只适配 ExtensionContext、UI/prompt metadata、动态激活和扩展 hooks。

## Pi Core 事实与本项目设计选择必须分开

下面左列可直接由固定源码证明；右列不是 Pi Core 自动给出的结论，必须由本书的示例应用或具体产品另行设计、记录和验证。

| Pi Core / 固定源码事实 | 本项目或应用层设计选择 |
| --- | --- |
| 一个 `AgentTool` 有一个 name、一份 parameters schema 和一个 execute。 | 应该把“文件系统”做成一个大工具，还是拆成 read/edit/write；工具粒度由领域任务、权限和可观察性决定。 |
| `beforeToolCall` 可以 block，blocked call 会形成错误 ToolResult。 | 哪些操作需要确认、RBAC/allowlist 如何表达、默认允许还是默认拒绝、拒绝文案和审计规则。Pi Core 没有内建权限模型。 |
| `executionMode` 支持 parallel/sequential，任一 sequential call 会使整批串行。 | 哪些工具可安全并发、是否还要按资源 key 加锁、文件写入如何避免 lost update。声明 parallel 不会自动保证业务副作用安全。 |
| schema validation 约束参数形状并可做类型转换。 | 路径 sandbox、命令 allowlist、数据行级权限、业务额度等语义安全校验。TypeBox schema 不是权限或业务策略。 |
| execute 接收 AbortSignal，core 采用协作式取消。 | 工具如何终止子进程、回滚部分写入、清理临时文件，以及超时策略。 |
| `content` 发给模型，`details` 留给日志/UI；app ToolDefinition 可提供 renderer。 | details 的具体结构、是否持久化敏感字段、UI 展示和脱敏方式。 |
| `terminate` 是整批自动续轮提示。 | 哪些业务结果应当结束任务、是否允许用户队列继续、最终成功判定。terminate 本身不是“任务成功”。 |
| Coding Agent 通过 ToolDefinition/ExtensionContext/扩展 hooks 包装 AgentTool。 | 本书 Lab 是否采用 Coding Agent 包装层，还是直接构造 AgentTool；两者应按教学目标选择，不能把 app API 写成 core 必需步骤。 |

因此，本章正文可以从 Pi 源码讲“机制与边界”，但以下句式都必须标成项目设计，而不能标成 Pi Core 事实：

- “一个工具只做一个原子动作”或“一个工具应覆盖完整工作流”。
- “写操作必须二次确认”或“读工具默认无权限风险”。
- “所有读工具都可并行”或“串行就一定没有竞态”。
- “schema 校验通过就可以安全执行”。
- “terminate=true 表示整个用户任务成功完成”。

## 建议转成独立 evidence map 的候选

| 建议 ID | 问题 | 核心 symbol |
| --- | --- | --- |
| TS-01 | Tool 与 AgentTool 的边界是什么？ | `Tool`, `AgentTool` |
| TS-02 | 参数在 execute 前经过哪些阶段？ | `prepareToolCallArguments`, `validateToolArguments`, `prepareToolCall` |
| TS-03 | validation 会不会转换参数？ | `validateToolArguments` |
| TS-04 | before hook 能否改参数、会不会复验？ | `BeforeToolCallContext`, `prepareToolCall` |
| TS-05 | 默认并行如何选择，sequential override 的作用域是什么？ | `executeToolCalls`, `Agent.constructor` |
| TS-06 | parallel 的 preflight 与 execute 如何分段？ | `executeToolCallsParallel` |
| TS-07 | completion order 与 transcript order 为什么不同？ | `executeToolCallsParallel` |
| TS-08 | 工具进度是否进入模型上下文？ | `executePreparedToolCall`, `emitToolResultMessage` |
| TS-09 | 未知、校验失败与 throw 如何变成 ToolResult？ | `prepareToolCall`, `createErrorToolResult` |
| TS-10 | length 截断为什么不能执行工具？ | `failToolCallsFromTruncatedMessage` |
| TS-11 | abort 能保证立刻终止工具吗？ | `Agent.abort`, `executePreparedToolCall` |
| TS-12 | terminate 的精确批次规则是什么？ | `shouldTerminateToolBatch`, `runLoop` |
| TS-13 | ToolResultMessage 保存哪些字段，哪些字段不保存？ | `ToolResultMessage`, `createToolResultMessage` |
| TS-14 | 统一工具协议如何映射 OpenAI/Anthropic？ | provider `convertTools`, `convertMessages` |
| TS-15 | Coding Agent 如何包装和拦截工具？ | `ToolDefinition`, `wrapToolDefinition`, `_installAgentToolHooks` |
| TS-16 | 动态激活工具如何落到下一次请求？ | `wrapRegisteredTool`, `addedToolNames`, `_installAgentNextTurnRefresh` |

## 本次验证与缺口

- 已确认 submodule gitlink、submodule HEAD 与 tag 三者一致：`v0.84.3` / `4e58f324fae8ebfa98a3d45181fb248072a2afac`。
- 已静态核对 `packages/agent/test/agent-loop.test.ts`、`packages/agent/test/agent.test.ts` 和 `packages/ai/test/validation.test.ts` 中与本章结论直接相关的断言。
- 未运行 upstream Vitest：submodule 没有安装 `node_modules`，因此不宣称测试本次通过。
- 未对所有 provider adapter 逐一列举；OpenAI Chat Completions 与 Anthropic Messages 用于证明统一协议的 adapter 边界，其他 provider 也应从各自 adapter 求证，不从这两个样例外推 wire 字段。
- 没有修改 `upstream/pi/`。
