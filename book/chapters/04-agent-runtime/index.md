---
title: "04 Agent Runtime"
chapter: "04"
sourceStatus: verified
contentStatus: complete
pageClass: chapter-detail-page
---

# 04 Agent Runtime

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">Agent Loop 只负责把下一步跑出来；Agent Runtime 还要保证这次运行能被持久化、恢复、切换和安全收尾。真正困难的不是再包一层 class，而是分清谁拥有运行中状态、Session 记录和业务事实，以及每一层什么时候才算完成。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>CURRENT RUNTIME</span><strong>Agent + AgentSession</strong></div>
</div>

学完本章，你应该能回答三个具体问题：

1. UI 已经看到 `agent_end`，此时能不能立刻销毁 Runtime？
2. 第二天重新打开 Session，哪些状态可以恢复，哪些不会“复活”？
3. resume、branch、fork 看起来都在“从过去继续”，它们到底改了什么？

## 先看一个关闭窗口的问题

假设 Agent 刚执行完写文件工具，Loop 发出了 `agent_end`。此时还有一个 async subscriber 正在把最终消息追加到 Session JSONL。用户马上关闭窗口：

```text
agent_end 已出现
  ≠ Session 一定已经落盘
  ≠ AgentSession 一定不会 retry / compact / 处理队列
  ≠ 应用业务状态一定已经提交
```

这三个“不等于”正是 Runtime 的核心。下面的交互把“运行中 / 已稳定 / 恢复 / 分支”四种时刻的三份状态并排展示。

<RuntimeLedger />

交互中的示例 id、审批状态和事件文本用于教学；所有权、转换关系和完成边界来自固定源码，不是上游运行日志。

## 同一个任务有三份状态

| 状态平面 | 当前所有者 | 生命周期 | 典型内容 |
|---|---|---|---|
| Run 内存状态 | `Agent` | 一个 active Run | streaming message、pending tool ids、AbortSignal、队列 |
| Session 持久记录 | `SessionManager` | 多个 Run，跨进程 | message、model change、compaction、custom entry、分支树 |
| Application 业务状态 | 宿主应用 | 由产品定义 | 路由、任务、审批、权限、业务实体、跨会话协调 |

`AgentState` 没有 JSONL 路径、项目资源或审批字段；Session entry 也不会自动理解“订单已经提交”。边界模糊时，常见事故就是把 UI 显示当成持久事实，或把对话历史当成业务数据库。

```text
Run state          回答“此刻还在执行什么”
Session state      回答“发生过什么、从哪里继续”
Application state  回答“业务世界现在是什么状态”
```

图源位于 `diagrams/04-agent-runtime/runtime-state-boundaries.mmd`。

源码锚点：[`types.ts` · `AgentState`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L333-L358)；[`session-manager.ts` · custom entries](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/session-manager.ts#L94-L153)

## 第一个完成信号：Core Run 已经结算

Core `Agent` 同时只允许一个 active Run。调用 `prompt()` 后，运行态会保留到：

```text
Loop 发出 agent_end
  → Agent.processEvents 逐个 await subscriber
  → finishRun 清理 activeRun
  → prompt() / waitForIdle() resolve
```

所以 `agent_end` 的准确含义是“本 Run 不会再产生新的 loop event”。它不是“所有订阅者都完成”。Session 持久化、扩展事件或外部日志仍可能在 subscriber 内执行，Core 会等待它们完成后才进入 idle。

这也是为什么 `isStreaming` 在 awaited listeners 完成前仍保持 true。若 UI 一看到 `agent_end` 就销毁 Runtime，可能打断最后的持久化副作用。

源码锚点：[`agent.ts` · `subscribe`, `waitForIdle`, `finishRun`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/agent.ts#L240-L253)

## 第二个完成信号：用户操作已经稳定

现行 Coding Agent 并不是把 `Agent.prompt()` 直接暴露给产品层。`AgentSession` 还会管理：

- JSONL persistence 与树导航；
- extensions、commands 和动态 tools；
- auto-retry 与 auto-compaction；
- bash、资源刷新和 UI 事件；
- session-level 队列与结算。

一次 `_runAgentPrompt()` 在第一个 `agent.prompt()` 返回后，仍可能发现 retry、compaction 或新排队输入，然后继续调用 `agent.continue()`。因此，一个用户操作可以跨多个 Core Run：

```text
user operation
  → Core Run #1
  → retry / compaction / queued input ?
       yes → Core Run #2 → 再检查
       no  → agent_settled
```

如果产品要开放 Session 切换、关闭窗口或执行下一项事务，`agent_settled` 比第一次 `agent_end` 更接近用户操作的稳定点。

| 信号 | 它证明什么 | 它没有证明什么 |
|---|---|---|
| `agent_end` | 一个 Core Run 不再发新 Loop 事件 | subscriber 已完成、Session 不再续跑 |
| `waitForIdle()` | Core Run 与 awaited subscribers 已结算 | AgentSession 没有 retry/compaction/队列 |
| `agent_settled` | 当前 Session 用户操作不再自动续跑 | 外部业务事务必然已提交 |

源码锚点：[`agent-session.ts` · `_runAgentPrompt`, `_handlePostAgentRun`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/agent-session.ts#L1074-L1115)

## Session 落盘就在事件路径上

`AgentSession` 本身是 `Agent.subscribe()` 的 async listener。以 `message_end` 为例，它会依次：

1. 更新内部队列显示；
2. 等待 extension event；
3. 同步通知 AgentSession listeners；
4. 把最终 message append 到 `SessionManager`。

Core 会等待整个 handler，因此这次 append 属于 Run settlement。但还有一个细边界：AgentSession 对 UI 的 listeners 是同步调用，不会继续 await UI 返回的 Promise。需要可靠完成的副作用，不能只挂在一个会被忽略 Promise 的 UI 回调上。

## Session 是一棵追加树

当前 Coding Agent `SessionManager` 使用 append-only JSONL。每个 entry 至少有：

```ts
interface SessionEntryBase {
  id: string
  parentId: string | null
  timestamp: string
}
```

`parentId` 把 entries 连成树，内存中的 leaf 指向当前路径终点。`branch(entryId)` 只把 leaf 移到旧节点；下一次 append 时，才会从该节点长出一个新 child。旧分支不覆盖、不删除。

```text
root ─ A ─ B ─ C        原 leaf
           └─ D         branch 到 B 后，下一次 append 产生 D
```

恢复 Context 时只沿当前 leaf 回溯 root，再应用最新 compaction summary 与保留后缀。树上其他分支仍可审计，但不会自动进入下一次模型请求。

图源位于 `diagrams/04-agent-runtime/session-tree.mmd`。

源码锚点：[`session-manager.ts` · `_appendEntry`, `branch`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/session-manager.ts#L1044-L1067)；[`buildSessionContext`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/session-manager.ts#L334-L469)

## Resume、branch、fork 改的是不同边界

| 操作 | Session 文件 | leaf / 路径 | 适合什么 |
|---|---|---|---|
| `open()` / `continueRecent()` | 原文件 | 恢复原 leaf | 继续同一个 Session |
| `branch(entryId)` | 原文件 | 移到祖先；下一 append 生成 sibling | 在同一历史树探索另一条路 |
| `createBranchedSession()` | 新文件 | 复制选中的 root-to-leaf 路径 | 把一条分支独立成 Session |
| `forkFrom()` | 新文件，可换 cwd | 复制源 Session 的非 header entries | 在新工作目录继续副本 |

它们都能“从过去继续”，但所有权和文件语义不同。应用若还维护审批单、任务或订单，必须明确 branch/fork 时这些业务实体是共享、复制、重算还是禁止；SessionManager 不会替产品决定。

## Resume 只能重建被持久化的状态

重新打开 Session 可以读取 JSONL、恢复当前 leaf、模型设置和可转换的 entries，再重建新的 idle Agent。它不能把旧进程里的 Promise、listener、socket、active tool 或 AbortController 复活。

Coding Agent 还提供：

- `CustomEntry`：扩展数据写入 JSONL，但不进入 LLM Context；
- `CustomMessageEntry`：转换成自定义 AgentMessage，才可能进入 Context；
- reload 后由扩展扫描 entries，自行归约自己的状态。

这些是扩展点，不是通用业务状态框架。对于审批、订单或任务编排，更稳妥的设计通常是让业务数据库成为 authority，只把关联 id、操作证据和必要快照写进 Session。

<div class="chapter-rule">
  <strong>对话可恢复，不等于业务可恢复</strong>
  <span>只有被明确持久化、能够重新归约、并且有权威数据源的状态，才算 Runtime 重启后仍然成立。</span>
</div>

## Extension runner 是当前控制面

Extension 不只是“多几个 Tool”。固定源码允许它在多个边界介入：

| 边界 | 可以做什么 | 不能误读成什么 |
|---|---|---|
| command preflight | 在进入模型前直接处理命令 | 普通 user prompt |
| `before_agent_start` | 注入 message、改 system prompt | 修改已经完成的 Run |
| `context` | 每次请求前转换 messages | Core 内建 RAG |
| `tool_call` | block 或放行调用 | Tool 已经成功执行 |
| `tool_result` | 改 content/details/error/usage | 回滚真实外部副作用 |

Session 被替换或 reload 时，旧 extension context 会 invalidate。扩展若保存引用、启动后台任务或暴露 host 方法，必须把这个生命周期纳入清理逻辑。

源码锚点：[`extensions/runner.ts` · hook emitters](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/extensions/runner.ts#L877-L1014)

## 切换 cwd 意味着重建一组服务

`ResourceLoader` 汇集 extensions、skills、prompt templates、themes、AGENTS files 和 system prompt 片段。`createAgentSessionServices()` 又为当前 cwd 建立 model runtime、settings 和 resource loader。

所以跨 cwd 的 resume/fork 不是只改一个字符串：

```text
abort / settle old session
  → emit shutdown
  → invalidate + dispose old resources
  → rebuild cwd-bound services
  → create/open target session
  → rebind host
```

同一文件内的树导航属于 AgentSession；跨 Session、跨 cwd 的整体替换属于更外层 `AgentSessionRuntime`。

源码锚点：[`agent-session-runtime.ts` · `AgentSessionRuntime`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/agent-session-runtime.ts)；[`resource-loader.ts` · `ResourceLoader`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/resource-loader.ts#L30-L52)

## 文件系统和 Shell 能力来自宿主

Harness 的 `ExecutionEnv` 组合 FileSystem 与 Shell 接口；真正调用 Node cwd/path、spawn、abort/timeout、流式回调和文件操作的是从独立 `./node` entrypoint 导出的 `NodeExecutionEnv`。

这条边界意味着 Runtime 策略和事件协议不会凭空获得 OS 权限。宿主选择 adapter，也就选择了能力、隔离和错误语义。浏览器能够加载 Core 类型，不代表浏览器能够执行 shell。

源码锚点：[`harness/env/nodejs.ts` · `NodeExecutionEnv`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/env/nodejs.ts#L347-L695)

## Harness v2 要分“底座”和“驾驶器”

固定版本已经实现了一批耐久化基础件：

- Session v4 的 entries、records、facts、lanes 和 views；
- memory / JSONL storage 与 backend conformance；
- `validateRecordLog()`、`reduceLaneState()` 等纯 reducer；
- `ExecutionEnv`、`NodeExecutionEnv` 与部分 tools。

但高层 `AgentHarness` operation driver 仍是 scaffold：

- `create()` 只接受没有 record 的 Session，restore 分支拒绝；
- `prompt`、`resume`、`abort`、`queue`、`drive`、`watch` 和 lane orchestration 都调用 `unavailable()`；
- hooks/events registration 也不可用；
- 当前 Coding Agent SDK 仍创建现行 `Agent + AgentSession`。

这些路径会抛 `HarnessNotImplemented`。准确表述是“durable Session 基础件已经落地，高层 operation driver 尚未可运行”，而不是“整个 Harness 都没实现”或“Harness v2 已接管 Coding Agent”。

源码锚点：[`agent-harness.ts` · `HarnessNotImplemented`, `AgentHarness`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/agent-harness.ts#L74-L82)；[`session/session.ts` · `Session`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/session/session.ts#L102-L220)

## 原子发布文件不等于操作级事务

Session v4 JSONL storage 用 Promise tail 串行化 mutation：每项先 append 一行，再更新内存 state；append 失败则不推进 state。fork 发布和 torn-tail repair 使用 sibling `.tmp` 加 rename，保护原文件。

但当前 `SessionStorage` 没有目标规格中的多写 `commit(Transaction)`。因此可以说单项 mutation 串行落盘、fork/repair 原子发布文件；不能说一次 operation 的 entries、registers 和 usage 已经 all-or-none 提交，更不能据此宣称 destructive Tool 具备崩溃恢复。

源码锚点：[`jsonl/storage.ts` · `enqueue`, `appendMutation`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/session/jsonl/storage.ts#L258-L275)

## 设计 Runtime 时逐项检查

- Run、Session、Application 三份状态分别有明确 owner 和 authority。
- `agent_end`、Core idle、Session settled 和业务完成使用不同名称。
- 销毁或切换 Runtime 前先 abort，再等待 settlement，再 dispose。
- resume 只重建持久状态，不假装恢复进程内对象。
- branch/fork 对外部业务实体有明确共享或复制策略。
- Extension hook 失败、超时和取消有可见边界。
- OS 能力通过 adapter 注入，权限不藏在 Core 里。
- 规格、类型、已实现 primitive 和可运行 product path 分开陈述。

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
  <p>现在再判断“运行是否完成”，应先说清是在问 Core Run、Session 用户操作还是外部业务事务；再选择 `agent_end`、idle、`agent_settled` 或业务提交作为各自的完成信号。</p>
</section>
