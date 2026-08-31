---
title: "01 Agent Loop"
chapter: "01"
sourceStatus: verified
contentStatus: complete
pageClass: agent-loop-page
---

# 01 Agent Loop

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">Agent Loop 可以理解为一轮一轮地问模型。模型要用工具，Runtime 就执行工具，把结果补进消息历史，再问模型一次。模型直接回答，或者某个停止条件生效，这次运行就结束。本章先沿着这条主线走一遍，再看源码怎样记录和控制每一步。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CORE SYMBOL</span><strong>runLoop()</strong></div>
</div>

读完本章，你应该能回答三个问题：

1. 为什么“读取配置并总结”通常会请求模型两次？
2. 模型返回许多 delta，为什么历史里最终只有一条 assistant 消息？
3. 用户修正方向、取消运行或工具要求停止时，Loop 会在哪个位置停下或继续？

## 一个任务，两次模型请求

先看一个例子，不急着记函数名：

> 读取 `config.json`，告诉我当前使用的模型。

模型不能直接读取本地文件。第一次请求时，它会请 Runtime 调用 `read_file`。Runtime 读完文件，把结果写进消息历史。模型在第二次请求中看到结果，才能回答用户的问题。

```text
用户提出任务
  → 模型返回 toolCall：read_file("config.json")
  → Runtime 执行 read_file
  → 工具结果写回消息历史
  → 模型看到结果，回答“当前模型是 ……”
```

用户只发起了一次任务，模型却被请求了两次。为了区分这两个尺度，本章使用 **Run** 和 **Turn**：

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

套回刚才的例子：这是 **一个 Run、两个 Turn、两次模型请求**。Turn 01 包含 `toolCall` 和对应的 `toolResult`；Turn 02 是模型读完结果后的最终回答。

`Run` 是本书对 `agent_start → agent_end` 生命周期的教学名称。Pi Core 并没有暴露一个名为 `Run` 的公开类型。

源码锚点：`v0.84.3` · `4e58f3…` · [`packages/agent/src/types.ts` · `AgentEvent`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L421-L443)

先用交互轨迹看完整顺序。后面的段落再解释每一步由哪个函数负责，以及 steering 和 follow-up 会从哪里加入。

<AgentLoopTrace />

图的可维护源文件位于 `diagrams/01-agent-loop/run-lifecycle.mmd`。交互轨迹按照 `runAgentLoop()`、`runLoop()` 与 `AgentEvent` 的事件顺序组织。

## 从 `prompt()` 到 `runLoop()`

现在把函数名放回来。任务从 `Agent.prompt()` 进入，它负责一次 Run 的入口和收尾：阻止同一个 Agent 同时启动另一个 Run，把输入整理成 user message，并准备取消信号。模型请求和工具执行则交给 `runAgentLoop()` / `runLoop()`。

```text
Agent.prompt(input)                 高层：建立并收尾一次 Run
  → normalizePromptInput()
  → runWithLifecycle()
    → runAgentLoop(...)             低层：复制上下文并发出边界事件
      → runLoop()                   循环：请求模型、执行工具、检查队列
```

`runAgentLoop()` 先复制上下文，把本次 prompt 放进 `currentContext.messages`，再发出 Run、Turn 和 user message 的开始/结束事件。准备完成后，它把控制权交给 `runLoop()`。

`runLoop()` 里面还有两层循环：

- **内层循环**处理 tool calls 和 steering。有工具结果要交给模型，或者有 steering 要加入时，就开始下一个 Turn。
- **外层循环**等内层准备退出时再检查 follow-up。取到追加任务后，重新进入内层循环。

| 读者看到的动作 | 源码里的责任点 |
|---|---|
| 发起一次任务 | `Agent.prompt()` |
| 建立 Run、复制上下文、发出初始事件 | `runAgentLoop()` |
| 请求模型、执行工具、决定是否续轮 | `runLoop()` |
| 结束活动状态并等待监听器完成 | `runWithLifecycle()` / `finishRun()` |

源码锚点：[`agent.ts` · `Agent.prompt`, `runPromptMessages`, `runWithLifecycle`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L347-L507)；[`agent-loop.ts` · `runAgentLoop`, `runLoop`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L95-L275)

## 流式响应怎样归成一条消息

模型的回答是一点点流出来的，但消息历史不会因此多出许多条 assistant 消息。

假设最终回答是“北京今天偏冷”。流里可能先到“北京”，再到“今天偏冷”。Pi 会先放入一条临时 assistant message，每收到一个 delta 就更新它；流结束后，再把这条消息定稿。

交互中间一栏始终显示 `context.messages[last]`。播放时可以看到：内容一直在变，消息位置没有增加。

<StreamMessageFlow />

看完现象，再对照 `streamAssistantResponse()`。这个函数分两段工作：

- **请求前。** `transformContext()` 可以裁剪或补充应用消息；`convertToLlm()` 再把它们转成模型能接收的 `Message[]`。准备好以后，`streamFunction()` 发起请求。
- **响应中。** 流开始时先放入一条 partial assistant message。收到 `text_delta`、`thinking_delta` 或 `toolcall_delta` 时，用新的 partial 替换数组末尾，并发出 `message_update`。流结束后，final message 替换同一位置，并发出 `message_end`。

| 阶段 | 输入或事件 | 结果 |
|---|---|---|
| 整理应用上下文 | `transformContext(AgentMessage[])` | 仍是应用层消息 |
| 转成模型协议 | `convertToLlm()` | 得到模型可接收的 `Message[]` |
| 发起请求 | `streamFunction()` | 返回流式事件 |
| 接收增量 | `text_delta` / `thinking_delta` / `toolcall_delta` | 替换 partial，发出 `message_update` |
| 完成响应 | 流结束 | 替换 final，发出 `message_end` |

<div class="chapter-rule">
  <strong>一条响应，只占一个消息位置</strong>
  <span>delta 更新的是内容，不会在历史里新增 assistant 消息。</span>
</div>

源码锚点：[`agent-loop.ts` · `streamAssistantResponse`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L281-L371)

## 工具结果为什么会触发下一轮

回到“读取 `config.json`”的例子。第一次模型请求结束后，历史里多了一条 `AssistantMessage(toolCall)`，还没有最终答案。`runLoop()` 在这条消息的 `content` 中找到 `type === "toolCall"` 的内容块，于是开始执行工具。

执行链有三步：

```text
assistant(toolCall)
  → Runtime 执行工具
  → toolResult 写回消息历史
```

工具执行完后，模型还没有看过结果。Runtime 必须把 `toolResult` 写进历史，再请求一次模型。第二次请求拿到的上下文是：

```text
user → assistant(toolCall) → toolResult
```

这就是工具让 Loop 继续的原因：历史里出现了模型尚未见过的新信息。两次请求之间，模型没有在“后台思考”；是 Runtime 带着新上下文再次调用了它。

工具内部还要经过查找、参数准备、schema 校验、`beforeToolCall`、`tool.execute()` 和 `afterToolCall`。这些留到第二章；这里先记住“结果写回历史，模型再看一次”。

<div class="chapter-rule">
  <strong>工具是否执行，要看消息内容</strong>
  <span><code>runLoop()</code> 直接检查 <code>AssistantMessage.content</code> 里的 <code>toolCall</code>，不只看 <code>stopReason === "toolUse"</code>。</span>
</div>

源码锚点：[`agent-loop.ts` · `runLoop`, `executeToolCalls`, `prepareToolCall`, `executePreparedToolCall`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L192-L224)

## Steering 和 Follow-up

两者都是用户在运行过程中追加的消息，区别在于 Loop 什么时候读取它们。

- **Steering** 用来修正当前方向。Loop 会在当前 Turn 结束后读取它，然后带着修正进入下一个 Turn。
- **Follow-up** 用来追加工作。只有工具和 steering 都处理完、Agent 准备退出时，外层循环才会读取它。

例如，模型已经提出两个工具调用，这时用户补充一句：“只看生产环境。”这条 steering 不会撤回已经定稿的 tool calls，也不会跳过当前工具批次。Loop 会先完成工具、写入结果、结束当前 Turn，再把 steering 放进下一次模型请求。

| 队列 | 何时检查 | 会不会跳过当前工具批次 | 作用 |
|---|---|---|---|
| Steering | 当前 Turn 完成之后、下一次模型请求之前 | 不会 | 修正正在进行的 Run |
| Follow-up | 已经没有工具和 steering，Agent 本来要退出时 | 不会 | 在同一 Run 尾部追加工作 |

队列默认都是 `one-at-a-time`：每个轮询点只取最老的一条。也可以改为 `all`，一次注入当时的全部队列消息。

把两个队列放在一条时间线上，顺序是：**工具批次 → `turn_end` → steering → 新 Turn → 本来要停 → follow-up**。本章开头的交互轨迹也按这个顺序播放。

源码锚点：[`agent-loop.ts` · `runLoop`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L166-L274)；[`agent.ts` · `PendingMessageQueue`, `steer`, `followUp`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L120-L153)

## 五种停止方式

它们看起来都像“停了”，实际切断的是不同路径。先看结果，再看三个容易误判的条件：

| 情况 | Loop 接下来做什么 | 最容易误解的边界 |
|---|---|---|
| 正常收敛 | 没有 tool call 和队列消息，正常退出 | 这是自然结束，不是取消 |
| `error` / `aborted` | 结束当前 Turn 和 Run，不执行消息里的工具 | abort 是协作式取消 |
| `length` | 不执行可能被截断的工具调用；写入 error tool results 后续轮 | 不是直接把半截参数交给工具 |
| 工具结果 `terminate: true` | 关闭“这批工具自动续轮”这条路径 | 队列消息仍可能让 Run 继续 |
| `shouldStopAfterTurn` | Turn 完整结束后、检查队列前退出 | 不会取消正在执行的工具 |

三处需要再展开一下：

1. `Agent.abort()` 会触发 `AbortController`。signal 随后传给 provider stream、hooks 和 tool。它们响应得越及时，运行停得越快。这是一种**协作式取消**。
2. `length` 可能留下勉强可解析、但语义不完整的工具参数。Pi 为这些调用生成 error tool results，让模型下一轮重发完整调用。
3. 只有这批工具的**每个最终结果**都带 `terminate: true`，工具自动续轮才会关闭。一个 terminate 加一个普通结果，Loop 仍会继续。

`StreamFn` 按契约要把请求失败写进流事件和最终失败消息，而不是 throw。如果遗留实现真的 throw，高层 `Agent.runWithLifecycle()` 会合成失败消息，并补齐结束事件。

源码锚点：[`agent-loop.ts` · error/aborted, length, shouldStopAfterTurn`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L192-L257)；[`agent-loop.ts` · `shouldTerminateToolBatch`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L582-L584)

## 并行工具的两种顺序

假设模型依次请求工具 A 和 B。A 读取一个大文件，需要 800ms；B 读取一个小文件，只需 100ms。

B 只用 100ms，会先完成。界面收到的 `tool_execution_end` 因此是 `B → A`，可以及时显示真实进度。

消息历史不能跟着完成速度变化，否则同一批工具每次都可能写出不同顺序。Pi 写入 transcript 时会恢复模型提出工具的顺序，也就是 `A → B`。

| 观察位置 | 顺序 | 为什么 |
|---|---|---|
| `tool_execution_end` 事件 | B → A | 及时呈现真实完成进度 |
| transcript 中的 `toolResult` | A → B | 保持消息历史稳定 |

把两种顺序放回执行过程：

1. 工具调用仍按 assistant 源顺序逐个预检。
2. 通过预检的工具才并发执行。
3. `tool_execution_end` 按真实完成顺序发出，方便 UI 及时显示进度。
4. `ToolResultMessage` 和 `turn_end.toolResults` 最终仍按 assistant 源顺序写入，保证 transcript 稳定。

`Agent` 在固定版本中的默认 `toolExecution` 是 `parallel`。如果全局配置为 `sequential`，或者同一批任意一个目标工具声明 `executionMode: "sequential"`，**整批**都会改为串行执行。

源码锚点：[`agent-loop.ts` · `executeToolCalls`, `executeToolCallsParallel`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L411-L553)；测试锚点：[`agent-loop.test.ts` · completion order / source order](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/test/agent-loop.test.ts#L586-L679)

## `agent_end` 之后还有什么

`agent_end` 表示 Loop 已经发出最后一个事件，但异步 listener 可能还在处理这个事件。整个 Run 此时还没有真正空闲。

例如，一个 listener 会在 `agent_end` 时把最终历史写入磁盘。高层 `Agent` 会等这些 listener 依次完成。之后，`finishRun()` 才清掉活动 Run，并把 `isStreaming` 设回 false。

```text
agent_end emitted
  → await agent_end listeners
  → finishRun()
  → isStreaming = false
  → prompt() / waitForIdle() 完成
```

等到 `prompt()` 或 `waitForIdle()` 返回，整个 Run 才算 settled。调用方如果准备关闭资源，应该等待这个时刻，而不是只等 `agent_end`。

源码锚点：[`agent.ts` · `subscribe`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L240-L253)、[`processEvents`, `finishRun`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L529-L590)

## 四个常见误解

<div class="misconception-list">
  <div><strong>工具是否执行，看 <code>toolCall</code></strong><p>Loop 直接检查 AssistantMessage.content。stopReason 是结果标签，error、aborted 和 length 另有控制语义。</p></div>
  <div><strong>Steering 不会打断当前工具</strong><p>当前 Turn 的工具全部完成、turn_end 发出后，Loop 才注入 steering。</p></div>
  <div><strong>并行只会打乱完成事件</strong><p>持久化 tool results 时，Pi 仍会恢复 assistant 源顺序。</p></div>
  <div><strong><code>agent_end</code> 还不是 idle</strong><p>异步 listeners 处理完最后一个事件后，Run 才 settled。</p></div>
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

本章只讨论 Agent Loop 的控制流。Tool schema、权限设计、Context compaction 和 Session 持久化分别在后面的章节展开。

<section class="chapter-summary">
  <h2>本章收束</h2>
  <p>先记住最短的一条主线：模型提出动作，Runtime 执行动作，再把结果交给模型。一次 Run 可以包含多个 Turn；一次流式响应只会定稿成一条 assistant 消息；工具结果、steering 和 follow-up 会在不同位置触发下一轮。看到 <code>agent_end</code> 后，还要等 listener 收尾，整个 Run 才真正空闲。</p>
</section>
