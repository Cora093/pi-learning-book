---
title: "05 Agent Application Engineering"
chapter: "05"
sourceStatus: verified
contentStatus: complete
pageClass: chapter-detail-page
---

# 05 Agent Application Engineering

<div class="chapter-status">状态：源码证据、正文与可视化已完成</div>

<p class="chapter-lead">一个 Agent 能跑完 Demo，不等于它可以上线。应用工程要把每次运行变成一份能关联、复盘、判分和比较的证据：协议怎样结束，工具做了什么，最终业务状态是否正确，以及这次结果花了多少时间、token 和成本。</p>

<div class="source-stamp" aria-label="本章固定源码">
  <div><span>TAG</span><strong>v0.84.3</strong></div>
  <div><span>COMMIT</span><strong>4e58f324fae8ebfa98a3d45181fb248072a2afac</strong></div>
  <div><span>APP CONTRACT</span><strong>trace + evaluator + metrics</strong></div>
</div>

学完本章，你应该能回答三个具体问题：

1. `stopReason=stop`、所有 Tool 都成功，为什么任务仍可能失败？
2. 一次用户操作跨过重试、工具和多个 Core Run 时，延迟和失败应该怎样归因？
3. 比较两个 Agent 框架时，怎样证明它们跑的是同一个实验？

## 先看一个“全绿但失败”的任务

假设 Case 要求 Agent 修改 `config.json` 并补上必需字段 `owner`。一次运行显示：

```text
write_file          isError = false
assistant           stopReason = stop
AgentSession        agent_settled
```

从协议到工具全部“正常”，但最终文件没有 `owner`。真正检查 fixture output 的 grader 应该判定 **FAIL**。

下面的交互并列四种运行：一次通过、重试后通过、工具失败后修复，以及协议成功但业务失败。

<EvalTraceBench />

交互中的时间、token、cost 和 Case id 是教学样例，不是固定源码基准数据；它演示的是证据关系：协议信号、工具结果和业务 grader 必须分开记录。

## 评测必须先定义 Case

“这个 Agent 表现怎么样？”不是可执行问题。至少要先固定：

- 输入和初始 fixture；
- 允许哪些 Tool 与副作用；
- 期望的最终状态；
- 谁来判分，部分正确怎样计分；
- 同一 Case 跑多少次，模型与运行参数是什么；
- trace、latency、token、cost 和 failure 怎样归一化。

一个最小应用层 contract 可以是：

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

这不是 Pi 导出的类型，而是本章建议的实验边界。没有 Case 和 grader，一条漂亮 Session 只能证明“曾经成功过一次”，不能证明成功率、稳定性或回归风险。

图源位于 `diagrams/05-application-engineering/trace-to-evaluation.mmd`。

## Trace 要把分散事实关联起来

Core `AgentEvent` 已提供实时骨架：

```text
agent_start / agent_end
turn_start / turn_end
message_start / update / end
tool_execution_start / update / end
```

`toolCallId` 可以关联一个 Run 内的调用与结果，AssistantMessage 带 provider、model、Usage、stopReason 和 timestamp。AgentSession 又增加 retry、compaction、queue、entry append 和 `agent_settled`。

但这些原始事件没有统一 `eventId`、`traceId`、`caseId` 或接收时间，也没有自动形成跨层 trace store。应用至少要补一层归一化 envelope：

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

这同样是本章建议的应用类型，不是 Pi 内建类型。原始事件应保留用于取证；normalized trace 用于关联、查询、聚合和跨 adapter 比较。

源码锚点：[`types.ts` · `AgentEvent`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/types.ts#L421-L443)；[`agent-session.ts` · `AgentSessionEvent`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/agent-session.ts)

## 先命名计时边界，再记录延迟

第四章已经说明：第一次 `agent_end` 后，AgentSession 仍可能 retry、compact 或继续处理队列。评测一个 Case attempt 的端到端时间时，合理边界是：

```text
start = host accepts one Case attempt
end   = AgentSession emits agent_settled, then grader completes
```

不同指标不能都叫“响应时间”：

| 指标 | 起点 → 终点 |
|---|---|
| queue wait | accepted → first Core Run starts |
| TTFT | provider request starts → first assistant update |
| tool duration | `tool_execution_start` → `tool_execution_end` |
| retry delay | retry scheduled → next provider attempt starts |
| wall latency | Case accepted → `agent_settled` + grader completes |

事件 contract 没有统一计时字段，message timestamp 也覆盖不了 queue wait、retry sleep 和所有工具。实验宿主应使用同一个 monotonic clock 记录接收时间，避免系统时钟调整造成错误时长。

多次 attempts 后才能计算 median、p50、p95 和 failure distribution。单次运行没有 p95，把消息数当成功率分母也没有意义。

## Telemetry 有词汇表，不等于已经自动埋点

固定源码包含独立 `pi-telemetry` contract、no-op/in-memory context，以及：

- `pi.ai.request` span schema：provider、model、stop reason、token、cost、chunk count、TTFC；
- `pi.harness.*` span schema：run、turn、tool、checkpoint、navigation 等 vocabulary；
- `startAiSpan()` / `startHarnessSpan()` typed helper。

但 production call site 核对没有发现当前 `Agent`、`AgentSession` 或 provider 自动调用这些 starters，`AgentHarness` driver 也仍是 scaffold。准确说法是“可复用 typed telemetry contract 已存在”，不是“Coding Agent 已自动生成完整 spans”。

应用可以订阅现行 events 接 OpenTelemetry，也可以在 provider、tool 和 host 边界显式调用 helper；无论哪种方式，都要测试 trace 关联与缺失数据。

源码锚点：[`harness/telemetry.ts` · `AI_TELEMETRY_SCHEMA`, `HARNESS_TELEMETRY_SCHEMA`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/agent/src/harness/telemetry.ts#L42-L144)

## 协议结束、工具结果和业务成功是三条轴

### `stopReason` 只说明模型响应怎样停下

| 值 | 协议含义 | 能否证明业务成功 |
|---|---|---|
| `pending` | 流仍在进行 | 不能 |
| `toolUse` | Assistant 请求使用工具 | 不能，Loop 通常继续 |
| `stop` | provider 正常结束本次响应 | 不能，内容可能错误 |
| `length` | 输出被长度限制截断 | 不能，通常需要恢复 |
| `error` | 响应或运行路径失败 | 不能定位具体责任层 |
| `aborted` | 协作取消 | 不能说明外部副作用是否已发生 |
| `deferred` | 延迟执行 | 任务还未完成 |

源码锚点：[`packages/ai/src/types.ts` · `StopReason`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/types.ts#L405-L405)

### Tool error 只说明一次工具调用失败

找不到 Tool、参数校验失败、hook block/throw、execute throw 和 after-hook throw，都会归一化成 `isError=true` 的 ToolResultMessage。模型通常能在下一 Turn 读取错误并修复。

因此两种情况都成立：

- 中间 Tool 失败，最终 Case 通过；
- 所有 Tool 表面成功，最终 Case 失败。

### Grader 才判断业务目标是否达到

代码任务应检查测试、类型、文件 diff 和约束；数据任务检查结构化记录与不变量；操作任务检查外部最终状态和副作用次数；文本任务可以组合规则、人工标注和 model grader，并记录 grader 版本。

<div class="chapter-rule">
  <strong><code>stop</code> 不是 <code>taskSuccess</code></strong>
  <span>协议正常结束、工具没有报错，都不能替代针对 expected outcome 的 evaluator。</span>
</div>

## Failure taxonomy 要保留责任层

一个 `error=true` 无法回答应该重试 provider、修复 prompt、修改工具还是回滚业务。建议保留五层：

| 层 | 固定源码可见信号 | 应用需要补什么 | 最终是否必败 |
|---|---|---|---|
| provider / transport | `stopReason=error`、errorMessage、diagnostics | provider、HTTP status、code、retryable、attempt | 不一定，可重试恢复 |
| model / protocol | `length`、坏 tool args、错误内容 | reason、schema violation、grader evidence | 不一定，可修复 |
| tool | `isError`、tool execution events | toolName、toolCallId、sideEffect、retryable | 不一定，下一 Turn 可恢复 |
| runtime | transform/listener/custom stream throw | component、code、stack ref、cleanup result | 通常结束当前 Run |
| application | Pi 无内建字段 | expected、actual、grader、score | 由 evaluator 判定 |

`StreamFn` 希望 request/model/runtime failure 作为最终 assistant error message 返回；若 custom stream、transform 或 listener 直接 throw，`Agent.handleRunFailure()` 也会合成 `stopReason=error`。统一字段有利于 Loop 收敛，却会压平责任层，所以应用应在失败发生的边界尽早记录稳定的 `failure.layer`、`failure.code` 和 `retryable`，不要只靠 error string 反推。

## Token、成本和 SessionStats 回答不同问题

### Usage 先保留原始分项

Pi `Usage` 包含 input、output、cacheRead、cacheWrite、可选 cacheWrite1h、可选 reasoning、totalTokens 和 cost 分项。

两个常见错误是：

1. `reasoning` 是 output 的子集，却被再次加到 output，造成重复计数；
2. 只保存 totalTokens 或美元总价，丢掉 cache 命中和模型路由差异。

ToolResultMessage 也可以带自己的 Usage，但注释明确它不属于主 LLM context accounting。报告要么单独列 Tool usage，要么显式写出合并规则。

源码锚点：[`types.ts` · `Usage`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/types.ts#L382-L403)

### Cost 是价格快照上的派生值

`calculateCost()` 根据模型价目与 provider usage 计算 input、output、cache read/write，还会按总 input 选择 pricing tier 并处理特定 cache write 规则。

所以成本比较必须同时保留 provider、请求 model、实际 response model、API/routing、价格 catalog 时间快照、原始 token 分项，以及 retry、compaction 和 grader 是否计入。只留下 `$0.02` 无法复核。

源码锚点：[`models.ts` · `calculateCost`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/ai/src/models.ts#L878-L927)

### SessionStats 是累计账本

`AgentSession.getSessionStats()` 扫描全部 entries，包括已经被 compaction 从当前 Context 替代的历史、branch summary、compaction 和带 Usage 的 Tool result。它回答“整个 Session 累计花了多少”，不是“当前 Case attempt 花了多少”。

它没有 case/attempt id、wall latency、TTFT、tool duration、task success、failure layer、p50/p95 或成功率。这些必须由实验 harness 在 attempt 边界采集。`contextUsage` 又是当前分支 Context 的另一种估计，不能与累计账本混用。

源码锚点：[`agent-session.ts` · `getSessionStats`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/agent-session.ts#L3242-L3296)

## Session 导出只是 Dataset 原料

固定源码可以导出 JSONL 或 HTML：JSONL share export 只导出当前 root-to-leaf branch 并重写 parent chain；HTML export 可以带 entries、leaf、system prompt 和 Tool definitions，适合人工复盘。

但这些产物没有 Case、ground truth、grader result、attempt 参数和成功标签。固定 production source 也没有通用 Dataset/Evaluator/Pass-rate runner。官方文档提到把 Session 发布到外部 Hugging Face dataset，也不等于本地已经拥有可重复 evaluation。

源码锚点：[`session-export.ts` · `exportSessionToJsonl`](https://github.com/earendil-works/pi/blob/4e58f324fae8ebfa98a3d45181fb248072a2afac/packages/coding-agent/src/core/session-export.ts)

## 先写 Grader，再收集案例

如果先收集“看起来不错”的成功 Session，再反推评分规则，数据集会系统性高估质量。更稳妥的顺序是：

```text
定义 expected outcome
  → 写可执行 grader
  → 固定 fixture 与 Tool contract
  → 收集正常、边界和失败 Cases
  → 多次 attempts
  → 聚合成功率、延迟、成本和失败分布
```

数据集至少覆盖正常路径、空输入、边界大小、权限拒绝、瞬态 provider 失败、Tool error、部分副作用和恢复，而不是只保留成功记录。

## 产品形态取决于谁控制下一步

Autonomous、Workflow、Hybrid 是本书的产品设计词，不是固定源码导出的 runtime type：

| 形态 | 下一步主要由谁决定 | 适合 | 主要工程要求 |
|---|---|---|---|
| Autonomous | 模型在 Loop 内选择 Tool | 开放式探索、步骤未知 | 强权限、预算、终止、trace、recovery |
| Workflow | 宿主状态机控制阶段和转移 | 合规流程、步骤稳定 | 状态迁移、幂等、补偿、人工门禁 |
| Hybrid | Workflow 包住局部 agentic Run | 大多数业务 Agent | 同时定义 workflow state 与 Run boundary |

Pi 提供 `prompt/continue`、`shouldStopAfterTurn`、`prepareNextTurn`、Tool、Extension 和 Session primitives，让应用组合这些形态。能写成确定性业务规则的部分优先交给 Workflow；需要语义判断或开放式探索的局部再交给 Autonomous Loop。

## 公平比较先冻结共享实验

跨框架比较时，先冻结：

- 同一 Case input、fixture 和 expected outcome；
- 同一 provider/model、temperature、reasoning、max token、timeout 与 retry policy；
- 同名、同 schema、同副作用、同错误语义的 Tool Contract；
- 同一 grader、attempt 数和聚合方法；
- 相同的 latency、token、cost 与 failure normalization。

不同框架只实现自己的 adapter：

```text
runCase(case, config, tools)
  → normalized result
  → normalized trace
  → normalized failures
  → normalized metrics
```

本文没有读取或验证 LangGraph 源码，因此不声称其内部 loop、state、checkpoint 或性能如何。可比较的是 task success、partial score、Tool Contract 行为、failure 分布、wall latency、token/cost 和 trace completeness；私有事件数、节点数或存储行数不是共同业务结果。

图源位于 `diagrams/05-application-engineering/comparison-contract.mmd`。

<div class="chapter-rule">
  <strong>先证明是同一个实验，再讨论谁更好</strong>
  <span>模型、工具、重试、grader 或 Case 任意一项不同，结论都可能只是实验条件差异。</span>
</div>

## 上线前应交付一份证据包

- Case dataset 有版本、来源、覆盖范围和敏感数据规则。
- 每个 attempt 有 traceId/caseId/attemptId 与不可变运行配置。
- Raw events、normalized trace、Session 与业务结果能够互相定位。
- Failure 保留 layer/code/retryable，不只存 error string。
- 成功率由权威 grader 计算，失败样本可以复盘。
- latency 明确边界，并给出样本数、p50 和 p95。
- token/cost 保留分项、provider/model/routing 和价格快照。
- Tool 副作用有幂等键、审计记录和补偿或人工处理策略。
- 发布门禁基于回归阈值，不基于一次 Demo。
- 线上监控与离线 evaluation 使用兼容的 trace schema。

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

五章 Book 内容至此形成一条完整主线：Loop 决定下一步，Tool 把请求变成受控副作用，Context 决定模型此刻看到什么，Runtime 负责持久化与恢复，Application Engineering 再把运行变成可判分、可比较的证据。

<section class="chapter-summary">
  <h2>本章收束</h2>
  <p>现在再评价一个 Agent，不应只看它是否说完或工具是否报错，而要从 Case expected outcome 出发，用关联后的 trace 解释每一层发生了什么，再由 grader、attempts 和可复核 metrics 给出结论。</p>
</section>
