---
title: "04 Agent Runtime"
chapter: "04"
sourceStatus: verified
contentStatus: complete
pageClass: chapter-detail-page
---

# 04 Agent Runtime

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">Agent Runtime 不是把 Loop 包进一个更大的 class。它要给执行过程加上清晰的状态所有权、持久记录、恢复路径、扩展控制面、宿主能力和结算语义，让“模型做了一次回答”变成“应用能够可靠地继续工作”。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CURRENT RUNTIME</span><strong>Agent + AgentSession</strong></div>
</div>

学完本章，你应该能做到：

1. 区分 Run 内存状态、Session 持久记录和 Application 业务状态。
2. 解释 `agent_end`、`waitForIdle()` 与 `agent_settled` 为什么不是同一个时刻。
3. 准确比较 resume、branch、fork，并说清 Harness v2 已实现和仍是 scaffold 的部分。

## Runtime 首先是所有权问题

第一章中的 Loop 解决“下一步执行什么”；Runtime 还要回答：

- 谁拥有当前正在变化的状态？
- 哪个事件意味着副作用已经落盘？
- 进程退出后，从哪里恢复？
- 切换 Session 或 cwd 时，哪些对象必须一起销毁和重建？
- UI、审批单和业务工作流由谁持久化？

固定源码中，至少有三份不能混在一起的状态：

| 状态平面 | 当前所有者 | 生命周期 | 典型内容 |
|---|---|---|---|
| Run 内存状态 | `Agent` | 一个 active Run | streaming message、pending tool ids、AbortSignal、队列 |
| Session 持久记录 | `SessionManager` | 多个 Run，跨进程 | message、model change、compaction、custom entry、分支树 |
| Application 业务状态 | 宿主应用 | 由产品定义 | 路由、任务、审批、权限、业务实体、跨会话协调 |

低层 `AgentState` 没有 JSONL 路径、项目资源或业务字段。反过来，Session entry 也不会自动理解“这个审批单已经通过”。边界模糊时，最常见的事故是把 UI 显示当成持久事实，或把对话历史当成业务数据库。

图源位于 `diagrams/04-agent-runtime/runtime-state-boundaries.mmd`。

源码锚点：[`types.ts` · `AgentState`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L333-L358)；[`session-manager.ts` · custom entries](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/session-manager.ts#L94-L153)

<RuntimeLedger />

交互组件描述的是固定源码中的所有权和转换关系；示例 id、审批状态与事件文本用于教学，不是上游运行日志。

## `agent_end` 不是整个应用已经稳定

Core `Agent` 同时只允许一个 active Run。调用 `prompt()` 后，运行态一直保留到：

```text
Loop 发出 agent_end
  -> Agent.processEvents 逐个 await subscriber
  -> finishRun 清理 activeRun
  -> prompt() / waitForIdle() resolve
```

所以 `agent_end` 的精确定义是“不会再发本 Run 的 loop event”，不是“所有订阅者都已经完成”。一个 async subscriber 可能仍在写 Session、发扩展事件或同步外部日志。Core 明确把这些 subscriber 纳入 settlement。

这也是为什么 `isStreaming` 在 awaited listeners 完成前仍保持 true。UI 若刚看到 `agent_end` 就销毁 Runtime，可能打断最后的持久化副作用。

源码锚点：[`agent.ts` · `subscribe`, `waitForIdle`, `finishRun`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L240-L253)

## AgentSession 把多个 Core Run 组织成一次用户操作

现行 Coding Agent 不是直接把 `Agent.prompt()` 暴露给产品层。`AgentSession` 在外面叠加：

- JSONL persistence 与 tree navigation；
- extensions、commands 和动态 tools；
- auto-retry 与 auto-compaction；
- bash、资源刷新和 UI 事件；
- session-level 的排队与结算。

一次 `_runAgentPrompt()` 在第一次 `agent.prompt()` 返回后，可能发现 retry、compaction 或新排队消息，然后继续调用 `agent.continue()`。因此一个用户操作可以跨多个 Core Run。只有这些后续动作都不再继续时，AgentSession 才发 `agent_settled`。

```text
user operation
  -> Core Run #1
  -> retry / compaction / queued input ?
       yes -> Core Run #2 ...
       no  -> agent_settled
```

产品层如果要开放 Session 切换、关闭窗口或执行下一项事务，`agent_settled` 比第一次 `agent_end` 更接近稳定点。

源码锚点：[`agent-session.ts` · `_runAgentPrompt`, `_handlePostAgentRun`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/agent-session.ts#L1074-L1115)

## 持久化发生在事件路径里

`AgentSession` 自己是 `Agent.subscribe()` 的 async listener。以 `message_end` 为例，它会：

1. 更新内部队列显示；
2. 等待 extension event；
3. 同步通知 AgentSession listeners；
4. 把最终 message append 到 `SessionManager`。

Core 会等待整个 handler，所以该消息的 Session append 属于 Run settlement。这里仍有一个细边界：AgentSession 暴露给 UI 的 listeners 是同步调用，不会继续 await UI 返回的 Promise。需要可靠完成的副作用不能只挂在一个被忽略的异步 UI 回调上。

## Session 是树，不是一条可覆盖的聊天数组

当前 Coding Agent `SessionManager` 使用 append-only JSONL。每个 entry 至少有：

```ts
interface SessionEntryBase {
  id: string
  parentId: string | null
  timestamp: string
}
```

`parentId` 把 entries 组成树，内存里的 leaf 指向当前路径终点。`branch(entryId)` 只把 leaf 移到旧节点；等下一次 append 时，才从该节点长出一个新 child。旧分支既不覆盖也不删除。

可维护的数据结构图位于 `diagrams/04-agent-runtime/session-tree.mmd`。

这解释了为什么“历史记录”和“模型下一次看到的 Context”不同：恢复时只沿当前 leaf 回溯 root，再应用最新 compaction summary 与保留后缀。树上的其他分支仍可审计，但不会自动进入请求。

源码锚点：[`session-manager.ts` · `_appendEntry`, `branch`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/session-manager.ts#L1044-L1067)；[`buildSessionContext`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/session-manager.ts#L334-L469)

## Resume、branch、fork 是三个操作

| 操作 | Session 文件 | leaf / 路径 | 用途 |
|---|---|---|---|
| `open()` / `continueRecent()` | 原文件 | 恢复原 leaf | 继续同一个 Session |
| `branch(entryId)` | 原文件 | 移到祖先，下一 append 生成 sibling branch | 在同一历史树探索另一条路 |
| `createBranchedSession()` | 新文件 | 复制选中的 root-to-leaf 路径 | 把一条分支独立成 Session |
| `forkFrom()` | 新文件，允许换 cwd | 复制源 Session 的非 header entries | 在新工作目录继续副本 |

它们都会“从过去继续”，但所有权与文件语义不同。应用如果在 Session 外还维护任务实体，必须定义 branch/fork 时业务状态是共享、复制、重算还是禁止；SessionManager 不会替产品做这个决定。

## Application state 必须显式保存

Coding Agent 支持 `CustomEntry` 和 `CustomMessageEntry`：

- `CustomEntry` 可把扩展自己的数据写进 JSONL，但不进入 LLM Context；
- `CustomMessageEntry` 会转换成自定义 AgentMessage，才可能进入 Context；
- reload 后，扩展需要扫描 entry 并自行归约状态。

这是一条扩展点，不是通用业务状态框架。对于审批、订单或任务编排，更稳妥的设计通常是让业务数据库成为 authority，只把关联 id、操作证据和必要快照写入 Session。

<div class="chapter-rule">
  <strong>对话可恢复，不等于业务可恢复</strong>
  <span>只有被明确持久化、能重新归约、且有 authority 的状态，才算 Runtime 重启后仍然成立。</span>
</div>

## Extension runner 是现行 Runtime 的控制面

Extension 不只是“多几个 Tool”。固定源码允许它在多个边界介入：

| 边界 | 能做什么 | 不能偷换成什么 |
|---|---|---|
| command preflight | 在进入模型前直接处理命令 | 普通 user prompt |
| `before_agent_start` | 注入 message、改 system prompt | 修改已经完成的 Run |
| `context` | 每次请求前转换 messages | Core 内建 RAG |
| `tool_call` | block 或放行调用 | Tool 已成功执行 |
| `tool_result` | 改 content/details/error/usage | 回滚真实外部副作用 |

Session 被替换或 reload 时，旧 extension context 会 invalidate。扩展保存引用、启动后台任务或暴露 host 方法时，都要把这个生命周期当真。

源码锚点：[`extensions/runner.ts` · hook emitters](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/extensions/runner.ts#L877-L1014)

## Resource 与 Session 一起绑定 cwd

`ResourceLoader` 汇集 extensions、skills、prompt templates、themes、AGENTS files 与 system prompt 片段。`createAgentSessionServices()` 为当前 cwd 建立 model runtime、settings 与 resource loader，再由这些 services 创建 AgentSession。

因此跨 cwd 的 resume/fork 不是“只换一个路径字符串”。`AgentSessionRuntime` 负责：

```text
abort / settle old session
  -> emit shutdown
  -> invalidate + dispose old resources
  -> rebuild cwd-bound services
  -> create/open target session
  -> rebind host
```

同一文件内的树导航仍属于 AgentSession；跨 Session、跨 cwd 的整体替换属于更外层 Runtime。

源码锚点：[`agent-session-runtime.ts` · `AgentSessionRuntime`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/agent-session-runtime.ts)；[`resource-loader.ts` · `ResourceLoader`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/resource-loader.ts#L30-L52)

## OS 能力来自宿主 adapter

Harness 定义的 `ExecutionEnv` 组合 FileSystem 与 Shell 接口；真正调用 Node 的 cwd/path、spawn、abort/timeout、流式回调和文件操作的是 `NodeExecutionEnv`。它从独立的 `./node` entrypoint 导出。

这个结构保留了一个重要事实：Runtime 的策略和事件协议不会凭空获得文件系统或进程权限。宿主选择 adapter，也就选择了能力、隔离与错误语义。浏览器能加载 Core 类型，不代表浏览器能执行 shell。

源码锚点：[`harness/env/nodejs.ts` · `NodeExecutionEnv`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/env/nodejs.ts#L347-L695)

## Harness v2：底座已实现，driver 仍是 scaffold

固定版本包含一份很完整的 `harness.md` implementation specification，也已经实现若干底层模块：

- Session v4 的 entries、records、facts、lanes 与 views；
- memory / JSONL storage 与 backend conformance；
- `validateRecordLog()`、`reduceLaneState()` 等纯 reducer；
- `ExecutionEnv`、`NodeExecutionEnv` 与部分 tools。

但高层 `AgentHarness` 不能据此被描述为已可运行：

- `create()` 只接受没有 record 的 Session，restore 分支拒绝；
- `prompt`、`resume`、`abort`、`queue`、`drive`、`watch`、lane orchestration 都调用 `unavailable()`；
- hooks/events registration 也不可用；
- 当前 Coding Agent SDK 仍创建现行 `Agent + AgentSession`。

这些路径会抛明确的 `HarnessNotImplemented`。准确说法是：“durable Session 基础件已经落地，高层 operation driver 仍是 scaffold”，而不是“整个 Harness 都没实现”，也不是“Harness v2 已接管产品运行时”。

源码锚点：[`agent-harness.ts` · `HarnessNotImplemented`, `AgentHarness`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/agent-harness.ts#L74-L82)；[`session/session.ts` · `Session`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/session/session.ts#L102-L220)

## 原子文件发布不等于 operation transaction

Session v4 的 JSONL storage 用 Promise tail 串行化 mutation：每一项先 append 一行，再更新内存 state；append 失败时不推进 state。fork 发布和 torn-tail repair 使用 sibling `.tmp` 加 rename，保护原文件。

但当前 `SessionStorage` 没有目标规格里的多写 `commit(Transaction)`。所以：

- 可以说单项 mutation 串行落盘；
- 可以说 fork/repair 用原子 rename 发布文件；
- 不能说一次 operation 的 entries、registers、usage 已经 all-or-none 提交；
- 更不能据此宣称 destructive Tool 已实现崩溃恢复。

源码锚点：[`jsonl/storage.ts` · `enqueue`, `appendMutation`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/session/jsonl/storage.ts#L258-L275)

## Runtime 设计检查表

- Run、Session、Application 三份状态分别有明确 owner 和 authority。
- `agent_end`、持久化完成、session settled 在日志和 UI 中使用不同名称。
- 销毁或切换 Runtime 前先 abort，再等待 settlement，再 dispose。
- resume 只重建可持久状态；进程内 Promise、listener 和 active tool 不假装复活。
- branch/fork 对外部业务实体有明确共享或复制策略。
- Extension hook 失败、超时和取消有可见边界，不静默吞掉。
- OS 能力通过 adapter 注入，权限与路径不藏在 Core 里。
- 规格、类型契约、已实现 primitive 和可运行 product path 分开陈述。

## 本章证据地图

<div class="evidence-grid">
  <article><code>AR-01 — AR-04</code><h3>Core 生命周期</h3><p>状态所有权、Run/Turn、单 active Run、settlement</p></article>
  <article><code>AR-05 / AR-06</code><h3>Session 结算</h3><p>跨 Run 用户操作与事件持久化顺序</p></article>
  <article><code>AR-07 — AR-10</code><h3>持久树</h3><p>JSONL tree、resume、branch/fork、业务状态</p></article>
  <article><code>AR-11 — AR-13</code><h3>产品 Runtime</h3><p>Extension、资源服务与跨 Session 替换</p></article>
  <article><code>AR-14</code><h3>宿主能力</h3><p>ExecutionEnv 与 Node adapter</p></article>
  <article><code>AR-15 / AR-16</code><h3>Harness 边界</h3><p>已实现底座、driver scaffold 与原子性边界</p></article>
  <article><code>SOURCE NOTES</code><h3>完整研究索引</h3><p><code>evidence/04-agent-runtime/source-notes.md</code></p></article>
</div>

本章聚焦固定源码已经提供的 Runtime primitives，不把尚未实现的 Logging、Permission、Recovery driver 或分布式能力写成现成功能。

<section class="chapter-summary">
  <h2>本章收束</h2>
  <p>现在可以区分 Run 内存状态、Session 持久记录与 Application 业务状态，并为事件、持久化和业务完成选择各自正确的完成信号。</p>
</section>
