---
title: "02 Tool System"
chapter: "02"
sourceStatus: verified
contentStatus: complete
pageClass: chapter-detail-page
---

# 02 Tool System

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">模型只能提出“请调用哪个工具、参数是什么”，真正执行动作的是 Runtime。Tool System 要先确认工具存在、参数合法、操作获准，再执行它。无论成功还是失败，结果都会写回消息历史，让模型知道刚才发生了什么。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CORE SYMBOL</span><strong>AgentTool</strong></div>
</div>

读完本章，你应该能回答三个问题：

1. 为什么参数符合 schema，工具仍然可以拒绝执行？
2. 一次调用在哪些位置可能失败，失败后为什么 Agent Loop 通常还能继续？
3. 哪些结果应该给模型，哪些细节只应该留给 UI、日志或 Runtime？

## 一个写文件请求，要过几关

假设模型生成了下面的请求：

```text
write_file({ path: ".env", content: "API_KEY=..." })
```

这段参数符合常见的 JSON 结构，但 Runtime 还不能直接写文件。它至少要确认五件事：`write_file` 是否存在、参数是否符合本地 schema、`.env` 是否允许修改、执行有没有成功，以及哪些结果应该交给模型。

下面的交互展示四种结果：正常写入、参数错误、权限阻止和执行异常。四条路径最后都会产生 `ToolResultMessage`，这样模型下一轮既能看到成功结果，也能看到失败原因。

<ToolPipeline />

交互按照 `prepareToolCall()` 到 `createToolResultMessage()` 的控制流组织。图源位于 `diagrams/02-tool-system/call-pipeline.mmd`。

## 模型不能直接执行工具

先区分“告诉模型有哪些工具”和“真正执行工具”。同一个工具在不同层有不同形状：

| 层 | 使用的契约 | 这一层关心什么 |
|---|---|---|
| 模型协议 | `Tool` | 名字、描述、参数 schema；让模型知道可以怎样提出请求 |
| Agent Runtime | `AgentTool` | 本地执行、参数兼容、取消、进度和串并行约束 |
| Coding Agent 应用 | `ToolDefinition` | 扩展 context、终端渲染等产品能力，再包装成 `AgentTool` |
| Provider adapter | 各家 wire format | 把统一 Tool/ToolResult 翻译成 OpenAI、Anthropic 等协议 |

最小的模型契约只有：

```ts
interface Tool<TParameters extends TSchema> {
  name: string
  description: string
  parameters: TParameters
  constrainedSampling?: false | ConstrainedSamplingConfig
}
```

这个 `Tool` 只告诉模型怎样提出请求，不包含可执行函数。到了 Runtime，`AgentTool extends Tool` 才增加 `execute()`、`prepareArguments?`、`AbortSignal`、`onUpdate?` 和 `executionMode?`。

```text
模型看到 Tool schema
  → 模型生成 ToolCall
  → Agent Runtime 校验并执行 AgentTool
  → Provider adapter 把 ToolResultMessage 翻译回线协议
```

因此，把“不要访问敏感文件”写进 `description` 只能提醒模型，不能真正阻止访问。provider 的 JSON schema 也只是第一层约束，Runtime 仍要在本地校验参数并执行权限策略。

可维护的分层图位于 `diagrams/02-tool-system/contract-layers.mmd`。

源码锚点：[`packages/ai/src/types.ts` · `Tool`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/types.ts#L514-L519)；[`packages/agent/src/types.ts` · `AgentTool`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L360-L408)

## 七步执行链

把刚才的 `write_file` 放回源码，完整顺序是：

| 顺序 | Runtime 做什么 | 失败时发生什么 |
|---|---|---|
| 1. 查找 | `tools.find(name)` | 直接产生 `Tool not found` 错误结果 |
| 2. 兼容 | `prepareArguments?` 处理旧参数格式 | throw 被归一化为错误结果 |
| 3. 校验 | `validateToolArguments()` clone、规范化并校验 | 返回带 schema 路径的错误结果 |
| 4. 策略 | `beforeToolCall?` 检查权限或确认 | 可以 `block` 并给出原因 |
| 5. 执行 | `execute()` 产生真实副作用 | throw 被捕获为错误 result |
| 6. 后处理 | `afterToolCall?` 观察或覆盖 envelope | hook throw 也会变成错误 result |
| 7. 写回 | `createToolResultMessage()` 生成标准消息 | `isError=true` 同样写进 transcript |

七步不需要死记。只要抓住一条主线：请求在任何一步失败，Runtime 都尽量把失败变成 `ToolResultMessage`，而不是让整个 Loop 直接崩掉。模型下一轮看到错误后，还有机会修正请求。

## 参数格式、结构和权限

三者都像在“检查参数”，实际回答的是三个不同问题。

### 先兼容旧格式

`prepareArguments()` 回答“旧格式怎样转成当前格式”。例如，旧模型给允许缺省 path 的工具传来 `{ path: null }`，compatibility shim 可以先移除这个 null。转换后的参数还没有通过本地校验，此时不能据此授权。

### 再检查结构

`validateToolArguments()` 回答“这份参数是否符合本地 schema”。它会 clone 参数，处理 null 和 schema 约束，再产出交给工具的本地参数。provider 端的 constrained sampling 只能减少坏参数，不能代替这次本地校验。

### 最后判断能不能做

`beforeToolCall` 回答“结构正确的操作是否获准”。它收到已经校验的参数，适合处理权限、用户确认和策略阻止。

固定源码允许 hook **原地修改** args，而且修改后不会再次校验。这里可以做受控重写，但 hook 作者必须保证改完的参数仍符合 schema。

<div class="chapter-rule">
  <strong>Schema 合法不等于操作被授权</strong>
  <span><code>write_file({ path: ".env" })</code> 可以完全符合结构要求，应用层 policy 仍应阻止它。结构校验与业务权限是两道独立边界。</span>
</div>

源码锚点：[`agent-loop.ts` · `prepareToolCallArguments`, `prepareToolCall`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L586-L668)；[`validation.ts` · `validateToolArguments`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/utils/validation.ts#L317-L366)

## 一份结果，三类读者

假设 `read_file` 读到一个 5 MB 文件。模型也许只需要前 200 行和“结果已截断”的提示；UI 想显示编码、总字节数和保存路径；Runtime 还要判断是否继续下一轮。三类读者需要的内容不同，不能全塞进一段文本。

`AgentToolResult<TDetails>` 因此把用途拆开：

| 字段 | 主要读者 | 是否直接进入模型历史 |
|---|---|---|
| `content` | 模型 | 是，成为 ToolResultMessage 的 text/image |
| `details` | 应用 UI / 日志 | 不由 Core 当作任意模型内容发送 |
| `usage` | Runtime / 观测 | 可随工具结果记录，但不计入主 LLM context accounting |
| `addedToolNames` | Runtime / provider | 标记动态工具从哪里开始出现 |
| `terminate` | Loop 控制流 | 不写进 ToolResultMessage，只影响批次续轮 |

`onUpdate` 负责另一件事：把执行进度交给 UI。它发出 `tool_execution_update`，但不进入 transcript。只有 execute promise settle 后的最终 result 才会成为历史事实；此后迟到的 update 会被忽略。

源码锚点：[`agent-loop.ts` · `executePreparedToolCall`, `createToolResultMessage`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L670-L795)

## 失败也会写成结果

<div class="misconception-list">
  <div><strong>未知工具</strong><p>按 name 精确查找失败，不执行 hook 或副作用，直接生成错误结果。</p></div>
  <div><strong>参数无效</strong><p>在 preflight 中被 validation 截住，工具和 before hook 都不会运行。</p></div>
  <div><strong>策略阻止</strong><p>请求结构正确，但 <code>beforeToolCall</code> 根据权限或业务规则拒绝。</p></div>
  <div><strong>执行异常</strong><p><code>execute</code> throw 后由 Runtime 转成 <code>isError=true</code>，after hook 仍可观察或覆盖。</p></div>
</div>

这些失败发生在不同位置，但都会写成模型能读懂的错误结果。普通 `return` 不会因为 `content` 里写着“失败”就自动变成 error；工具实现必须遵守契约：失败时 throw，成功时 return。

还有一个特殊情况：如果 AssistantMessage 因 `stopReason="length"` 被截断，其中所有 tool calls 都不会执行。参数即使碰巧能解析成 JSON，也可能缺少后半段。Pi 会为每条调用生成错误结果，让模型重发完整参数。

## 哪些工具可以并行

假设模型同时要求“读取网页”和“修改同一个配置文件”。读网页通常可以并行，多个操作同时改同一文件则可能互相覆盖。是否并行不只是性能选择，也关系到副作用能不能预测。

- 默认工具批次并行，但任一目标工具声明 `executionMode: "sequential"`，整批都会串行。
- lookup、validation 和 before hook 仍按模型提出的顺序 preflight；只有获准的 execute 才并发。
- `tool_execution_end` 可以按真实完成顺序出现，最终 ToolResultMessage 仍按模型源顺序写入。
- abort 通过 `AbortSignal` 协作传播，Runtime 不能强杀一个忽略 signal 的 promise。
- `terminate` 只有在整批最终结果全部为 true 时生效，而且只关闭工具驱动的自动续轮。

因此，互不依赖的只读查询适合 parallel。会共享事务、终端或可变文件状态的工具，应选择 sequential，或者在工具内部实现锁和事务。

## Tool、CLI、MCP 和 Skill

这四个词经常一起出现，但解决的问题不同。下面是本书用于工程设计的职责划分，**不是 Pi Core 导出的四个类型**：

| 名称 | 它解决什么问题 | 怎样接入 AgentTool |
|---|---|---|
| Tool | 让模型选择一个受控能力 | 直接实现或适配成 `AgentTool` |
| CLI | 让人或进程调用命令 | stdout、stderr、exit code 要转换成 result envelope |
| MCP | 发现和远程调用工具 | adapter 可把远程声明映射成 AgentTool；本章 Core 不定义 MCP |
| Skill | 提供指令、流程和资源 | 可以指导何时使用 Tool，但不提供 execute，也不替代权限层 |

`ToolDefinition` 是 Coding Agent 的应用层 superset，`wrapToolDefinition()` 负责把它适配成 Runtime 能用的形状。schema 校验、批次调度、错误归一化和标准事件仍由 Core 统一实现。最后，Provider adapter 再把 `Tool` 转成各家的 wire format。

## 工具设计清单

以下是从源码边界推导出的应用建议，不是 Pi 自动提供的保证：

- **动作单一**：不要用 `admin(action, payload)` 混合读、写、删。
- **输入最小**：schema 只暴露完成动作所需字段，枚举优于自由文本协议。
- **权限独立**：高风险副作用在 `beforeToolCall` 或工具内部再次确认。
- **幂等明确**：支付、发信、创建资源接受并持久化 idempotency key。
- **取消与超时**：工具监听 `AbortSignal`，外部 I/O 还要有自己的 timeout。
- **结果有预算**：模型需要的最小事实进 `content`，完整结构进 `details` 或外部存储。
- **并发可证明**：有共享可变状态就串行，或实现锁/事务。
- **进度不是事实**：update event 给 UI，最终 result 才写进 transcript。

## 本章证据地图

<div class="evidence-grid">
  <article><code>TS-01</code><h3>三层契约</h3><p><code>Tool</code> 与 <code>AgentTool</code></p></article>
  <article><code>TS-02 — TS-04</code><h3>参数边界</h3><p>prepare、validation、before hook</p></article>
  <article><code>TS-05 — TS-07</code><h3>批次调度</h3><p>模式选择、preflight、双重顺序</p></article>
  <article><code>TS-08</code><h3>进度事件</h3><p><code>onUpdate</code> 不进入 transcript</p></article>
  <article><code>TS-09 — TS-12</code><h3>失败与停止</h3><p>error、length、abort、terminate</p></article>
  <article><code>TS-13</code><h3>最终结果消息</h3><p><code>createToolResultMessage</code></p></article>
  <article><code>TS-14</code><h3>Provider 翻译</h3><p>统一协议与 wire format</p></article>
  <article><code>TS-15 / TS-16</code><h3>应用包装与动态工具</h3><p>Coding Agent wrapper、load point</p></article>
  <article><code>SOURCE NOTES</code><h3>完整研究索引</h3><p><code>evidence/02-tool-system/source-notes.md</code> 共 28 条原始证据</p></article>
</div>

本章只讨论一次工具请求怎样安全地变成执行结果。Context compaction、Session 重放和产品级 evaluation 分别在第三、四、五章展开。

<section class="chapter-summary">
  <h2>本章收束</h2>
  <p>模型只提出 ToolCall，Runtime 才负责执行。一次调用依次经过查找、兼容、校验、授权、执行、后处理和写回；任何一步失败，都应尽量变成模型能看到的结果。设计工具时，还要分别处理副作用、并发、取消，以及模型、UI 和 Runtime 各自需要的信息。</p>
</section>
