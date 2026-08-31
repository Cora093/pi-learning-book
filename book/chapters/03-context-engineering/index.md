---
title: "03 Context Engineering"
chapter: "03"
sourceStatus: verified
contentStatus: complete
pageClass: chapter-detail-page
---

# 03 Context Engineering

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">模型每次请求能看到的内容有限，所以不能把所有历史都塞进去。Context Engineering 要在请求前决定：哪些规则、消息和工具现在必须带上，哪些内容应该摘要、按需读取或留在外部。Session 保存发生过的事，Context 只负责这一轮要给模型看的内容。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CORE SYMBOL</span><strong>streamAssistantResponse()</strong></div>
</div>

读完本章，你应该能回答三个问题：

1. 为什么 Session 里明明有一条记录，模型下一轮却不一定能看到？
2. 长历史、巨大工具结果、项目规则和 Skill 应分别从哪里进入请求？
3. Context 快满时，怎样压缩而不把“摘要”误当成无损记忆？

## 下一次请求，该带什么

假设一个 Session 已经持续很久。早期对话占 28k token，最近几个 Turn 占 16k，工具 schema 占 6k，项目规则和 Skill 索引又占 7k。现在，用户只问一个与最近代码有关的问题。

应用不必在“全部发送”和“全部删除”之间二选一。它可以：

- 裁掉无关旧历史，只保留近期原文；
- 把早期历史压成摘要，同时保留最近 Turns；
- 只把 Skill 索引放进 system prompt，相关时再读取完整正文；
- 在请求前注入本轮相关的检索片段。

下面的交互把“全量、裁剪、压缩、按需读取”放进同一个预算中比较。策略会变，但模型请求始终由三个部分组成。

<ContextComposer />

交互中的 token 数值只用来比较策略，不是固定源码的实测数据。可以确认的源码事实是组装顺序、字段边界和 compaction 规则。

## 模型实际看到三个部分

无论应用内部保存了多少状态，`streamAssistantResponse()` 最终只把三部分交给模型：system prompt、messages 和 tools。

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

所以，讨论“Agent 知道什么”时，要分别检查三个位置：

| 请求槽 | 需要追问什么 |
|---|---|
| `systemPrompt` | 角色、规则、项目说明和 Skill 索引怎样组成？ |
| `messages` | 完整历史经过哪些选择、注入、转换和过滤？ |
| `tools` | 这一轮真正向模型公开哪些 schema？ |

`transformContext(messages)` 只处理 messages，不会顺便修改 `systemPrompt` 或 `tools`。如果下一 Turn 要换 prompt 或工具集合，应用必须在刷新边界返回新的 context snapshot。

图源位于 `diagrams/03-context-engineering/request-assembly.mmd`。

源码锚点：[`agent-loop.ts` · `streamAssistantResponse`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L279-L312)

## 历史和 Context 不是一回事

一条信息可以先后出现在 Session、应用消息和 provider 消息中。它们看起来都像“消息”，用途和生命周期却不同：

| 层次 | 它保存什么 | 为谁服务 |
|---|---|---|
| Session entries | 完整消息、模型变化、compaction、branch summary 等持久记录 | 恢复、分支与审计 |
| `AgentMessage[]` | 当前 Runtime 能理解的应用消息 | hook、扩展和协议转换 |
| provider `Message[]` | 本次模型 API 能接收的标准消息 | 单次推理请求 |

为了将来恢复而保存，不代表每轮都要发给模型。反过来，这一轮不发送某条记录，也不代表要从 Session 中删除它。

<div class="chapter-rule">
  <strong>可恢复事实与模型输入使用不同保留策略</strong>
  <span>Session 应保留证据链；Context 只保留本轮完成任务所需的信息。把两者混成一个数组，要么 token 失控，要么审计断裂。</span>
</div>

## 先选消息，再转协议

### 先在应用消息里取舍

每次请求模型前，可选的 `transformContext()` 都会先执行。它可以裁剪旧消息，也可以从外部来源注入本轮需要的信息。Coding Agent 把它连接到 extension runner 的 `emitContext(messages)`。

这只说明“这里可以接入检索”，不代表 Pi Core 自带 RAG。索引、embedding、权限、来源标注、去重、冲突处理和失败降级仍要由应用或扩展实现。

### 再转成模型协议

`convertToLlm()` 负责把结果转成 provider 能接收的格式。`AgentMessage` 可以包含应用自定义角色，但 provider 只接受 `user | assistant | toolResult`。Coding Agent 的 converter 会：

- 透传普通 user、assistant 和 toolResult；
- 把 `custom`、`branchSummary`、`compactionSummary` 转成 user message；
- 把 bashExecution 格式化成文本；
- 过滤 `excludeFromContext=true` 的 bashExecution；
- 在 `blockImages` 开启时用文本占位替换图片。

顺序不能反过来。应用必须先利用 AgentMessage 中更丰富的类型和元数据决定保留什么，再映射成标准消息。提前转换会丢失信息，后面就无法精确筛选。

源码锚点：[`packages/agent/src/types.ts` · `transformContext`, `convertToLlm`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L149-L200)；[`coding-agent/core/messages.ts` · `convertToLlm`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/messages.ts#L140-L195)

## 信息什么时候进入请求

本书把进入时机分成 Static、Dynamic 和 Lazy。这三个词用于设计，不是 `packages/agent` 导出的类型：

| 方式 | 何时进入 | 固定源码中的例子 | 主要代价 |
|---|---|---|---|
| Static | 构建 system prompt 时 | base prompt、guidelines、cwd、project context files | 每轮重复占 token，内容可能过期 |
| Dynamic | 每次请求或 Turn 边界 | context transform、steering、`prepareNextTurn` snapshot | 增加延迟，需要冲突和降级策略 |
| Lazy | 模型判断相关后再读取 | 先列 Skill 索引，再调用 read | 首轮只知道索引，依赖发现质量 |

判断方法很直接：小而稳定、每轮都必须遵守的规则适合 Static；只与当前任务相关的信息适合 Dynamic；体积大、偶尔才用到的资料适合 Lazy。

## System Prompt 怎样拼出来

Coding Agent 每次按当前状态调用 `buildSystemPrompt()`。它按下面的顺序拼接内容：

```text
custom/default base prompt
  + selected tool snippets
  + tool-specific guidelines
  + appendSystemPrompt
  + <project_context> context files
  + <available_skills> Skill index
  + current working directory
```

其中有两个需要区分的边界：

1. `contextFiles` 的完整内容被包在 `<project_instructions path="...">` 中，属于 eager/static 注入。
2. Skill 默认只放 name、description、location；完整 `SKILL.md` 需要按需读取。只有存在 `read` 工具时才加入索引，`disableModelInvocation=true` 的 Skill 不进入索引。

`AgentSession._rebuildSystemPrompt()` 从 ResourceLoader 取得 prompt 片段、skills 和 agents files，再结合当前激活工具重建 prompt。动态工具集合变化后，下一 Turn 的刷新可以同时更新 system prompt 和 context tools。

源码锚点：[`system-prompt.ts` · `buildSystemPrompt`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/system-prompt.ts#L8-L168)；[`skills.ts` · `formatSkillsForPrompt`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/skills.ts#L347-L380)

## 刷新只影响下一轮

`prepareNextTurn` 要等本 Turn 的 assistant message、tool results 和 `turn_end` 都完成后才运行。它可以换 context、model 或 thinking level，但这些变化只影响下一次 provider request。

```text
当前 Turn 完成
  → assistant / toolResults 已写入
  → turn_end
  → prepareNextTurn()
  → 下一次模型请求使用新 snapshot
```

这是一个稳定的刷新点。已经执行的工具和已经发出的事件不会被它回头改写。

## 大结果先留在外部

假设查询返回 12,430 行。模型通常只需要摘要、保存位置和继续读取的方法，不需要在后续每个 Turn 都携带全部原文。

第二章把 `AgentToolResult` 分成 `content` 与 `details`。放到 Context 中看：

- `content` 会进入 ToolResultMessage，并由 provider adapter 变成模型可见结果；
- `details` 留在应用 transcript/session，供 UI、恢复和日志使用；
- 巨大原始输出可以落到文件或对象存储，`content` 只给摘要、位置和继续读取方式；
- `onUpdate` 是 UI 事件，不是历史消息，不会积累进下一轮 Context。

这样既保留完整结果，也不会让一条工具消息长期占满 Context。

## 什么时候触发压缩

当 Context 接近窗口上限时，Coding Agent 会考虑 compaction。默认设置是：

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

Token 估算优先采用最近一次有效的 assistant usage。那条消息之后新增的内容，再用本地估算补齐。error、aborted 和全零 usage 不会作为可靠基线。

源码锚点：[`compaction.ts` · settings, `estimateContextTokens`, `shouldCompact`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/compaction/compaction.ts#L126-L238)

### 压缩后保留什么

`findCutPoint()` 从最新消息向前累计，目标是保留约 `keepRecentTokens` 的近期原文。`prepareCompaction()` 还会记录：

- 哪些消息由摘要替代；
- `firstKeptEntryId`，也就是近期原文从哪里开始保留；
- 多次压缩时使用的 `previousSummary`；
- 被摘要历史里的文件操作；
- 超大 Turn 必须拆开时的 `turnPrefixMessages`。

```text
Session：旧原文 ─────────────── 近期原文 ── head
Context：<summary> ─────────── firstKeptEntryId ── head
```

生成的 `compactionSummary` 会在 `convertToLlm()` 中变成带 `<summary>` 的 user message，再和保留的近期原文一起进入请求。旧 entry 仍在 Session 中。模型看到的是摘要投影，不是无损原文。

图源位于 `diagrams/03-context-engineering/compaction-boundary.mmd`。

源码锚点：[`compaction.ts` · `prepareCompaction`, `compact`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/compaction/compaction.ts#L718-L949)

## 摘要怎样避免失真

自然语言摘要一定可能漏掉约束、数字或失败原因。应用不能把摘要当成唯一事实来源，至少要做到：

- 保留目标、关键决定、未完成工作、错误和文件操作；
- 不可丢失的事实放进结构化状态或外部存储；
- 使用 `firstKeptEntryId` 和 Session entries 保留来源链；
- branch summary 明确标注来自离开的分支；
- 压缩失败时给出可见错误和降级，不静默删除历史。

## RAG 和 Memory 放在哪里

| 接入方式 | 谁决定读取 | 适合什么 | 主要代价 |
|---|---|---|---|
| transform 注入 | 应用 | 每轮必需、规则可确定的信息 | 每次增加延迟，错误检索会污染请求 |
| retrieval Tool | 模型 | 是否检索取决于任务语义 | 多一个 Turn，需要结果预算 |
| system/static | 启动时 | 小而稳定的规则 | 过期和重复 token |
| external state | 应用代码 | 精确、结构化、可审计的事实 | 需要显式读写和一致性设计 |

选择接入点的关键，是谁决定读取信息。Pi Core 提供消息变换和 Tool 机制，但本章检查的路径没有定义通用向量库、embedding pipeline、事实冲突策略或长期用户 memory。能接入，不等于已经内建。

## Context 设计清单

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

本章只讨论模型每次请求看到什么。Session 文件格式、resume、事件持久化和 Harness 生命周期留到第四章。

<section class="chapter-summary">
  <h2>本章收束</h2>
  <p>Session 保存发生过的事，Context 只选择这一轮要给模型看的内容。一次请求由 system prompt、messages 和 tools 组成；消息要先在应用层取舍，再转成 provider 协议。历史过长时可以压缩，但摘要必须保留回溯原始记录的路径。</p>
</section>
