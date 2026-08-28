---
title: "02 Tool System"
chapter: "02"
sourceStatus: verified
contentStatus: complete
pageClass: chapter-detail-page
---

# 02 Tool System

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">Tool 不是“模型能执行的函数”。模型只会生成一份带名字和参数的调用请求；真正把这份不可信请求变成受控副作用的，是 schema、本地校验、策略 hook、执行器、结果 envelope 和事件协议共同组成的 Tool System。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CORE SYMBOL</span><strong>AgentTool</strong></div>
</div>

学完本章，你应该能做到：

1. 区分 provider-facing `Tool`、runtime-facing `AgentTool` 和应用层 `ToolDefinition`。
2. 从一条 `ToolCall` 逐步追到最终 `ToolResultMessage`，并预测每类失败在哪一层被截住。
3. 设计一个把模型输入、权限策略、外部副作用、模型可见结果和 UI 详情分开的工具契约。

## Tool System 说三种语言

<div class="evidence-grid">
  <article><code>packages/ai</code><h3>模型协议</h3><p><code>Tool</code> 描述名字、用途和参数 schema；<code>ToolCall</code> 与 <code>ToolResultMessage</code> 是模型请求和结果的统一消息。</p></article>
  <article><code>packages/agent</code><h3>执行协议</h3><p><code>AgentTool</code> 增加本地执行、参数兼容、进度更新和串并行约束；Agent Loop 负责校验、hook、调度和错误归一化。</p></article>
  <article><code>packages/coding-agent</code><h3>应用包装</h3><p><code>ToolDefinition</code> 加入渲染与扩展 context，再通过 wrapper 适配为 Core <code>AgentTool</code>，不复制底层调度器。</p></article>
  <article><code>provider adapters</code><h3>线协议翻译</h3><p>OpenAI、Anthropic 等 adapter 把统一协议翻译成各自 wire format。Pi 的 <code>Tool</code> 不是任一家 API JSON 的别名。</p></article>
</div>

可维护的分层图位于 `diagrams/02-tool-system/contract-layers.mmd`。

## 两份契约，不是一份

模型能看到的基础声明很小：

```ts
interface Tool<TParameters extends TSchema> {
  name: string
  description: string
  parameters: TParameters
  constrainedSampling?: false | ConstrainedSamplingConfig
}
```

它回答“模型怎样提出调用”。真正的本地执行契约由 `AgentTool extends Tool` 补齐：

```ts
interface AgentTool<TParameters extends TSchema, TDetails> extends Tool<TParameters> {
  label: string
  prepareArguments?: (args: unknown) => Static<TParameters>
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>
  executionMode?: "sequential" | "parallel"
}
```

这条边界很重要：`description` 和 schema 只能影响模型如何生成请求，不能自动提供文件权限、幂等、超时或事务语义。

源码锚点：[`packages/ai/src/types.ts` · `Tool`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/types.ts#L514-L519)；[`packages/agent/src/types.ts` · `AgentTool`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L360-L408)

<ToolPipeline />

上面的场景来自 `prepareToolCall()` 到 `createToolResultMessage()` 的真实控制流；图源位于 `diagrams/02-tool-system/call-pipeline.mmd`。

## 七道边界怎样串起来

| 顺序 | 阶段 | 成功时 | 失败时 |
|---|---|---|---|
| 1 | `tools.find(name)` | 找到当前 Context 中的工具 | 立即创建 `Tool not found` 错误结果 |
| 2 | `prepareArguments?` | 兼容旧参数格式 | throw 被归一化为错误结果 |
| 3 | `validateToolArguments` | clone、规范化并返回参数 | 产生带 schema 路径的错误结果 |
| 4 | `beforeToolCall?` | 允许继续 | 可返回 `block` 和原因 |
| 5 | `execute` | 返回 `AgentToolResult` | throw 被捕获并转成错误 result |
| 6 | `afterToolCall?` | 可覆盖最终 envelope | hook 自己 throw 也转成错误 result |
| 7 | `createToolResultMessage` | 写入标准结果消息 | 错误同样进入 transcript，`isError=true` |

无论在哪一层失败，目标都不是“让 Loop 崩掉”，而是把一个可解释的 ToolResult 放回上下文，让模型能在下一 Turn 修正调用。

## 参数准备、校验和权限不是一回事

### `prepareArguments` 在校验之前

它是 compatibility shim。例如旧模型可能把 `{ path: null }` 发给一个允许缺省 path 的工具，shim 可以先转换格式，再交给 schema。它不应该承担授权逻辑，因为此时参数仍未经过本地校验。

### 本地 validation 会产出执行参数

`validateToolArguments()` 不只是返回 true/false。它使用 TypeBox Value APIs clone 参数、处理 null 与 schema 约束，并返回交给工具的值。provider 端 `constrainedSampling: { type: "json_schema" }` 可以降低无效输出概率，但请求跨过 provider 后仍是不可信输入，不能替代本地 validation。

### `beforeToolCall` 在校验之后

hook 收到 `args: validatedArgs`，适合做权限、确认或策略阻止。当前固定源码允许 hook **原地修改** args，而且修改后不会再次校验。这个能力适合受控重写，也意味着 hook 作者必须自己维护 schema 不变量。

<div class="chapter-rule">
  <strong>Schema 合法不等于操作被授权</strong>
  <span><code>write_file({ path: ".env" })</code> 可以完全符合 schema，但仍应被应用层 policy 阻止。结构校验与业务权限必须是两道独立边界。</span>
</div>

源码锚点：[`agent-loop.ts` · `prepareToolCallArguments`, `prepareToolCall`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L586-L668)；[`validation.ts` · `validateToolArguments`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/utils/validation.ts#L317-L366)

## Result envelope 要把两类读者分开

`AgentToolResult<TDetails>` 的字段不是同一种用途：

| 字段 | 主要读者 | 作用 |
|---|---|---|
| `content` | 模型 | text/image，进入最终 ToolResultMessage 和后续 LLM 上下文 |
| `details` | 应用 UI / 日志 | 任意结构化细节；是否进入 provider payload 由 adapter 决定 |
| `usage` | runtime / 观测 | 工具自己的 usage，不计入主 LLM context accounting |
| `addedToolNames` | runtime / provider | 标记从 transcript 哪一点开始出现动态工具 |
| `terminate` | Loop 控制流 | 只参与当前工具批次是否自动续轮；不会写入 ToolResultMessage |

一个 `read_file` 工具可以把必要文本放进 `content`，把编码、截断信息、原始字节数放进 `details`。把整个内部对象都塞给模型既浪费 token，也泄漏不需要的实现信息。

`onUpdate` 更不是模型消息。它发出 `tool_execution_update` 事件供 UI 展示进度；只有 execute promise settle 后的最终 result 才进入 transcript。promise settle 后迟到的 update 会被忽略。

源码锚点：[`agent-loop.ts` · `executePreparedToolCall`, `createToolResultMessage`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L670-L795)

## 四类失败，一种回路

<div class="misconception-list">
  <div><strong>未知工具</strong><p>按 name 精确查找失败，不执行 hook 或副作用，直接产生 <code>Tool ... not found</code>。</p></div>
  <div><strong>参数无效</strong><p>validation 异常在 preflight 中被捕获，工具和 before hook 都不会运行。</p></div>
  <div><strong>策略阻止</strong><p><code>beforeToolCall</code> 返回 block；结构合法的请求也可以被安全拒绝。</p></div>
  <div><strong>执行异常</strong><p><code>execute</code> 应通过 throw 表达失败；runtime 将其转成 <code>isError=true</code> 的标准结果，after hook 仍可观察和覆盖。</p></div>
</div>

普通 `return` 永远不会因为 `content` 看起来像错误而自动设为 error。工具实现必须遵守契约：失败就 throw；成功才 return。

还有一个安全分支：AssistantMessage 若因 `stopReason="length"` 被截断，其中所有 tool calls 都不执行。流式参数可能被“尽力解析”为合法 JSON，却在语义上缺字段；Pi 会为每条调用生成错误结果，让模型重新发完整参数。

## 调度约束属于工具契约

第一章已经讲过事件顺序；这里关注设计含义：

- 默认批次并行，但任一目标工具声明 `executionMode: "sequential"`，整个 assistant 批次都会串行。
- parallel 不是“所有步骤并发”：lookup、validation 和 before hook 先按源顺序 preflight，允许的 execute 才并发。
- `tool_execution_end` 可按完成顺序发出，最终 ToolResultMessage 仍按 assistant 源顺序写入。
- abort 通过 `AbortSignal` 协作传播。Runtime 不能强杀一个忽略 signal 的 promise。
- `terminate` 只有在整批最终结果全部为 true 时生效，而且只关闭工具驱动的自动续轮。

因此，共享一个事务、终端或可变文件状态的工具应认真考虑 sequential；网络查询、互不依赖的只读工具才适合 parallel。

## Core、Provider 与应用层不要越界

### Provider adapter

统一 `Tool` 会被 OpenAI adapter 转为 function tool，也会被 Anthropic adapter 转为 `input_schema`；ToolResultMessage 同样由各 adapter 变成各自消息格式。应用代码应依赖 Pi 的统一契约，而不是把某一家 wire JSON 当成 Core API。

### Coding Agent wrapper

`ToolDefinition` 是应用层 superset，包含扩展 context 和渲染相关能力。`wrapToolDefinition()` 只完成结构和 execute 签名适配；Core 的 schema 校验、批次调度、错误归一化和标准事件仍只实现一次。

### 本书中的 Tool、CLI、MCP 与 Skill

下面是本书用于工程设计的职责划分，**不是 Pi Core 四个公开类型**：

| 名称 | 职责 | 与 AgentTool 的关系 |
|---|---|---|
| Tool | 模型可选择的能力契约 | 直接实现或适配为 `AgentTool` |
| CLI | 给人或进程调用的命令接口 | 可以成为 Tool 的底层实现，但 stdout/exit code 需转成 result envelope |
| MCP | 工具发现与远程调用协议 | adapter 可把远程声明映射成 AgentTool；本章固定 Core 源码不定义该协议 |
| Skill | 指令、流程和资源包 | 能指导何时使用工具，但不是 execute 契约，也不替代权限层 |

## 工程设计检查表

以下是基于源码边界推导的应用设计建议，不是 Pi 自动提供的保证：

- **粒度**：一个工具表达一个清晰动作；不要用一个 `admin(action, payload)` 混合读、写、删。
- **最小输入**：schema 只暴露完成动作需要的字段，枚举优于自由文本协议。
- **权限**：高风险副作用在应用层 `beforeToolCall` 或工具内部再次确认；不信任 description。
- **幂等**：支付、发信、创建资源等工具接受并持久化 idempotency key，重试不会重复副作用。
- **取消与超时**：工具主动监听 `AbortSignal`，并为外部 I/O 设置自己的 timeout；只传 signal 不等于能及时取消。
- **结果预算**：`content` 保持模型完成下一步所需的最小信息，完整结构进 `details` 或外部存储。
- **并发安全**：有共享可变状态就声明 sequential，或在工具内部实现锁/事务。
- **可观测性**：用 update event 表示进度，用最终 result 表示事实，不把临时状态写进 transcript。

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

本章没有展开 Context compaction、Session 重放或产品级 evaluation；它们分别属于第三、四、五章。

<section class="chapter-summary">
  <h2>本章收束</h2>
  <p>现在可以从 Tool contract 一直追到 provider wire format，并区分 schema validation、permission policy、执行异常、并发顺序与最终 ToolResultMessage。</p>
</section>
