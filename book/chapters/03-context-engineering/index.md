---
title: "03 Context Engineering"
chapter: "03"
sourceStatus: verified
contentStatus: complete
pageClass: chapter-detail-page
---

# 03 Context Engineering

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">Context Engineering 不是把所有已知信息塞进 prompt，而是在每次模型请求前做一次有损投影：从完整 Session 和当前运行状态中，选择模型此刻必须看到的 system prompt、messages 与 tool schemas，并明确哪些信息被保留、转换、摘要、延后或过滤。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CORE SYMBOL</span><strong>streamAssistantResponse()</strong></div>
</div>

学完本章，你应该能做到：

1. 区分持久 Session entries、运行时 `AgentMessage[]` 和真正发送给 provider 的 `Message[]`。
2. 解释 `transformContext → convertToLlm → { systemPrompt, messages, tools }` 的顺序与职责。
3. 为长历史、巨大工具结果、项目规则、Skill 和外部检索设计有预算、有来源、有降级策略的 Context。

## 真正的请求只有三部分

低层 `streamAssistantResponse()` 每次都现场组装：

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

所以“Agent 知道什么”必须拆成三个问题：

- `systemPrompt`：当前角色、规则、项目说明、Skill 索引怎样组成？
- `messages`：完整历史经过哪些裁剪、注入、类型转换和过滤？
- `tools`：这一轮真正向模型公开哪些 schema？

可维护的数据流图位于 `diagrams/03-context-engineering/request-assembly.mmd`。

源码锚点：[`agent-loop.ts` · `streamAssistantResponse`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent-loop.ts#L279-L312)

<ContextComposer />

交互组件里的 token 数值只用于比较策略，不是固定源码对这组示例数据的实测；源码事实是组装顺序、字段边界和 compaction 规则。

## Transcript 不等于 Context

这三个层次看起来都像“消息数组”，但生命周期不同：

<div class="concept-pair">
  <div>
    <span class="concept-number">SESSION / 可恢复事实</span>
    <h3>完整历史与分支</h3>
    <p>Session entries 保存消息、模型变化、compaction、branch summary 等持久记录。它服务恢复和审计，不保证每条 entry 都原样进入下一次模型请求。</p>
  </div>
  <div>
    <span class="concept-number">REQUEST / 本轮投影</span>
    <h3>模型此刻看到的输入</h3>
    <p><code>AgentMessage[]</code> 经 transform 与 convert 后成为 provider-compatible <code>Message[]</code>，再与独立的 systemPrompt、tools 组成一次请求。</p>
  </div>
</div>

把两者混在一起会产生两个相反错误：为了可恢复而把所有数据发给模型，导致 token 爆炸；为了省 token 直接删除持久记录，导致无法审计和重建。

## 两道转换，各管一层

### `transformContext`: 在 AgentMessage 层做选择

这个可选异步 hook 在每次 LLM call 前执行。类型契约明确把“裁剪旧消息”和“从外部源注入 context”列为用途。Coding Agent 把它接到 extension runner 的 `emitContext(messages)`，因此扩展可以在请求前改变消息投影。

这不等于 Pi Core 内置 RAG。Core 提供的是一个注入边界；检索器、索引、权限、去重、来源标注和失败降级仍由应用或扩展实现。

### `convertToLlm`: 把应用消息投影成模型协议

`AgentMessage` 可以有应用自定义 role，但 provider 只接受 `user | assistant | toolResult`。Coding Agent 的 converter 会：

- 把普通 user/assistant/toolResult 透传；
- 把 `custom`、`branchSummary`、`compactionSummary` 转成 user message；
- 把 bashExecution 格式化成文本；
- 过滤 `excludeFromContext=true` 的 bashExecution；
- 在 `blockImages` 开启时把图片替换成文本占位。

两道转换的顺序不可交换：先在丰富的 AgentMessage 层选择，再转换成 provider 能理解的标准 Message。

源码锚点：[`packages/agent/src/types.ts` · `transformContext`, `convertToLlm`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L149-L200)；[`coding-agent/core/messages.ts` · `convertToLlm`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/messages.ts#L140-L195)

## Static、Dynamic、Lazy 是设计词，不是三个 Core 类型

本书用这三个词描述信息进入请求的时机：

| 类别 | 进入时机 | 固定源码中的例子 | 主要风险 |
|---|---|---|---|
| Static | 构建 system prompt 时 | base prompt、guidelines、cwd、project context files | 每轮重复占 token，内容可能过期 |
| Dynamic | 每次请求或 Turn 边界 | extension context transform、steering、`prepareNextTurn` snapshot | 来源冲突、延迟、失败降级 |
| Lazy | 模型判断相关后再读 | System Prompt 先列 Skill name/description/location，再调用 read | 首轮不知道正文，依赖发现信息质量 |

这些分类帮助设计，不应伪装成 `packages/agent` 导出的类型。

## System Prompt 不是一段常量

Coding Agent 的 `buildSystemPrompt()` 根据当前状态重建字符串：

```text
custom/default base prompt
  + selected tool snippets
  + tool-specific guidelines
  + appendSystemPrompt
  + <project_context> context files
  + <available_skills> Skill index
  + current working directory
```

两条细节很容易漏掉：

1. `contextFiles` 的完整内容被包在 `<project_instructions path="...">` 中，属于 eager/static 注入。
2. Skill 默认只在有 `read` 工具时加入索引，而且索引只有 name、description、location；完整 `SKILL.md` 要按需读取。`disableModelInvocation=true` 的 Skill 不进入索引。

`AgentSession._rebuildSystemPrompt()` 从 ResourceLoader 取得 system prompt、append prompts、skills 与 agents files，再结合当前激活工具生成 prompt。动态工具集合改变时，下一 Turn refresh 可以重建 system prompt 和 context tools。

源码锚点：[`system-prompt.ts` · `buildSystemPrompt`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/system-prompt.ts#L8-L168)；[`skills.ts` · `formatSkillsForPrompt`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/skills.ts#L347-L380)

## `prepareNextTurn` 改的是下一轮，不是当前轮

第一章中，Turn 的 assistant message 和 tool results 写入后才调用 `prepareNextTurn`。它可以返回新的 context、model 或 thinking level，影响同一 Run 的下一次 provider request。

这给 Context Engineering 一个稳定刷新点：工具可能激活新能力、设置可能改变、应用也可能决定在下一轮换一份 system prompt。它不会回头改变已经完成的工具执行和 `turn_end` 事件。

## Tool Result 要同时服务模型和应用

第二章把 `AgentToolResult` 分成 `content` 与 `details`。在 Context 视角中，区别更具体：

- `content` 会进入 ToolResultMessage，并由 provider adapter 转成模型可见 tool result。
- `details` 保存在应用 transcript/session，供 UI、恢复和日志使用；内置 provider serializer 不把任意 details 当作模型内容发送。
- 巨大原始输出可以落文件或对象存储，把摘要、路径、行数和下一步读取方式放进 content。
- `onUpdate` 是 UI event，不是历史消息，更不会累积进下一轮 Context。

<div class="chapter-rule">
  <strong>先决定下一步需要什么，再决定 content 放什么</strong>
  <span>模型若只需知道“查询返回 12,430 行，已保存到 X，可用 offset 继续读”，就不要把 50k 原文塞进每个后续 Turn。</span>
</div>

## Compaction 是有损重写，不是魔法记忆

默认设置来自 `DEFAULT_COMPACTION_SETTINGS`：

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

Token 估算优先使用最近一次有效 assistant usage；它之后的新消息再用本地估算补上。error、aborted 和全零 usage 不作为可靠基线。

源码锚点：[`compaction.ts` · settings, `estimateContextTokens`, `shouldCompact`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/compaction/compaction.ts#L126-L238)

### 切点与保留后缀

`findCutPoint()` 从最新消息向后累计，目标是保留约 `keepRecentTokens`。`prepareCompaction()` 记录：

- `messagesToSummarize`：切点以前将由摘要替代的消息；
- `firstKeptEntryId`：保留后缀的第一条 entry；
- `previousSummary`：多次压缩时用于迭代更新；
- `fileOps`：从被摘要历史中提取读过和修改过的文件；
- `turnPrefixMessages`：如果超大 Turn 必须被拆开，单独总结其前缀。

生成的 `compactionSummary` 在 `convertToLlm()` 中变成带 `<summary>` 的 user message，再与 `firstKeptEntryId` 之后的原文一起形成 Context。Session log 仍保留历史 entry；模型看到的是摘要投影。

图源位于 `diagrams/03-context-engineering/compaction-boundary.mmd`。

源码锚点：[`compaction.ts` · `prepareCompaction`, `compact`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/compaction/compaction.ts#L718-L949)

## 摘要会丢信息，所以要保留证据链

摘要模型可能省略约束、数字或失败原因。安全设计需要：

- 摘要内保留目标、关键决定、未完成工作、错误、文件操作和下一步；
- 对不可丢失的业务事实使用结构化状态或外部存储，不只依赖自然语言 summary；
- 用 `firstKeptEntryId` 和 Session entries 保留回溯路径；
- branch summary 明确标注来自离开的分支，避免把它误当当前分支原始对话；
- 压缩失败时有可见错误和降级，不静默丢弃历史。

## RAG 与 Memory 应该放在哪里

在固定源码里，低层 `transformContext` 明确允许“从外部源注入 context”，Coding Agent extensions 也有 context hook；这就是接入检索的合理位置之一。另一种方式是把检索暴露为 Tool，让模型先搜索、再让 ToolResult 进入下一 Turn。

选择取决于控制权：

| 方式 | 谁决定检索 | 适合 | 代价 |
|---|---|---|---|
| transform 注入 | 应用 | 每轮必需、可确定规则 | 每次延迟，错误检索会污染请求 |
| retrieval Tool | 模型 | 是否检索取决于任务 | 多一个 Turn，需要好 schema 与结果预算 |
| system/static | 启动时 | 小而稳定的规则 | 过期与重复 token |
| external state | 应用代码 | 必须精确、结构化、可审计的事实 | 需要显式读写与一致性设计 |

Pi Core 提供消息变换和 Tool 机制，但本章检查的路径没有替你定义通用向量库、embedding pipeline、事实冲突策略或长期用户 memory。把这些说成“Pi 自带”会越过证据边界。

## Context 设计检查表

- 每段信息都记录来源、更新时间和进入请求的理由。
- 项目规则与用户输入冲突时，靠明确优先级处理，不靠拼接顺序碰运气。
- Tool schemas 也是 token 成本；只暴露当前可用能力。
- 大结果先落外部存储，content 给模型最小可行动摘要。
- UI 状态、进度事件和调试详情默认不进入 LLM Context。
- Compaction 前后都能从 Session 定位摘要来源和保留边界。
- 检索失败、超时或空结果有清晰降级，不注入伪造内容。
- 用实际 provider usage 校准预算，估算只用于缺少 usage 的尾部。

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
  <p>现在可以区分 Session transcript、AgentMessage 与 provider Message，定位 system prompt、Tool Result、Skill、RAG 和 compaction 在一次请求中的进入位置。</p>
</section>
