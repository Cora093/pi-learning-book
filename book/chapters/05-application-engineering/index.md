---
title: "05 Agent Application Engineering"
chapter: "05"
sourceStatus: verified
contentStatus: complete
pageClass: chapter-detail-page
---

# 05 Agent Application Engineering

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">Agent Application Engineering 的目标不是让 Demo 看起来更聪明，而是让每次运行都能被关联、复盘、判分和比较：知道它做了什么、在哪里失败、用了多少时间与成本，以及业务结果是否真的达标。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>APP CONTRACT</span><strong>trace + evaluator + metrics</strong></div>
</div>

学完本章，你应该能做到：

1. 从 Agent/AgentSession events、Session entries 和业务状态构建可判分 trace。
2. 区分 provider、model、tool、runtime、application 五层 failure，不把协议结束当成业务成功。
3. 设计可重复的 Case dataset 和公平的跨框架 adapter 对照，而不是比较两个不同实验。

## 上线问题必须从 Case 开始

“这个 Agent 表现怎么样？”不是一个可执行问题。至少要先固定：

- 输入与初始 fixture 是什么；
- 允许哪些 Tool 和副作用；
- 期望的最终状态是什么；
- 谁来判分，部分正确怎样计分；
- 相同 Case 跑多少次，模型与运行参数是什么；
- trace、latency、token、cost 和 failure 怎样归一化。

没有这些约束，漂亮的 Session 只能说明“曾经成功过一次”，不能说明成功率、稳定性或回归风险。

图源位于 `diagrams/05-application-engineering/trace-to-evaluation.mmd`。

<EvalTraceBench />

交互组件中的时间、token、cost 和 Case id 是教学样例，不是固定源码基准数据；它演示的是证据关系：协议信号、工具结果和业务 grader 必须分别记录。

## Trace 是关联后的事实，不是事件数组

低层 `AgentEvent` 已经给出实时骨架：

```text
agent_start / agent_end
turn_start / turn_end
message_start / update / end
tool_execution_start / update / end
```

`toolCallId` 能关联一个 Run 内的调用和结果，AssistantMessage 带 provider、model、Usage、stopReason 与 timestamp。但事件自身没有统一的 `eventId`、`runId` 或接收时间，也没有 trace store。

Coding Agent 的 `AgentSessionEvent` 又增加 retry、compaction、queue、entry append 和 `agent_settled`。一次产品级操作可能跨多个 Core Run，所以端到端 trace 至少需要应用补充：

```ts
interface NormalizedTraceEvent {
  traceId: string
  caseId: string
  attemptId: string
  sequence: number
  receivedAtMonotonicMs: number
  layer: "provider" | "model" | "tool" | "runtime" | "application"
  type: string
  sourceId?: string
  attributes: Record<string, unknown>
}
```

这不是 Pi 类型，而是第五章建议的应用层归一化 envelope。原始 event 仍应保留，normalized trace 服务查询、聚合和跨 adapter 比较。

源码锚点：[`types.ts` · `AgentEvent`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L421-L443)；[`agent-session.ts` · `AgentSessionEvent`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/agent-session.ts)

## Trace 终点使用 `agent_settled`

第四章已经证明：第一次 `agent_end` 后，AgentSession 仍可能 retry、compact 或继续处理排队输入。评测端到端 wall latency 时，合理边界是：

```text
start = host accepts one Case attempt
end   = AgentSession emits agent_settled
```

如果只测单次 provider request，应该明确命名 `provider latency`；如果测一次 Tool，命名 `tool duration`。不要把不同边界都叫“响应时间”。

事件 contract 没有统一计时字段，message timestamp 也覆盖不了 queue wait、retry sleep 和所有 Tool。实验宿主应在同一个 monotonic clock 上记录接收时间，避免系统时钟调整造成负时长。

## Telemetry schema 已定义，不等于自动接线

固定源码包含独立 `pi-telemetry` contract、no-op/in-memory context，以及：

- `pi.ai.request` span schema：provider、model、stop reason、token、cost、chunk count、TTFC；
- `pi.harness.*` span schema：run、turn、tool、checkpoint、navigation 等 vocabulary；
- `startAiSpan()` / `startHarnessSpan()` typed helper。

但全局 production call site 核对没有发现当前 `Agent`、`AgentSession` 或 provider 自动调用这些 starters。`AgentHarness` driver 本身也仍是 scaffold。因此准确表述是“可复用 typed telemetry contract 已存在”，不是“当前 Coding Agent 已自动产生完整 spans”。

应用可以选择订阅现行 events 自己接 OpenTelemetry，也可以在 provider/tool/host 边界显式调用 helper；无论哪种方式，都要测试 trace 关联与缺失数据。

源码锚点：[`harness/telemetry.ts` · `AI_TELEMETRY_SCHEMA`, `HARNESS_TELEMETRY_SCHEMA`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/telemetry.ts#L42-L144)

## `stopReason` 只回答协议怎样停下

`StopReason` 的值各自描述 provider/协议状态：

| 值 | 含义 | 能否证明业务成功 |
|---|---|---|
| `pending` | 流仍在进行 | 不能 |
| `toolUse` | Assistant 请求执行工具 | 不能，Loop 通常继续 |
| `stop` | provider 正常结束本次响应 | 不能，内容可能错误 |
| `length` | 输出被长度限制截断 | 不能，通常需要恢复策略 |
| `error` | 响应/运行路径失败 | 不能定位具体责任层 |
| `aborted` | 协作取消 | 不能说明外部副作用是否发生 |
| `deferred` | 延迟执行 | 任务仍未完成 |

`stopReason=stop` 很容易被误读为 `taskSuccess=true`。实际上，即使 Tool 都返回 `isError=false`，它们也可能修改了错误文件；只有针对 Case expected outcome 的 evaluator 能判定业务结果。

源码锚点：[`packages/ai/src/types.ts` · `StopReason`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/types.ts#L405-L405)

## Failure taxonomy 必须保留责任层

建议使用五层，而不是一个 `error=true`：

| 层 | 固定源码可见信号 | 应用补充字段 | 最终是否必败 |
|---|---|---|---|
| provider / transport | `stopReason=error`、errorMessage、rawStopReason、可选 diagnostics | provider、http status、code、retryable、attempt | 不一定，可重试恢复 |
| model / protocol | `length`、坏 tool args、错误内容 | reason、schema violation、grader evidence | 不一定，可修复 |
| tool | `ToolResultMessage.isError`、tool execution events | toolName、toolCallId、sideEffect、retryable | 不一定，下一 Turn 可修复 |
| runtime | transform/listener/custom stream throw 后合成 error | component、code、stack ref、cleanup result | 通常结束当前 Run |
| application | Pi 无内建字段 | expected、actual、grader、score | 由 evaluator 最终判定 |

### Tool error 是独立轴

找不到 Tool、参数校验失败、hook block/throw、execute throw 和 after-hook throw 都会被归一化为 `isError=true` 的 ToolResultMessage。单个 Tool 失败通常仍写入 Context，让模型下一 Turn 尝试修复。

因此下面两种情况都可能成立：

- 中间 Tool 失败，最终 Case 通过；
- 所有 Tool 表面成功，最终 Case 失败。

### `stopReason=error` 仍可能丢失责任层

`StreamFn` contract 希望 request/model/runtime failure 作为最终 assistant error message 返回；若自定义 stream、transform 或 listener 直接 throw，`Agent.handleRunFailure()` 也会合成 `stopReason=error`。

最终字段统一有利于 Loop 收敛，却不够做故障分析。应用要在 provider、extension、tool 和 host 边界尽早记录稳定的 `failure.layer`、`failure.code` 与 `retryable`，不要事后只靠 error string 猜。

## Usage 先保留原义，再做汇总

Pi `Usage` 包含：

```text
input
output
cacheRead
cacheWrite
cacheWrite1h?   // provider-specific
reasoning?      // output 的子集
totalTokens
cost.{ input, output, cacheRead, cacheWrite, total }
```

两个常见错误：

1. 把 `reasoning` 再加到 `output`，造成重复计数。
2. 只保留 `totalTokens` 或美元总价，丢掉 cache 命中和模型路由差异。

ToolResultMessage 也可携带自己的 Usage，但注释明确它不属于主 LLM context accounting。报告要么单独列 Tool usage，要么明确合并规则。

源码锚点：[`types.ts` · `Usage`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/types.ts#L382-L403)

## Cost 是价格快照上的派生值

`calculateCost()` 使用模型价目与 provider usage，按每百万 token 计算 input/output/cache read/cache write；还会根据总 input 选择 pricing tier，并处理特定 cache write 规则。

所以成本对比必须同时冻结或记录：

- provider、请求 model 与实际 response model；
- API/routing、订阅或免费路由；
- 价目 catalog 的版本或时间快照；
- 原始 token 分项；
- retry、compaction、grader 自身是否计入。

只比较 `$0.02` 和 `$0.03` 而不保留这些条件，结论不可复核。

源码锚点：[`models.ts` · `calculateCost`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/models.ts#L878-L927)

## SessionStats 是账本，不是评测报表

`AgentSession.getSessionStats()` 扫描全部 entries，包括已被 compaction 从当前 Context 替代的历史，以及 branch summary、compaction 和带 Usage 的 Tool result。它回答“这个 Session 累计花了多少”，不是“当前 Case attempt 花了多少”。

它没有：

- case id / attempt id；
- wall latency、TTFT、tool duration；
- task success、score、failure layer；
- p50 / p95 或成功率。

这些字段必须由实验 harness 在 attempt 边界采集。`contextUsage` 又是当前分支 Context 的另一种估计，不能和累计账本混用。

源码锚点：[`agent-session.ts` · `getSessionStats`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/agent-session.ts#L3242-L3296)

## Latency 与成功率必须跨 attempts 计算

一个最小评测 attempt 至少记录：

| 指标 | 边界 |
|---|---|
| queue wait | accepted → first Core Run starts |
| TTFT | provider request starts → first assistant update |
| tool duration | tool_execution_start → end |
| retry delay | retry scheduled → next attempt start |
| wall latency | Case accepted → agent_settled + grader completes |
| task success | grader pass / 固定 attempt 数 |

多次运行后再计算 median、p50、p95、failure distribution。单次运行没有 p95；把消息数当成功率分母也没有意义。

## Session export 只是 Dataset 原料

固定源码能导出 JSONL 或 HTML：

- JSONL share export 只导出当前 root-to-leaf branch，并重写 parent chain；
- HTML export 可带完整 entries、leaf、system prompt 和 Tool definitions，适合人工复盘。

这些产物没有 Case、ground truth、grader result、attempt 参数和成功标签。固定 production source 也没有通用 Dataset/Evaluator/Pass-rate runner。官方文档提到把 Session 发布到外部 Hugging Face dataset，也不等于本地已经有可重复 evaluation。

一个可执行 Case 至少需要：

```ts
interface EvaluationCase {
  id: string
  input: unknown
  setup: FixtureSpec
  expected: ExpectedOutcome
  grader: GraderSpec
  allowedTools: string[]
  timeoutMs: number
  attempts: number
}
```

仍然要注意：这也是本书建议的应用 contract，不是 Pi 导出类型。

源码锚点：[`session-export.ts` · `exportSessionToJsonl`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/session-export.ts)

## 先写 Grader，再扩充 Case

好的 evaluator 尽量检查权威结果，而不是给最终自然语言“凭感觉打分”：

- 代码任务检查测试、类型、文件 diff 与约束；
- 数据任务检查结构化记录与不变量；
- 操作任务检查外部系统的最终状态和副作用次数；
- 文本任务可用规则、人工标注和 model grader 组合，并记录 grader 版本。

数据集还需要覆盖：正常路径、空输入、边界大小、权限拒绝、瞬态 provider 失败、Tool error、部分副作用和恢复。不要只保留成功 Session；那会系统性高估质量。

## Autonomous、Workflow、Hybrid 是产品选择

固定源码没有导出这三个 runtime type。本书用它们描述“谁控制下一步”：

| 形态 | 下一步主要由谁决定 | 适合 | 主要工程要求 |
|---|---|---|---|
| Autonomous | 模型在 Loop 内选择 Tool，直到停止 | 开放式探索、步骤未知 | 强权限、预算、终止、trace 与 recovery |
| Workflow | 宿主状态机显式控制阶段和转移 | 合规流程、步骤稳定 | 状态迁移、幂等、补偿、人工门禁 |
| Hybrid | 确定性 workflow 包住局部 agentic Run | 大多数业务 Agent | 同时定义 workflow state 与 Run boundary |

Pi 提供 `prompt/continue`、`shouldStopAfterTurn`、`prepareNextTurn`、Tool、Extension 和 Session primitives，让应用组合这些形态；它不会替产品判断哪种更合适。

一个实用选择原则：能写成确定性业务规则的地方优先由 Workflow 控制；需要语义判断或开放式探索的局部再交给 Autonomous Loop。

## 公平对照先冻结 shared contract

做跨框架评测时，共享 contract 应统一 Case dataset、Tool Contract、模型与运行参数、Trace schema 和 Metrics；不同框架只实现各自的 adapter。

图源位于 `diagrams/05-application-engineering/comparison-contract.mmd`。

最低公平条件包括：

- 同一 Case input、fixture 和 expected outcome；
- 同一 provider/model、temperature、reasoning、max token、timeout 与 retry policy；
- 同名、同 schema、同副作用、同错误语义的 Tool Contract；
- 同一 grader、attempt 数和聚合方法；
- 相同的 latency、token、cost 与 failure normalization；
- 框架 adapter 不得私自改 Case 或评价口径。

本章完成的是实验原则和可比 interface，不提供某一次私人评测的实现或运行结果。

## Pi 与 LangGraph 只比较 adapter 输出

本文没有读取或验证 LangGraph 源码，因此不声称 LangGraph 的内部 loop、state、checkpoint 或性能如何。

可比边界应是：

```text
runCase(case, config, tools)
  -> normalized result
  -> normalized trace
  -> normalized failures
  -> normalized metrics
```

可以比较 task success、partial score、Tool Contract 行为、failure 分布、wall latency、token/cost 和 trace completeness。不能直接比较 Pi 私有事件数、另一框架私有节点数或不同持久化结构的行数；那些是实现细节，不是共同业务结果。

<div class="chapter-rule">
  <strong>先证明是同一个实验，再讨论谁更好</strong>
  <span>模型、工具、重试、grader 或 Case 任意一项不同，框架结论都可能只是实验条件差异。</span>
</div>

## 上线前的证据包

- Case dataset 有版本、来源、覆盖范围和敏感数据规则。
- 每个 attempt 有 traceId/caseId/attemptId 与不可变运行配置。
- Raw events、normalized trace、Session 与业务结果能互相定位。
- Failure 保留 layer/code/retryable，不只存 error string。
- 成功率由权威 grader 计算，失败样本可复盘。
- latency 报告明确边界，并至少给样本数、p50 与 p95。
- token/cost 保留分项、provider/model/routing 与价格快照。
- Tool 副作用有幂等键、审计记录和补偿/人工处理策略。
- 发布门禁基于回归阈值，不基于单次 Demo。
- 线上监控与离线 evaluation 使用兼容 trace schema。

## 本章证据地图

<div class="evidence-grid">
  <article><code>AE-01 — AE-04</code><h3>Trace 原料</h3><p>Core/Session events、telemetry contract 与导出边界</p></article>
  <article><code>AE-05 — AE-08</code><h3>Failure taxonomy</h3><p>stopReason、Tool error、runtime error 与业务 grader</p></article>
  <article><code>AE-09 — AE-12</code><h3>Metrics</h3><p>Usage、cost、SessionStats、latency 与成功率</p></article>
  <article><code>AE-13</code><h3>Evaluation</h3><p>Session export 不是 Dataset/Evaluator runner</p></article>
  <article><code>AE-14</code><h3>应用形态</h3><p>Autonomous、Workflow 与 Hybrid</p></article>
  <article><code>AE-15 / AE-16</code><h3>公平对照</h3><p>shared contract 与 adapter 可比边界</p></article>
  <article><code>SOURCE NOTES</code><h3>完整研究索引</h3><p><code>evidence/05-application-engineering/source-notes.md</code></p></article>
</div>

五章 Book 内容至此建立完成：从 Core Loop 和 Tool contract，一直走到 Runtime、trace、evaluator 与公平比较的工程边界。

<section class="chapter-summary">
  <h2>本章收束</h2>
  <p>现在可以把一次运行整理成可关联、可判分、可比较的证据，并明确区分 provider、model、tool、runtime 与 application failure。</p>
</section>
