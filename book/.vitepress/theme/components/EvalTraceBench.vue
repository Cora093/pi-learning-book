<script setup lang="ts">
import { computed, ref } from "vue";
import { AlertTriangle, Check, CircleDollarSign, Clock3, Database, Gauge, Route, Wrench, X } from "@lucide/vue";

type AttemptId = "clean" | "retry" | "tool-recovery" | "semantic-fail";
type EventTone = "neutral" | "warning" | "success" | "failure";

interface TraceEvent {
  at: string;
  label: string;
  detail: string;
  tone: EventTone;
}

interface Attempt {
  id: AttemptId;
  label: string;
  stopReason: string;
  verdict: "PASS" | "FAIL";
  verdictReason: string;
  failureLayer: string;
  latency: string;
  tokens: string;
  cost: string;
  attempts: string;
  events: TraceEvent[];
}

const attempts: Attempt[] = [
  {
    id: "clean",
    label: "一次通过",
    stopReason: "stop",
    verdict: "PASS",
    verdictReason: "grader 核对目标文件与 expected outcome，一致。",
    failureLayer: "none",
    latency: "1.84 s",
    tokens: "2,140",
    cost: "$0.014",
    attempts: "1",
    events: [
      { at: "0 ms", label: "prompt accepted", detail: "case-014 / attempt-01", tone: "neutral" },
      { at: "310 ms", label: "first chunk", detail: "TTFT 310 ms", tone: "neutral" },
      { at: "720 ms", label: "tool start", detail: "write_file(call-7)", tone: "neutral" },
      { at: "1.20 s", label: "tool end", detail: "isError=false", tone: "success" },
      { at: "1.84 s", label: "agent settled", detail: "stopReason=stop", tone: "success" },
      { at: "+18 ms", label: "case grader", detail: "expected state matched", tone: "success" },
    ],
  },
  {
    id: "retry",
    label: "重试后通过",
    stopReason: "stop",
    verdict: "PASS",
    verdictReason: "第一次 provider error 被重试；最终 grader 通过，但 attempt 与等待成本必须保留。",
    failureLayer: "provider / recovered",
    latency: "6.12 s",
    tokens: "3,920",
    cost: "$0.031",
    attempts: "2",
    events: [
      { at: "0 ms", label: "prompt accepted", detail: "case-014 / attempt-02", tone: "neutral" },
      { at: "480 ms", label: "assistant error", detail: "stopReason=error", tone: "failure" },
      { at: "510 ms", label: "auto retry", detail: "retryable=true / backoff 2 s", tone: "warning" },
      { at: "3.14 s", label: "first chunk", detail: "second provider attempt", tone: "neutral" },
      { at: "6.12 s", label: "agent settled", detail: "stopReason=stop", tone: "success" },
      { at: "+19 ms", label: "case grader", detail: "expected state matched", tone: "success" },
    ],
  },
  {
    id: "tool-recovery",
    label: "工具修复",
    stopReason: "stop",
    verdict: "PASS",
    verdictReason: "第一次 Tool 失败不是最终任务失败；后续调用修复并通过 grader。",
    failureLayer: "tool / recovered",
    latency: "4.76 s",
    tokens: "4,310",
    cost: "$0.036",
    attempts: "1",
    events: [
      { at: "0 ms", label: "prompt accepted", detail: "case-021 / attempt-01", tone: "neutral" },
      { at: "810 ms", label: "tool end", detail: "write_file · isError=true", tone: "failure" },
      { at: "1.55 s", label: "next turn", detail: "模型读取错误并修正参数", tone: "warning" },
      { at: "2.40 s", label: "tool end", detail: "write_file · isError=false", tone: "success" },
      { at: "4.76 s", label: "agent settled", detail: "stopReason=stop", tone: "success" },
      { at: "+23 ms", label: "case grader", detail: "expected state matched", tone: "success" },
    ],
  },
  {
    id: "semantic-fail",
    label: "语义失败",
    stopReason: "stop",
    verdict: "FAIL",
    verdictReason: "协议与工具都正常结束，但实际文件缺少必需字段；application evaluator 判失败。",
    failureLayer: "application",
    latency: "2.03 s",
    tokens: "2,260",
    cost: "$0.015",
    attempts: "1",
    events: [
      { at: "0 ms", label: "prompt accepted", detail: "case-032 / attempt-01", tone: "neutral" },
      { at: "640 ms", label: "tool start", detail: "write_file(call-9)", tone: "neutral" },
      { at: "1.34 s", label: "tool end", detail: "isError=false", tone: "success" },
      { at: "2.03 s", label: "agent settled", detail: "stopReason=stop", tone: "success" },
      { at: "+21 ms", label: "case grader", detail: "missing required field: owner", tone: "failure" },
    ],
  },
];

const activeId = ref<AttemptId>("semantic-fail");
const active = computed(() => attempts.find((attempt) => attempt.id === activeId.value) ?? attempts[0]);
</script>

<template>
  <section class="eval-bench" aria-labelledby="eval-bench-title">
    <header class="eval-bench__header">
      <div>
        <span class="eval-bench__kicker">NORMALIZED TRACE WORKBENCH</span>
        <h2 id="eval-bench-title">协议结果与业务结果，分开判</h2>
      </div>
      <div class="eval-bench__verdict" :class="active.verdict === 'PASS' ? 'is-pass' : 'is-fail'">
        <Check v-if="active.verdict === 'PASS'" :size="18" aria-hidden="true" />
        <X v-else :size="18" aria-hidden="true" />
        <span>{{ active.verdict }}</span>
      </div>
    </header>

    <div class="eval-bench__tabs" role="tablist" aria-label="评测运行场景">
      <button
        v-for="attempt in attempts"
        :key="attempt.id"
        type="button"
        role="tab"
        :aria-selected="activeId === attempt.id"
        :class="{ 'is-active': activeId === attempt.id }"
        @click="activeId = attempt.id"
      >
        {{ attempt.label }}
      </button>
    </div>

    <div class="eval-bench__summary">
      <div><Route :size="17" aria-hidden="true" /><span>stopReason</span><strong>{{ active.stopReason }}</strong></div>
      <div><AlertTriangle :size="17" aria-hidden="true" /><span>failure.layer</span><strong>{{ active.failureLayer }}</strong></div>
      <div><Clock3 :size="17" aria-hidden="true" /><span>wall latency</span><strong>{{ active.latency }}</strong></div>
      <div><Database :size="17" aria-hidden="true" /><span>tokens</span><strong>{{ active.tokens }}</strong></div>
      <div><CircleDollarSign :size="17" aria-hidden="true" /><span>cost</span><strong>{{ active.cost }}</strong></div>
      <div><Gauge :size="17" aria-hidden="true" /><span>provider attempts</span><strong>{{ active.attempts }}</strong></div>
    </div>

    <div class="eval-bench__body">
      <ol class="eval-bench__timeline" aria-label="归一化 Trace">
        <li v-for="event in active.events" :key="`${event.at}-${event.label}`" :class="`tone-${event.tone}`">
          <time>{{ event.at }}</time>
          <span class="eval-bench__dot" aria-hidden="true"></span>
          <div><strong>{{ event.label }}</strong><small>{{ event.detail }}</small></div>
        </li>
      </ol>

      <aside class="eval-bench__grader">
        <div class="eval-bench__grader-head">
          <Wrench :size="18" aria-hidden="true" />
          <span>CASE EVALUATOR</span>
        </div>
        <strong>{{ active.verdict }}</strong>
        <p>{{ active.verdictReason }}</p>
        <dl>
          <div><dt>case</dt><dd>file-contract-v1</dd></div>
          <div><dt>grader</dt><dd>structured-state</dd></div>
          <div><dt>authority</dt><dd>fixture output</dd></div>
        </dl>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.eval-bench {
  margin: 34px 0 44px;
  overflow: hidden;
  border: 1px solid #2c3a36;
  border-radius: 6px;
  color: #edf5f2;
  background: #0d1513;
}

.eval-bench__header {
  display: flex;
  min-height: 112px;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 26px;
  border-bottom: 1px solid #2c3a36;
}

.eval-bench__kicker {
  color: #e9c75b;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  letter-spacing: 0;
}

.eval-bench__header h2 {
  margin: 8px 0 0;
  border: 0;
  color: #edf5f2;
  font-size: 24px;
  line-height: 1.2;
}

.eval-bench__verdict {
  display: flex;
  min-width: 92px;
  min-height: 38px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}

.eval-bench__verdict.is-pass { color: #63d7b0; }
.eval-bench__verdict.is-fail { color: #ee826f; }

.eval-bench__tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid #2c3a36;
}

.eval-bench__tabs button {
  min-width: 0;
  min-height: 44px;
  padding: 8px;
  border: 0;
  border-right: 1px solid #2c3a36;
  border-radius: 0;
  color: #9baba6;
  background: #111b18;
  font-size: 13px;
}

.eval-bench__tabs button:last-child { border-right: 0; }
.eval-bench__tabs button:hover { color: #edf5f2; background: #17221f; }
.eval-bench__tabs button.is-active { color: #0d1513; background: #e9c75b; }

.eval-bench__summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-bottom: 1px solid #2c3a36;
}

.eval-bench__summary > div {
  display: grid;
  min-width: 0;
  grid-template-columns: 20px minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 9px;
  padding: 16px 20px;
  border-right: 1px solid #2c3a36;
  border-bottom: 1px solid #2c3a36;
}

.eval-bench__summary > div:nth-child(3n) { border-right: 0; }
.eval-bench__summary > div:nth-last-child(-n + 3) { border-bottom: 0; }
.eval-bench__summary svg { grid-row: 1 / 3; align-self: center; color: #6f807a; }
.eval-bench__summary span { color: #82918c; font-size: 10px; }
.eval-bench__summary strong { min-width: 0; overflow-wrap: anywhere; color: #edf5f2; font-family: var(--vp-font-family-mono); font-size: 13px; }

.eval-bench__body {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(240px, 0.75fr);
  min-height: 390px;
}

.eval-bench__timeline {
  margin: 0;
  padding: 26px 24px;
  border-right: 1px solid #2c3a36;
  list-style: none;
}

.eval-bench__timeline li {
  display: grid;
  min-height: 52px;
  grid-template-columns: 64px 14px minmax(0, 1fr);
  gap: 11px;
  align-items: start;
}

.eval-bench__timeline time {
  padding-top: 2px;
  color: #778680;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  text-align: right;
}

.eval-bench__dot {
  position: relative;
  width: 10px;
  height: 10px;
  margin-top: 3px;
  border: 2px solid currentColor;
  border-radius: 50%;
}

.eval-bench__timeline li:not(:last-child) .eval-bench__dot::after {
  position: absolute;
  top: 10px;
  left: 2px;
  width: 2px;
  height: 42px;
  background: #2c3a36;
  content: "";
}

.eval-bench__timeline li.tone-neutral { color: #8ab7ff; }
.eval-bench__timeline li.tone-warning { color: #e9c75b; }
.eval-bench__timeline li.tone-success { color: #63d7b0; }
.eval-bench__timeline li.tone-failure { color: #ee826f; }
.eval-bench__timeline li > div { min-width: 0; }
.eval-bench__timeline strong { display: block; overflow-wrap: anywhere; color: #edf5f2; font-size: 13px; }
.eval-bench__timeline small { display: block; margin-top: 3px; overflow-wrap: anywhere; color: #85938f; font-family: var(--vp-font-family-mono); font-size: 10px; }

.eval-bench__grader {
  min-width: 0;
  padding: 28px 24px;
  background: #111b18;
}

.eval-bench__grader-head {
  display: flex;
  align-items: center;
  gap: 9px;
  color: #82918c;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
}

.eval-bench__grader > strong {
  display: block;
  margin-top: 24px;
  color: #edf5f2;
  font-family: var(--vp-font-family-mono);
  font-size: 34px;
}

.eval-bench__grader > p { min-height: 88px; margin: 12px 0 24px; color: #b8c5c1; font-size: 13px; line-height: 1.7; }
.eval-bench__grader dl { margin: 0; border-top: 1px solid #2c3a36; }
.eval-bench__grader dl > div { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 10px; padding: 11px 0; border-bottom: 1px solid #2c3a36; }
.eval-bench__grader dt { color: #778680; font-size: 10px; }
.eval-bench__grader dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #dce6e2; font-family: var(--vp-font-family-mono); font-size: 10px; }

@media (max-width: 760px) {
  .eval-bench__header { align-items: flex-start; flex-direction: column; gap: 16px; padding: 21px 20px; }
  .eval-bench__tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .eval-bench__tabs button:nth-child(2) { border-right: 0; }
  .eval-bench__tabs button:nth-child(-n + 2) { border-bottom: 1px solid #2c3a36; }
  .eval-bench__summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .eval-bench__summary > div:nth-child(3n) { border-right: 1px solid #2c3a36; }
  .eval-bench__summary > div:nth-child(2n) { border-right: 0; }
  .eval-bench__summary > div:nth-last-child(-n + 3) { border-bottom: 1px solid #2c3a36; }
  .eval-bench__summary > div:nth-last-child(-n + 2) { border-bottom: 0; }
  .eval-bench__body { grid-template-columns: 1fr; }
  .eval-bench__timeline { padding: 24px 17px; border-right: 0; border-bottom: 1px solid #2c3a36; }
  .eval-bench__timeline li { grid-template-columns: 54px 13px minmax(0, 1fr); gap: 8px; }
  .eval-bench__grader { padding: 26px 20px; }
}
</style>
