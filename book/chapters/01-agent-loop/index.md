---
title: "01 Agent Loop"
chapter: "01"
sourceStatus: verified
contentStatus: complete
pageClass: agent-loop-page
---

# 01 Agent Loop

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">Agent Loop 不是“模型一直思考”，而是一段受事件和消息驱动的控制流：把上下文交给模型，接住流式 AssistantMessage，执行其中的工具调用，把结果写回上下文，再决定是否开始下一个 Turn。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CORE SYMBOL</span><strong>runLoop()</strong></div>
</div>

学完本章，你应该能做到三件事：

1. 区分一次 **Run** 和其中的一次 **Turn**。
2. 从用户消息一路追到 `toolResult`，再解释为什么模型会被调用第二次。
3. 预测 steering、follow-up、abort、terminate 和并行工具批次会怎样改变事件顺序。

## 先抓住两个边界

<div class="concept-pair">
  <div>
    <span class="concept-number">RUN / 外层边界</span>
    <h3>一次完整处理过程</h3>
    <p>从 <code>agent_start</code> 开始，到 <code>agent_end</code> 结束。一个 Run 可以因为工具、steering 或 follow-up 包含多个 Turn。</p>
  </div>
  <div>
    <span class="concept-number">TURN / 内层单元</span>
    <h3>一次模型响应及其工具结果</h3>
    <p>源码对 Turn 的定义是“一次 assistant response，加上它触发的所有 tool calls/results”。每次 Turn 都由 <code>turn_start</code> 和 <code>turn_end</code> 包围。</p>
  </div>
</div>

这两个概念不是同义词。用户说“读取配置并总结”，模型先请求 `read_file`，拿到结果后再总结：这是 **一个 Run、两个 Turn、两次模型请求**。需要注意，`Run` 是本书对 `agent_start → agent_end` 生命周期的教学映射；Pi Core 没有暴露名为 `Run` 的公开类型。

源码锚点：`v0.84.3` · `4e58f3…` · [`packages/agent/src/types.ts` · `AgentEvent`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L421-L443)

<AgentLoopTrace />

可视化的可维护源文件位于 `diagrams/01-agent-loop/run-lifecycle.mmd`。上面的交互轨迹直接按照 `runAgentLoop()`、`runLoop()` 与 `AgentEvent` 的事件顺序组织。

## 一次 Run 是怎样进入循环的

高层入口是 `Agent.prompt()`。它拒绝与另一个活动 Run 并发，然后把字符串正规化为 user message，创建 `AbortController`，最后调用低层的 `runAgentLoop()`。

```text
Agent.prompt(input)
  → normalizePromptInput()
  → runWithLifecycle()
  → runAgentLoop(prompts, context snapshot, config, signal, streamFn)
  → runLoop()
```

低层入口先复制初始上下文，把本次 prompt 放进 `currentContext.messages`，然后依次发出：

```text
agent_start
turn_start
message_start(user)
message_end(user)
```

接着才进入 `runLoop()`。这里有两个嵌套循环：

- **内层循环**处理 tool calls 和 steering。只要还有工具要反馈给模型，或有 steering 待注入，就继续下一个 Turn。
- **外层循环**在 Agent 本来要停止时检查 follow-up；有 follow-up 就重新进入内层循环。

源码锚点：[`agent.ts` · `Agent.prompt`, `runPromptMessages`, `runWithLifecycle`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L347-L507)；[`agent-loop.ts` · `runAgentLoop`, `runLoop`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L95-L275)

## 模型流怎样变成一条消息

每次请求模型前，`streamAssistantResponse()` 依次做四件事：

1. 可选地执行 `transformContext(AgentMessage[])`。
2. 执行 `convertToLlm()`，把应用消息变成模型能理解的 `Message[]`。
3. 调用注入的 `streamFunction(model, llmContext, options)`。
4. 把流事件归并为一条最终 `AssistantMessage`。

流开始时，partial assistant message 就被放进 `context.messages`；每个 `text_delta`、`thinking_delta` 或 `toolcall_delta` 都替换最后一条 partial，并发出 `message_update`。流结束后，最终消息再替换 partial，最后发出 `message_end`。

<div class="chapter-rule">
  <strong>关键不变量</strong>
  <span>同一个 assistant response 在上下文里只占一个位置：流式阶段不断替换 partial，结束时再由 final message 定稿，而不是把每个 delta 追加成新消息。</span>
</div>

源码锚点：[`agent-loop.ts` · `streamAssistantResponse`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L281-L371)

## Tool Call 为什么让 Loop 继续

模型流结束后，`runLoop()` 从 `AssistantMessage.content` 中筛选所有 `type === "toolCall"` 的内容块。真正驱动工具循环的是这些内容块，不是只看 `stopReason === "toolUse"`。

每个工具调用会经历：

```text
tool_execution_start
  → 查找工具
  → prepareArguments（可选）
  → validateToolArguments
  → beforeToolCall（可阻止）
  → tool.execute(signal, onUpdate)
  → afterToolCall（可改写结果）
tool_execution_end
  → message_start(toolResult)
  → message_end(toolResult)
```

工具结果随后被追加到 `currentContext.messages`。只要这批工具没有整体要求 terminate，`hasMoreToolCalls` 就保持为真，于是下一个 Turn 会再次请求模型。模型看到的上下文已经是：

```text
user → assistant(toolCall) → toolResult
```

这就是 Tool Loop 的闭环：**模型提出动作，Runtime 执行动作，结果作为新证据回到模型。**

源码锚点：[`agent-loop.ts` · `runLoop`, `executeToolCalls`, `prepareToolCall`, `executePreparedToolCall`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L192-L224)

## Steering 和 Follow-up 不在同一个时机

两者都是排队的 user message，但轮询点不同。

| 队列 | 何时检查 | 会不会跳过当前工具批次 | 作用 |
|---|---|---|---|
| Steering | 当前 Turn 完成之后、下一次模型请求之前 | 不会 | 修正正在进行的 Run |
| Follow-up | 已经没有工具和 steering，Agent 本来要退出时 | 不会 | 在同一 Run 尾部追加工作 |

因此，“steer 是立即打断工具”是错误理解。当前 assistant message 已经发出的整批工具会先完成，tool results 会先进入上下文；steering 随后才在下一个 Turn 注入。

队列默认都是 `one-at-a-time`：每个轮询点只取最老的一条。也可以改为 `all`，一次注入当时的全部队列消息。

源码锚点：[`agent-loop.ts` · `runLoop`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L166-L274)；[`agent.ts` · `PendingMessageQueue`, `steer`, `followUp`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L120-L153)

## 五种“停下来”不是一回事

### 正常收敛

AssistantMessage 没有 tool call，steering 和 follow-up 也都为空。内层、外层循环自然退出，发出 `agent_end`。

### `error` / `aborted`

如果最终 AssistantMessage 的 `stopReason` 是 `error` 或 `aborted`，`runLoop()` 立即发出本次 `turn_end` 和 `agent_end`，不执行其中的工具调用。

`Agent.abort()` 本身只是触发当前 `AbortController`。这个 signal 会传给 provider stream、hooks 和 tool；能多快停下取决于被调用方是否遵守 signal，所以它是**协作式取消**，不是强制杀死执行线程。

低层 `StreamFn` 的契约要求：请求或运行失败应编码为流中的 error 事件和最终失败 AssistantMessage，而不是 throw。若遗留实现真的 throw，高层 `Agent.runWithLifecycle()` 会兜底合成失败消息，并补齐 `message_start/end → turn_end → agent_end`。

### `length`

若输出达到 token 上限，流里残留的 tool call 参数可能只是“勉强能解析”的截断 JSON。Pi 不执行这条 AssistantMessage 中的任何工具，而是为每个调用生成 error tool result，让模型在下一 Turn 重新发出完整调用。

### `terminate: true`

工具、被阻止的 `beforeToolCall` 或 `afterToolCall` 都可以给结果加 `terminate: true`。它只表示“不要因为这批工具自动再请求模型”。只有这一批**每个最终结果**都为 terminate，这条自动续轮路径才关闭；一个 terminate 加一个普通结果仍会继续下一 Turn。即使整批都 terminate，已排队的 steering 或 follow-up 仍可能让同一个 Run 继续。

### `shouldStopAfterTurn`

这是 Turn 完整结束后的优雅停止点。回调在 assistant message 和 tool results 都已写入、`turn_end` 已发出之后执行；返回 true 会在轮询 steering/follow-up 之前发出 `agent_end`。它不取消正在运行的工具，也不改写 `stopReason`。

源码锚点：[`agent-loop.ts` · error/aborted, length, shouldStopAfterTurn`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L192-L257)；[`agent-loop.ts` · `shouldTerminateToolBatch`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L582-L584)

## 并行工具的完成顺序和记录顺序

`Agent` 在这一版的默认 `toolExecution` 是 `parallel`，但这不等于“所有步骤一股脑并行”：

1. 工具调用仍按 assistant 源顺序逐个预检。
2. 通过预检的工具才并发执行。
3. `tool_execution_end` 按真实完成顺序发出，方便 UI 及时显示进度。
4. `ToolResultMessage` 和 `turn_end.toolResults` 最终仍按 assistant 源顺序写入，保证 transcript 稳定。

如果全局配置是 `sequential`，或者同一批任意一个目标工具声明 `executionMode: "sequential"`，**整批**都会串行执行。

| 假设模型依次发出 A、B | A 较慢、B 较快 |
|---|---|
| `tool_execution_end` | B → A |
| transcript 中的 toolResult | A → B |

源码锚点：[`agent-loop.ts` · `executeToolCalls`, `executeToolCallsParallel`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L411-L553)；测试锚点：[`agent-loop.test.ts` · completion order / source order](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/test/agent-loop.test.ts#L586-L679)

## `agent_end` 之后才真正 idle

`agent_end` 是 Loop 产生的最后一个事件，但高层 `Agent` 会按订阅顺序 await 每个 listener。只有 `agent_end` listeners 全部完成，`finishRun()` 才清掉活动 Run，并把 `isStreaming` 设回 false。

所以持久化监听器可以把 `agent_end` 当作“最后一次落盘屏障”；调用方要确认整个 Run 已经 settled，应等待 `prompt()` 或 `waitForIdle()`，而不是仅仅观察到事件。

源码锚点：[`agent.ts` · `subscribe`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L240-L253)、[`processEvents`, `finishRun`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L529-L590)

## 四个最容易混淆的点

<div class="misconception-list">
  <div><strong>“toolUse 才会执行工具”</strong><p>不准确。Loop 直接检查 AssistantMessage.content 里的 toolCall；stopReason 是结果标签，其中 error、aborted 和 length 有额外控制语义。</p></div>
  <div><strong>“steer 会打断当前工具”</strong><p>不准确。Steering 在当前 Turn 的工具全部完成、turn_end 发出之后才注入。</p></div>
  <div><strong>“parallel 会打乱历史”</strong><p>不准确。完成事件可以乱序，但持久化 tool results 会恢复 assistant 源顺序。</p></div>
  <div><strong>“agent_end 就已经 idle”</strong><p>不准确。最后一个事件的异步 listeners 仍属于当前 Run，settlement 在它们完成之后。</p></div>
</div>

## 本章证据地图

<div class="evidence-grid">
  <article><code>AL-01 / AL-02</code><h3>Turn 与 Run 边界</h3><p><code>AgentEvent</code>、<code>runAgentLoop</code>、<code>runLoop</code></p></article>
  <article><code>AL-03</code><h3>流式消息归并</h3><p><code>streamAssistantResponse</code></p></article>
  <article><code>AL-04</code><h3>Tool Loop 继续条件</h3><p><code>runLoop</code>、<code>executeToolCalls</code></p></article>
  <article><code>AL-05 / AL-06</code><h3>两种队列时机</h3><p><code>getSteeringMessages</code>、<code>getFollowUpMessages</code></p></article>
  <article><code>AL-07 — AL-10</code><h3>失败、取消与截断</h3><p><code>stopReason</code>、<code>AbortController</code></p></article>
  <article><code>AL-11 / AL-12</code><h3>Terminate 的条件与范围</h3><p><code>shouldTerminateToolBatch</code>、队列轮询</p></article>
  <article><code>AL-13 / AL-14</code><h3>工具执行次序</h3><p><code>executeToolCallsParallel</code>、per-tool override</p></article>
  <article><code>AL-15</code><h3>Run settlement</h3><p><code>processEvents</code>、<code>finishRun</code></p></article>
  <article><code>SOURCE NOTES</code><h3>完整研究索引</h3><p><code>evidence/01-agent-loop/source-notes.md</code></p></article>
</div>

本章刻意没有深入 Tool schema、权限设计、Context compaction 或 Session 持久化；它们分别属于第二、三、四章。这里先把控制流边界钉牢。

<section class="chapter-summary">
  <h2>本章收束</h2>
  <p>现在可以沿着一次 Run 解释 Turn、模型请求、Tool Result、steering、follow-up 与 settlement 的先后关系，并知道哪些信号不能被误当成整个操作已经完成。</p>
</section>
