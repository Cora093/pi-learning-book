---
title: "03 Context Engineering"
chapter: "03"
sourceStatus: verified
contentStatus: complete
pageClass: chapter-detail-page
---

# 03 Context Engineering

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">Context Engineering 不是“让模型记住一切”，而是每次请求前重新决定：这轮必须带哪些规则、历史和工具，哪些内容要摘要、延后、过滤或留在外部。Session 保存可恢复事实；Context 只是模型此刻看到的一份有损投影。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CORE SYMBOL</span><strong>streamAssistantResponse()</strong></div>
</div>

学完本章，你应该能回答三个具体问题：

1. 为什么 Session 里明明有一条记录，模型下一轮却不一定能看到？
2. 长历史、巨大工具结果、项目规则和 Skill 应分别从哪里进入请求？
3. Context 快满时，怎样压缩而不把“摘要”误当成无损记忆？

## 先组装下一次请求

假设一个 Session 已经持续很久：早期对话占 28k token，最近几个 Turn 占 16k，工具 schema 占 6k，项目规则和 Skill 索引又占 7k。现在用户只问一个与最近代码有关的问题。

可选方案不止“全部发送”或“全部删除”：

- 裁掉无关旧历史，只保留近期原文；
- 把早期历史压成摘要，同时保留最近 Turns；
- 只把 Skill 索引放进 system prompt，相关时再读取完整正文；
- 在请求前注入本轮相关的检索片段。

下面的交互把“全量 / 裁剪 / 压缩 / 按需读取”放进同一个请求预算；策略会变化，右侧的三个请求槽保持不变。

<ContextComposer />

交互中的 token 数值只用于比较策略，不是固定源码对示例数据的实测。源码事实是组装顺序、字段边界和 compaction 规则。

## 模型每次只收到三个槽

无论应用内部有多少状态，低层 `streamAssistantResponse()` 最终都现场组装：

```ts
let messages = context.messages
messages = await config.transformContext?.(messages, signal) ?? messages
const llmMessages = await config.convertToLlm(messages)

const llmContext = {
  systemPrompt: context.systemPrompt,
  messages: llmMessages,
  tools: context.tools,
}
```

因此，“Agent 知道什么”必须拆成三个问题：

| 请求槽 | 需要追问什么 |
|---|---|
| `systemPrompt` | 角色、规则、项目说明和 Skill 索引怎样组成？ |
| `messages` | 完整历史经过哪些选择、注入、转换和过滤？ |
| `tools` | 这一轮真正向模型公开哪些 schema？ |

`transformContext(messages)` 只改消息投影，不会顺手改写独立的 `systemPrompt` 或 `tools`。工具集合或 prompt 要在下一 Turn 改变，需要应用在相应刷新边界返回新的 context snapshot。

图源位于 `diagrams/03-context-engineering/request-assembly.mmd`。

源码锚点：[`agent-loop.ts` · `streamAssistantResponse`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L279-L312)

## Transcript 是账本，Context 是投影

这三个层次都可能表现成“消息”，但生命周期不同：

| 层次 | 它保存什么 | 为谁服务 |
|---|---|---|
| Session entries | 完整消息、模型变化、compaction、branch summary 等持久记录 | 恢复、分支与审计 |
| `AgentMessage[]` | 当前 Runtime 能理解的应用消息 | hook、扩展和协议转换 |
| provider `Message[]` | 本次模型 API 能接收的标准消息 | 单次推理请求 |

为了恢复而保存，不等于为了推理必须发送。反过来，为了节省 token 不把某条记录发给模型，也不等于应该从 Session 中删除它。

<div class="chapter-rule">
  <strong>可恢复事实与模型输入使用不同保留策略</strong>
  <span>Session 应保留证据链；Context 只保留本轮完成任务所需的信息。把两者混成一个数组，要么 token 失控，要么审计断裂。</span>
</div>

## 两道转换不能交换顺序

### 第一道：`transformContext()` 在应用消息层做选择

这个可选异步 hook 在每次 LLM call 前执行。它可以裁剪旧消息，也可以从外部源注入本轮信息。Coding Agent 把它连接到 extension runner 的 `emitContext(messages)`。

这一能力只说明“这里可以接检索”，不说明 Pi Core 自带 RAG。索引、embedding、权限、来源标注、去重、冲突处理和失败降级仍属于应用或扩展。

### 第二道：`convertToLlm()` 转成 provider 能理解的协议

`AgentMessage` 可以包含应用自定义角色，但 provider 只接受 `user | assistant | toolResult`。Coding Agent 的 converter 会：

- 透传普通 user、assistant 和 toolResult；
- 把 `custom`、`branchSummary`、`compactionSummary` 转成 user message；
- 把 bashExecution 格式化成文本；
- 过滤 `excludeFromContext=true` 的 bashExecution；
- 在 `blockImages` 开启时用文本占位替换图片。

必须先在信息更丰富的 AgentMessage 层决定保留什么，再映射成标准消息。若先转换，应用特有的类型和元数据可能已经丢失，后续就无法做精确选择。

源码锚点：[`packages/agent/src/types.ts` · `transformContext`, `convertToLlm`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L149-L200)；[`coding-agent/core/messages.ts` · `convertToLlm`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/messages.ts#L140-L195)

## 信息有三种进入时机

Static、Dynamic、Lazy 是本书的设计词，不是 `packages/agent` 导出的三个类型：

| 方式 | 何时进入 | 固定源码中的例子 | 主要代价 |
|---|---|---|---|
| Static | 构建 system prompt 时 | base prompt、guidelines、cwd、project context files | 每轮重复占 token，内容可能过期 |
| Dynamic | 每次请求或 Turn 边界 | context transform、steering、`prepareNextTurn` snapshot | 增加延迟，需要冲突和降级策略 |
| Lazy | 模型判断相关后再读取 | 先列 Skill 索引，再调用 read | 首轮只知道索引，依赖发现质量 |

一个实用判断是：小而稳定、每轮都必须遵守的规则适合 Static；本轮相关、可由应用确定的信息适合 Dynamic；体积大且不总相关的资料适合 Lazy。

## System Prompt 也是现场组装的

Coding Agent 的 `buildSystemPrompt()` 按当前状态重建字符串：

```text
custom/default base prompt
  + selected tool snippets
  + tool-specific guidelines
  + appendSystemPrompt
  + <project_context> context files
  + <available_skills> Skill index
  + current working directory
```

这里有两个容易误读的边界：

1. `contextFiles` 的完整内容被包在 `<project_instructions path="...">` 中，属于 eager/static 注入。
2. Skill 默认只放 name、description、location；完整 `SKILL.md` 需要按需读取。只有存在 `read` 工具时才加入索引，`disableModelInvocation=true` 的 Skill 不进入索引。

`AgentSession._rebuildSystemPrompt()` 从 ResourceLoader 取得 prompt 片段、skills 和 agents files，再结合当前激活工具重建。动态工具集合变化后，下一 Turn refresh 可以更新 system prompt 与 context tools。

源码锚点：[`system-prompt.ts` · `buildSystemPrompt`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/system-prompt.ts#L8-L168)；[`skills.ts` · `formatSkillsForPrompt`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/skills.ts#L347-L380)

## 下一轮刷新不能改写已经发生的事

`prepareNextTurn` 在本 Turn 的 assistant message、tool results 和 `turn_end` 都完成之后运行。它可以返回新的 context、model 或 thinking level，影响同一 Run 的下一次 provider request。

```text
当前 Turn 完成
  → assistant / toolResults 已写入
  → turn_end
  → prepareNextTurn()
  → 下一次模型请求使用新 snapshot
```

这是稳定的动态刷新点，但不会回头修改已经执行的工具或已经发出的事件。

## 巨大 Tool Result 不应直接淹没后续请求

第二章已经把 `AgentToolResult` 分成 `content` 与 `details`。放到 Context 里看：

- `content` 会进入 ToolResultMessage，并由 provider adapter 变成模型可见结果；
- `details` 留在应用 transcript/session，供 UI、恢复和日志使用；
- 巨大原始输出可以落到文件或对象存储，`content` 只给摘要、位置和继续读取方式；
- `onUpdate` 是 UI 事件，不是历史消息，不会积累进下一轮 Context。

例如查询返回 12,430 行时，模型也许只需要知道“结果已保存到 X，可按 offset 继续读取”，而不需要在之后每个 Turn 重复携带全部原文。

## Compaction 是一次有损改写

默认 compaction 设置是：

```ts
{
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
}
```

自动触发条件是：

```text
contextTokens > contextWindow - reserveTokens
```

Token 估算优先使用最近一次有效 assistant usage，它之后的新消息再用本地估算补齐；error、aborted 和全零 usage 不作为可靠基线。

源码锚点：[`compaction.ts` · settings, `estimateContextTokens`, `shouldCompact`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/compaction/compaction.ts#L126-L238)

### 压缩前后到底变了什么

`findCutPoint()` 从最新消息向后累计，目标是保留约 `keepRecentTokens`。`prepareCompaction()` 会记录：

- 哪些消息由摘要替代；
- `firstKeptEntryId`，也就是近期原文从哪里开始保留；
- 多次压缩时使用的 `previousSummary`；
- 被摘要历史里的文件操作；
- 超大 Turn 必须拆开时的 `turnPrefixMessages`。

```text
Session：旧原文 ─────────────── 近期原文 ── head
Context：<summary> ─────────── firstKeptEntryId ── head
```

生成的 `compactionSummary` 会在 `convertToLlm()` 中变成带 `<summary>` 的 user message，再与保留后缀一起进入请求。旧 entry 仍在 Session 中；模型看到的是摘要投影，而不是无损原文。

图源位于 `diagrams/03-context-engineering/compaction-boundary.mmd`。

源码锚点：[`compaction.ts` · `prepareCompaction`, `compact`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/compaction/compaction.ts#L718-L949)

## 摘要必须带着回溯路径

自然语言摘要可能漏掉约束、数字或失败原因。安全设计至少需要：

- 保留目标、关键决定、未完成工作、错误和文件操作；
- 不可丢失的事实放进结构化状态或外部存储；
- 使用 `firstKeptEntryId` 和 Session entries 保留来源链；
- branch summary 明确标注来自离开的分支；
- 压缩失败时给出可见错误和降级，不静默删除历史。

## RAG 与 Memory 放在哪里取决于谁控制检索

| 接入方式 | 谁决定读取 | 适合什么 | 主要代价 |
|---|---|---|---|
| transform 注入 | 应用 | 每轮必需、规则可确定的信息 | 每次增加延迟，错误检索会污染请求 |
| retrieval Tool | 模型 | 是否检索取决于任务语义 | 多一个 Turn，需要结果预算 |
| system/static | 启动时 | 小而稳定的规则 | 过期和重复 token |
| external state | 应用代码 | 精确、结构化、可审计的事实 | 需要显式读写和一致性设计 |

Pi Core 提供消息变换和 Tool 机制，但本章检查的路径没有定义通用向量库、embedding pipeline、事实冲突策略或长期用户 memory。可接入点不等于内建产品能力。

## 设计 Context 时逐项检查

- 每段信息都记录来源、更新时间和进入本轮请求的理由。
- 项目规则与用户输入冲突时使用明确优先级，不靠拼接顺序碰运气。
- Tool schemas 也消耗 token，只暴露当前可用能力。
- 大结果先落外部存储，`content` 给模型最小可行动摘要。
- UI 状态、进度事件和调试详情默认不进入 LLM Context。
- Compaction 前后都能从 Session 定位摘要来源和保留边界。
- 检索失败、超时或空结果有清晰降级，不注入伪造内容。
- 使用实际 provider usage 校准预算，本地估算只补缺失尾部。

## 本章证据地图

<div class="evidence-grid">
  <article><code>CE-01 — CE-04</code><h3>请求组装</h3><p>AgentContext、两道转换、next-turn snapshot</p></article>
  <article><code>CE-05 — CE-07</code><h3>System Prompt 与 Lazy Skill</h3><p>context files、tools、Skill index</p></article>
  <article><code>CE-08 / CE-09</code><h3>结果与扩展注入</h3><p>content/details、context hook</p></article>
  <article><code>CE-10 — CE-14</code><h3>Compaction</h3><p>触发、估算、切点、摘要、重建</p></article>
  <article><code>CE-15</code><h3>Branch Summary</h3><p>离开分支的上下文投影</p></article>
  <article><code>CE-16</code><h3>RAG / Memory 边界</h3><p>可接入点不等于内建产品能力</p></article>
  <article><code>SOURCE NOTES</code><h3>完整研究索引</h3><p><code>evidence/03-context-engineering/source-notes.md</code></p></article>
</div>

本章没有展开 Session 文件格式、resume、事件持久化和 Harness 生命周期；这些属于第四章 Agent Runtime。

<section class="chapter-summary">
  <h2>本章收束</h2>
  <p>现在再问“模型知道什么”，应该先定位信息在 Session、AgentMessage 还是本次 provider Context，再说明它通过静态、动态或按需路径进入，以及压缩后还能否回溯原始证据。</p>
</section>
