---
title: "01 Agent Loop"
chapter: "01"
sourceStatus: verified
contentStatus: complete
pageClass: agent-loop-page
---

# 01 Agent Loop

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">Agent Loop 做的事可以先压缩成一句话：把问题交给模型；如果模型要求使用工具，就执行工具、把结果交还给模型；直到模型给出最终回答。源码里的消息、事件和循环，都是在保证这条主线可观察、可中断、可继续。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CORE SYMBOL</span><strong>runLoop()</strong></div>
</div>

学完本章，你应该能回答三个具体问题：

1. 为什么“读取配置并总结”通常会请求模型两次？
2. 模型返回许多 delta，为什么历史里最终只有一条 assistant 消息？
3. 用户修正方向、取消运行或工具要求停止时，Loop 会在哪个位置停下或继续？

## 先看一遍完整过程

先不看函数名。假设用户提出一个任务：

> 读取 `config.json`，告诉我当前使用的模型。

模型自己不能读取本地文件，所以一次完整处理会是：

```text
用户提出任务
  → 模型返回 toolCall：read_file("config.json")
  → Runtime 执行 read_file
  → 工具结果写回消息历史
  → 模型看到结果，回答“当前模型是 ……”
```

这里模型被请求了两次，但用户只发起了一次任务。为了准确描述这两个尺度，本章使用 **Run** 和 **Turn**：

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

所以刚才的例子是 **一个 Run、两个 Turn、两次模型请求**。Turn 01 包含模型提出的 `toolCall` 和对应的 `toolResult`；Turn 02 包含模型读完结果后的最终回答。

`Run` 是本书对 `agent_start → agent_end` 生命周期的教学名称。Pi Core 并没有暴露一个名为 `Run` 的公开类型。

源码锚点：`v0.84.3` · `4e58f3…` · [`packages/agent/src/types.ts` · `AgentEvent`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L421-L443)

下面的轨迹把整条主线展开，并列呈现工具循环与队列消息中 steering、follow-up 的进入位置。

<AgentLoopTrace />

可视化的可维护源文件位于 `diagrams/01-agent-loop/run-lifecycle.mmd`。上面的交互轨迹直接按照 `runAgentLoop()`、`runLoop()` 与 `AgentEvent` 的事件顺序组织。

## 从 `prompt()` 到循环，只记住两层

调用方从 `Agent.prompt()` 进入。高层负责守住一次运行的边界：不允许同一个 Agent 同时启动另一个 Run，把输入整理成 user message，并准备取消信号。低层 `runAgentLoop()` / `runLoop()` 才负责推进事件、模型请求和工具执行。

```text
Agent.prompt(input)                 高层：建立并收尾一次 Run
  → normalizePromptInput()
  → runWithLifecycle()
    → runAgentLoop(...)             低层：复制上下文并发出边界事件
      → runLoop()                   循环：请求模型、执行工具、检查队列
```

低层入口复制上下文，把本次 prompt 放进 `currentContext.messages`，发出 Run、Turn 和 user message 的开始/结束事件，然后进入循环。

循环本身也分两层：

- **内层循环**处理 tool calls 和 steering。只要还有工具结果需要反馈，或者有 steering 要注入，就开始下一个 Turn。
- **外层循环**只在 Agent 本来要停止时检查 follow-up；有追加任务，就重新进入内层循环。

| 读者看到的动作 | 源码里的责任点 |
|---|---|
| 发起一次任务 | `Agent.prompt()` |
| 建立 Run、复制上下文、发出初始事件 | `runAgentLoop()` |
| 请求模型、执行工具、决定是否续轮 | `runLoop()` |
| 结束活动状态并等待监听器完成 | `runWithLifecycle()` / `finishRun()` |

源码锚点：[`agent.ts` · `Agent.prompt`, `runPromptMessages`, `runWithLifecycle`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L347-L507)；[`agent-loop.ts` · `runAgentLoop`, `runLoop`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L95-L275)

## 模型流怎样变成一条消息

模型的回答不是一次性到达的。假设最终回答是“北京今天偏冷”，流里可能先出现“北京”，再出现“今天偏冷”。Pi 不会把这些片段保存成两条消息；它会不断更新同一个临时位置，最后再定稿。

下面默认展示一条文本回答。中间一栏始终是 `context.messages[last]`，变化的是这个位置里的内容和 `PARTIAL / FINAL` 状态。

<StreamMessageFlow />

理解这张图后，再把 `streamAssistantResponse()` 分成前后两半：

- **发送前，准备输入。** `transformContext()` 可以裁剪或补充应用消息；`convertToLlm()` 再把它们转换成模型协议中的 `Message[]`。随后，`streamFunction()` 发起真正的模型请求。
- **接收时，拼装输出。** 流开始时先放入一条 partial assistant message。每个 `text_delta`、`thinking_delta` 或 `toolcall_delta` 到达时，都用最新 partial 替换数组末尾，并发出 `message_update`。流结束后，final message 再替换同一位置，并发出 `message_end`。

| 阶段 | 输入或事件 | 结果 |
|---|---|---|
| 整理应用上下文 | `transformContext(AgentMessage[])` | 仍是应用层消息 |
| 转成模型协议 | `convertToLlm()` | 得到模型可接收的 `Message[]` |
| 发起请求 | `streamFunction()` | 返回流式事件 |
| 接收增量 | `text_delta` / `thinking_delta` / `toolcall_delta` | 替换 partial，发出 `message_update` |
| 完成响应 | 流结束 | 替换 final，发出 `message_end` |

<div class="chapter-rule">
  <strong>关键不变量</strong>
  <span>delta 是更新，不是新消息。同一个 assistant response 在上下文里始终只占一个位置。</span>
</div>

源码锚点：[`agent-loop.ts` · `streamAssistantResponse`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L281-L371)

## Tool Call 为什么让 Loop 继续

回到“读取 `config.json`”的例子。第一个 Turn 结束时，模型没有给出答案，而是留下了一个已经定稿的 `AssistantMessage(toolCall)`。`runLoop()` 从最终消息的 `content` 中找出 `type === "toolCall"` 的内容块，然后执行工具。

对读者而言，主线只有三步：

```text
assistant(toolCall)
  → Runtime 执行工具
  → toolResult 写回消息历史
```

工具结果写回后，下一次模型请求看到的已经不是原问题，而是带有行动结果的完整历史：

```text
user → assistant(toolCall) → toolResult
```

所以 Loop 继续的原因不是“模型还在后台思考”，而是 **Runtime 新增了一条模型尚未见过的 `toolResult`，需要再请求一次模型**。

源码里，工具执行还会细分为查找工具、准备参数、schema 校验、`beforeToolCall`、`tool.execute()` 和 `afterToolCall`。这些属于第二章的重点；第一章只需先抓住闭环。

<div class="chapter-rule">
  <strong>判断工具循环的直接依据</strong>
  <span><code>runLoop()</code> 检查最终 <code>AssistantMessage.content</code> 里的 <code>toolCall</code> 内容块，而不是只看 <code>stopReason === "toolUse"</code>。</span>
</div>

源码锚点：[`agent-loop.ts` · `runLoop`, `executeToolCalls`, `prepareToolCall`, `executePreparedToolCall`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L192-L224)

## Steering 和 Follow-up 不在同一个时机

想象模型已经提出两个工具调用，这时用户补充一句：“只看生产环境。”这条 steering 不会撤回已经定稿的 tool calls，也不会跳过当前工具批次。Loop 会先完成工具、写入结果、结束当前 Turn，然后才把 steering 放进下一次模型请求。

Follow-up 更晚。它只在工具和 steering 都已经处理完、Agent 本来准备退出时被检查。

| 队列 | 何时检查 | 会不会跳过当前工具批次 | 作用 |
|---|---|---|---|
| Steering | 当前 Turn 完成之后、下一次模型请求之前 | 不会 | 修正正在进行的 Run |
| Follow-up | 已经没有工具和 steering，Agent 本来要退出时 | 不会 | 在同一 Run 尾部追加工作 |

队列默认都是 `one-at-a-time`：每个轮询点只取最老的一条。也可以改为 `all`，一次注入当时的全部队列消息。

要建立时间感，可以回到本章开头的交互轨迹，切换到“队列消息”：**工具批次 → `turn_end` → steering → 新 Turn → 本来要停 → follow-up**。

源码锚点：[`agent-loop.ts` · `runLoop`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L166-L274)；[`agent.ts` · `PendingMessageQueue`, `steer`, `followUp`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L120-L153)

## 五种“停下来”不是一回事

先用一张表区分它们影响的是哪条“继续路径”：

| 情况 | Loop 接下来做什么 | 最容易误解的边界 |
|---|---|---|
| 正常收敛 | 没有 tool call 和队列消息，正常退出 | 这是自然结束，不是取消 |
| `error` / `aborted` | 结束当前 Turn 和 Run，不执行消息里的工具 | abort 是协作式取消 |
| `length` | 不执行可能被截断的工具调用；写入 error tool results 后续轮 | 不是直接把半截参数交给工具 |
| 工具结果 `terminate: true` | 关闭“这批工具自动续轮”这条路径 | 队列消息仍可能让 Run 继续 |
| `shouldStopAfterTurn` | Turn 完整结束后、检查队列前退出 | 不会取消正在执行的工具 |

其中有三个边界值得单独记住：

1. `Agent.abort()` 只是触发 `AbortController`。signal 会传给 provider stream、hooks 和 tool；停止速度取决于它们是否及时响应，所以这是**协作式取消**。
2. `length` 可能留下勉强可解析、但语义不完整的工具参数。Pi 为这些调用生成 error tool results，让模型下一轮重发完整调用。
3. 一批工具中必须是**每个最终结果**都带 `terminate: true`，才会关闭工具自动续轮。一个 terminate 加一个普通结果仍会续轮。

低层 `StreamFn` 的契约要求把请求失败编码进流事件和最终失败消息，而不是 throw。若遗留实现真的 throw，高层 `Agent.runWithLifecycle()` 会兜底合成失败消息，并补齐结束事件。

源码锚点：[`agent-loop.ts` · error/aborted, length, shouldStopAfterTurn`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L192-L257)；[`agent-loop.ts` · `shouldTerminateToolBatch`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L582-L584)

## 并行工具有两种顺序

假设模型依次请求工具 A 和 B。A 读取一个大文件，需要 800ms；B 读取一个小文件，只需 100ms。

界面应该尽快告诉用户 B 已完成，所以完成事件按真实时间出现：`B → A`。但历史记录如果也按完成速度写入，每次运行都可能得到不同顺序。Pi 因此把结果恢复为模型最初提出的顺序：`A → B`。

| 观察位置 | 顺序 | 为什么 |
|---|---|---|
| `tool_execution_end` 事件 | B → A | 及时呈现真实完成进度 |
| transcript 中的 `toolResult` | A → B | 保持消息历史稳定 |

完整执行规则是：

1. 工具调用仍按 assistant 源顺序逐个预检。
2. 通过预检的工具才并发执行。
3. `tool_execution_end` 按真实完成顺序发出，方便 UI 及时显示进度。
4. `ToolResultMessage` 和 `turn_end.toolResults` 最终仍按 assistant 源顺序写入，保证 transcript 稳定。

`Agent` 在固定版本中的默认 `toolExecution` 是 `parallel`。如果全局配置为 `sequential`，或者同一批任意一个目标工具声明 `executionMode: "sequential"`，**整批**都会改为串行执行。

源码锚点：[`agent-loop.ts` · `executeToolCalls`, `executeToolCallsParallel`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L411-L553)；测试锚点：[`agent-loop.test.ts` · completion order / source order](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/test/agent-loop.test.ts#L586-L679)

## `agent_end` 之后才真正 idle

看到 `agent_end`，只能说明 Loop 已经发出了最后一个事件，还不能说明所有收尾工作都已完成。

例如，一个监听器会在 `agent_end` 时把最终历史写入磁盘。高层 `Agent` 会等待这些 listener 依次完成，之后 `finishRun()` 才清掉活动 Run，并把 `isStreaming` 设回 false。

```text
agent_end emitted
  → await agent_end listeners
  → finishRun()
  → isStreaming = false
  → prompt() / waitForIdle() 完成
```

因此，监听器可以把 `agent_end` 当作最后一次落盘机会；调用方要确认整个 Run 已经 settled，应等待 `prompt()` 或 `waitForIdle()`。

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
  <p>现在再看 Agent Loop，可以先讲清一条业务主线：模型提出动作，Runtime 执行动作，结果回到下一次模型请求。然后再用 Run / Turn 标出边界，用 partial / final 解释流式消息，用 steering / follow-up 解释续轮时机，最后用 settlement 区分“最后一个事件”和“真正空闲”。</p>
</section>
