---
title: "02 Tool System"
chapter: "02"
sourceStatus: verified
contentStatus: complete
pageClass: chapter-detail-page
---

# 02 Tool System

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">模型不会真的“调用函数”。它只会生成一份带工具名和参数的请求。Tool System 的工作，是把这份不可信请求依次经过查找、参数兼容、结构校验、权限策略和执行器，最后把成功或失败都包装成模型能够继续处理的结果。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CORE SYMBOL</span><strong>AgentTool</strong></div>
</div>

学完本章，你应该能回答三个具体问题：

1. 为什么参数符合 schema，工具仍然可以拒绝执行？
2. 一次调用在哪些位置可能失败，失败后为什么 Agent Loop 通常还能继续？
3. 哪些结果应该给模型，哪些细节只应该留给 UI、日志或 Runtime？

## 先跟一次写文件

假设模型生成了下面的请求：

```text
write_file({ path: ".env", content: "API_KEY=..." })
```

从模型视角看，这已经是一条结构完整的调用；从 Runtime 视角看，它仍然只是外部输入。真正执行前至少还要回答：工具是否存在、参数是否符合本地 schema、路径是否被策略允许、执行是否成功，以及最终哪些内容应写回模型历史。

下面并列“正常写入”“参数错误”“权限阻止”和“执行异常”四个场景。它们最终都会产出 `ToolResultMessage`，区别只在于在哪一道边界被截住。

<ToolPipeline />

上面的场景来自 `prepareToolCall()` 到 `createToolResultMessage()` 的真实控制流；图源位于 `diagrams/02-tool-system/call-pipeline.mmd`。

## 模型只提请求，Runtime 才执行

同一个工具在不同层有不同形状：

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

它回答“模型怎样提出调用”，不包含真正的函数。`AgentTool extends Tool` 才增加 `execute()`、`prepareArguments?`、`AbortSignal`、`onUpdate?` 和 `executionMode?`。

```text
模型看到 Tool schema
  → 模型生成 ToolCall
  → Agent Runtime 校验并执行 AgentTool
  → Provider adapter 把 ToolResultMessage 翻译回线协议
```

因此，写在 `description` 里的“不要访问敏感文件”只是给模型的提示，不是权限控制；provider 的 JSON schema 约束也不能替代本地校验和应用策略。

可维护的分层图位于 `diagrams/02-tool-system/contract-layers.mmd`。

源码锚点：[`packages/ai/src/types.ts` · `Tool`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/types.ts#L514-L519)；[`packages/agent/src/types.ts` · `AgentTool`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L360-L408)

## 一次调用要过七道边界

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

这里最重要的不是“有七步”，而是失败不会轻易炸穿 Loop。Runtime 尽量把失败变成一条可解释的 `ToolResultMessage`，让模型在下一 Turn 看到错误并修正请求。

## 兼容、校验和授权各管一件事

这三层很容易被揉成一个“检查参数”，但职责完全不同：

### `prepareArguments`：先把旧格式变成新格式

例如旧模型把 `{ path: null }` 发给允许缺省 path 的工具，compatibility shim 可以先把它转成工具当前接受的形状。此时参数尚未经过本地校验，不适合做授权决定。

### `validateToolArguments`：证明结构可以执行

它不只返回 true/false，而是使用 TypeBox Value APIs clone、处理 null 与 schema 约束，并产出交给工具的本地参数。provider 端 constrained sampling 只能降低坏参数概率；跨过网络边界的请求仍必须重新校验。

### `beforeToolCall`：决定这次操作是否允许

hook 收到已经校验的参数，适合做权限、确认和策略阻止。固定源码允许 hook **原地修改** args，而且修改后不会再次校验；因此受控重写可以放在这里，但 hook 作者必须自己维持 schema 不变量。

<div class="chapter-rule">
  <strong>Schema 合法不等于操作被授权</strong>
  <span><code>write_file({ path: ".env" })</code> 可以完全符合结构要求，应用层 policy 仍应阻止它。结构校验与业务权限是两道独立边界。</span>
</div>

源码锚点：[`agent-loop.ts` · `prepareToolCallArguments`, `prepareToolCall`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L586-L668)；[`validation.ts` · `validateToolArguments`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/utils/validation.ts#L317-L366)

## 一份结果要服务三类读者

假设 `read_file` 读到一个 5 MB 文件。模型下一步也许只需要前 200 行和“结果已截断”的提示；UI 还想展示编码、总字节数和保存路径；Runtime 则需要知道是否终止自动续轮。把这些全部塞进一段文本，会同时浪费 token 和丢失结构。

`AgentToolResult<TDetails>` 因此把用途拆开：

| 字段 | 主要读者 | 是否直接进入模型历史 |
|---|---|---|
| `content` | 模型 | 是，成为 ToolResultMessage 的 text/image |
| `details` | 应用 UI / 日志 | 不由 Core 当作任意模型内容发送 |
| `usage` | Runtime / 观测 | 可随工具结果记录，但不计入主 LLM context accounting |
| `addedToolNames` | Runtime / provider | 标记动态工具从哪里开始出现 |
| `terminate` | Loop 控制流 | 不写进 ToolResultMessage，只影响批次续轮 |

`onUpdate` 又是第四类信息：它发出 `tool_execution_update` 给 UI 展示进度，但不进入 transcript。只有 execute promise settle 后的最终 result 才成为历史事实；promise settle 后迟到的 update 会被忽略。

源码锚点：[`agent-loop.ts` · `executePreparedToolCall`, `createToolResultMessage`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L670-L795)

## 四种失败最后走回同一条路

<div class="misconception-list">
  <div><strong>未知工具</strong><p>按 name 精确查找失败，不执行 hook 或副作用，直接生成错误结果。</p></div>
  <div><strong>参数无效</strong><p>在 preflight 中被 validation 截住，工具和 before hook 都不会运行。</p></div>
  <div><strong>策略阻止</strong><p>请求结构正确，但 <code>beforeToolCall</code> 根据权限或业务规则拒绝。</p></div>
  <div><strong>执行异常</strong><p><code>execute</code> throw 后由 Runtime 转成 <code>isError=true</code>，after hook 仍可观察或覆盖。</p></div>
</div>

普通 `return` 不会因为 `content` 写着“失败”就自动成为 error。工具实现必须遵守契约：失败时 throw，成功时 return。

还有一个特殊安全分支：如果 AssistantMessage 因 `stopReason="length"` 被截断，其中所有 tool calls 都不执行。流式参数可能碰巧能解析成 JSON，却在语义上缺字段；Pi 会为每条调用生成错误结果，让模型重发完整参数。

## 并发是副作用契约的一部分

假设一批调用同时包含“读取网页”和“修改同一个配置文件”。是否能并行，不只是性能开关，还决定副作用是否可预测。

- 默认工具批次并行，但任一目标工具声明 `executionMode: "sequential"`，整批都会串行。
- lookup、validation 和 before hook 仍按模型提出的顺序 preflight；只有获准的 execute 才并发。
- `tool_execution_end` 可以按真实完成顺序出现，最终 ToolResultMessage 仍按模型源顺序写入。
- abort 通过 `AbortSignal` 协作传播，Runtime 不能强杀一个忽略 signal 的 promise。
- `terminate` 只有在整批最终结果全部为 true 时生效，而且只关闭工具驱动的自动续轮。

因此，互不依赖的只读查询适合 parallel；共享事务、终端或可变文件状态的工具应选择 sequential，或在工具内部实现锁和事务。

## 不要把 Tool、CLI、MCP 和 Skill 混成一种东西

下面是本书用于工程设计的职责划分，**不是 Pi Core 导出的四个类型**：

| 名称 | 它解决什么问题 | 怎样接入 AgentTool |
|---|---|---|
| Tool | 让模型选择一个受控能力 | 直接实现或适配成 `AgentTool` |
| CLI | 让人或进程调用命令 | stdout、stderr、exit code 要转换成 result envelope |
| MCP | 发现和远程调用工具 | adapter 可把远程声明映射成 AgentTool；本章 Core 不定义 MCP |
| Skill | 提供指令、流程和资源 | 可以指导何时使用 Tool，但不提供 execute，也不替代权限层 |

同理，`ToolDefinition` 是 Coding Agent 的应用层 superset；`wrapToolDefinition()` 负责适配形状，底层 schema 校验、批次调度、错误归一化和标准事件仍只在 Core 实现一次。Provider adapter 再把统一 `Tool` 转成各家的 wire format，应用不应依赖某一家 API JSON。

## 设计一个工具时逐项检查

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

本章没有展开 Context compaction、Session 重放或产品级 evaluation；它们分别属于第三、四、五章。

<section class="chapter-summary">
  <h2>本章收束</h2>
  <p>现在再看一次 ToolCall，可以先问“请求在哪道边界”，再分别判断结构、授权、副作用、结果受众和续轮控制，而不是把所有责任都塞进一个函数。</p>
</section>
