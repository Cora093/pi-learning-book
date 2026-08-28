<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Braces, Check, CircleAlert, CircleX, FileOutput, ShieldX, Wrench } from "@lucide/vue";

type StepState = "pass" | "error" | "skip" | "info";

interface PipelineStep {
  label: string;
  symbol: string;
  state: StepState;
  detail: string;
  value: string;
}

interface Scenario {
  id: string;
  label: string;
  icon: typeof Check;
  call: string;
  outcome: string;
  isError: boolean;
  steps: PipelineStep[];
}

const scenarios: Scenario[] = [
  {
    id: "success",
    label: "成功",
    icon: Check,
    call: 'read_file({ path: "config.json" })',
    outcome: 'content: [{ type: "text", text: "{...}" }]',
    isError: false,
    steps: [
      { label: "查找", symbol: "tools.find(name)", state: "pass", detail: "按 name 精确找到 AgentTool。", value: "read_file" },
      { label: "兼容准备", symbol: "prepareArguments?", state: "info", detail: "没有兼容 shim，原始 arguments 原样进入校验。", value: '{ path: "config.json" }' },
      { label: "本地校验", symbol: "validateToolArguments", state: "pass", detail: "TypeBox schema 校验通过，并返回一份 clone。", value: '{ path: "config.json" }' },
      { label: "执行前策略", symbol: "beforeToolCall?", state: "pass", detail: "策略允许执行。hook 收到的是已校验参数。", value: "allow" },
      { label: "执行", symbol: "AgentTool.execute", state: "pass", detail: "工具收到 call id、参数、AbortSignal 和更新回调。", value: "Promise<AgentToolResult>" },
      { label: "执行后策略", symbol: "afterToolCall?", state: "pass", detail: "结果 envelope 未被覆盖。", value: "unchanged" },
      { label: "落入历史", symbol: "createToolResultMessage", state: "pass", detail: "最终结果被转成模型可见的 ToolResultMessage。", value: "role: toolResult" },
    ],
  },
  {
    id: "unknown",
    label: "未知工具",
    icon: CircleAlert,
    call: "delete_database({})",
    outcome: 'content: [{ type: "text", text: "Tool delete_database not found" }]',
    isError: true,
    steps: [
      { label: "查找", symbol: "tools.find(name)", state: "error", detail: "当前 Context.tools 中不存在这个 name。", value: "not found" },
      { label: "兼容准备", symbol: "prepareArguments?", state: "skip", detail: "没有目标工具，后续准备阶段不会运行。", value: "skipped" },
      { label: "本地校验", symbol: "validateToolArguments", state: "skip", detail: "未知工具没有 schema 可校验。", value: "skipped" },
      { label: "执行前策略", symbol: "beforeToolCall?", state: "skip", detail: "未知工具不会进入 hook。", value: "skipped" },
      { label: "执行", symbol: "AgentTool.execute", state: "skip", detail: "没有执行任何外部副作用。", value: "not called" },
      { label: "执行后策略", symbol: "afterToolCall?", state: "skip", detail: "没有已执行工具，因此不会运行。", value: "skipped" },
      { label: "落入历史", symbol: "createToolResultMessage", state: "error", detail: "错误仍被包装成 ToolResultMessage，让模型能够纠正调用。", value: "isError: true" },
    ],
  },
  {
    id: "invalid",
    label: "参数错误",
    icon: Braces,
    call: "read_file({ path: 42 })",
    outcome: 'content: [{ type: "text", text: "Validation failed..." }]',
    isError: true,
    steps: [
      { label: "查找", symbol: "tools.find(name)", state: "pass", detail: "工具存在。", value: "read_file" },
      { label: "兼容准备", symbol: "prepareArguments?", state: "info", detail: "兼容 shim 可以在 schema 校验前修整旧格式。", value: '{ path: 42 }' },
      { label: "本地校验", symbol: "validateToolArguments", state: "error", detail: "path 应是 string，本地校验拒绝参数。", value: "validation error" },
      { label: "执行前策略", symbol: "beforeToolCall?", state: "skip", detail: "校验失败时不会进入策略 hook。", value: "skipped" },
      { label: "执行", symbol: "AgentTool.execute", state: "skip", detail: "无效参数不会触发工具副作用。", value: "not called" },
      { label: "执行后策略", symbol: "afterToolCall?", state: "skip", detail: "工具没有执行。", value: "skipped" },
      { label: "落入历史", symbol: "createToolResultMessage", state: "error", detail: "校验异常被归一化为模型可见错误。", value: "isError: true" },
    ],
  },
  {
    id: "blocked",
    label: "策略阻止",
    icon: ShieldX,
    call: 'write_file({ path: ".env", content: "..." })',
    outcome: 'content: [{ type: "text", text: "Blocked by policy" }]',
    isError: true,
    steps: [
      { label: "查找", symbol: "tools.find(name)", state: "pass", detail: "write_file 已注册。", value: "write_file" },
      { label: "兼容准备", symbol: "prepareArguments?", state: "info", detail: "参数无需兼容转换。", value: "unchanged" },
      { label: "本地校验", symbol: "validateToolArguments", state: "pass", detail: "参数结构合法不代表操作被授权。", value: "valid" },
      { label: "执行前策略", symbol: "beforeToolCall?", state: "error", detail: "策略层返回 block，阻止写入敏感文件。", value: "block: true" },
      { label: "执行", symbol: "AgentTool.execute", state: "skip", detail: "被阻止的工具不会执行。", value: "not called" },
      { label: "执行后策略", symbol: "afterToolCall?", state: "skip", detail: "没有执行结果可后处理。", value: "skipped" },
      { label: "落入历史", symbol: "createToolResultMessage", state: "error", detail: "阻止原因通过错误 ToolResult 回到 transcript。", value: "isError: true" },
    ],
  },
  {
    id: "throw",
    label: "执行异常",
    icon: CircleX,
    call: 'http_get({ url: "https://example.invalid" })',
    outcome: 'content: [{ type: "text", text: "DNS lookup failed" }]',
    isError: true,
    steps: [
      { label: "查找", symbol: "tools.find(name)", state: "pass", detail: "工具存在。", value: "http_get" },
      { label: "兼容准备", symbol: "prepareArguments?", state: "info", detail: "参数原样通过。", value: "unchanged" },
      { label: "本地校验", symbol: "validateToolArguments", state: "pass", detail: "URL 字段满足 schema。", value: "valid" },
      { label: "执行前策略", symbol: "beforeToolCall?", state: "pass", detail: "策略允许访问。", value: "allow" },
      { label: "执行", symbol: "AgentTool.execute", state: "error", detail: "execute 抛出的异常被 runtime 捕获。", value: "throw Error" },
      { label: "执行后策略", symbol: "afterToolCall?", state: "info", detail: "after hook 仍会看到 isError=true，并可覆盖最终 envelope。", value: "observed error" },
      { label: "落入历史", symbol: "createToolResultMessage", state: "error", detail: "异常文本被转成标准错误结果，Loop 本身继续工作。", value: "isError: true" },
    ],
  },
];

const activeScenarioId = ref(scenarios[0].id);
const activeStepIndex = ref(0);
const activeScenario = computed(() => scenarios.find((scenario) => scenario.id === activeScenarioId.value) ?? scenarios[0]);
const activeStep = computed(() => activeScenario.value.steps[activeStepIndex.value]);

watch(activeScenarioId, () => {
  activeStepIndex.value = 0;
});
</script>

<template>
  <section class="tool-pipeline" aria-labelledby="tool-pipeline-title">
    <header>
      <div>
        <span class="tool-pipeline__eyebrow">TOOL CALL PIPELINE</span>
        <h2 id="tool-pipeline-title">一次调用，七道边界</h2>
      </div>
      <div class="tool-pipeline__scenarios" aria-label="工具调用场景">
        <button
          v-for="scenario in scenarios"
          :key="scenario.id"
          type="button"
          :class="{ 'is-active': scenario.id === activeScenarioId }"
          @click="activeScenarioId = scenario.id"
        >
          <component :is="scenario.icon" :size="15" aria-hidden="true" />
          <span>{{ scenario.label }}</span>
        </button>
      </div>
    </header>

    <div class="tool-pipeline__call">
      <Wrench :size="16" aria-hidden="true" />
      <code>{{ activeScenario.call }}</code>
    </div>

    <div class="tool-pipeline__body">
      <ol class="tool-pipeline__steps">
        <li v-for="(step, index) in activeScenario.steps" :key="step.symbol">
          <button
            type="button"
            :class="[`state-${step.state}`, { 'is-active': index === activeStepIndex }]"
            @click="activeStepIndex = index"
          >
            <span class="tool-pipeline__index">{{ String(index + 1).padStart(2, "0") }}</span>
            <span class="tool-pipeline__step-copy"><strong>{{ step.label }}</strong><code>{{ step.symbol }}</code></span>
            <span class="tool-pipeline__state">{{ step.state }}</span>
          </button>
        </li>
      </ol>

      <aside class="tool-pipeline__inspector" aria-live="polite">
        <span class="tool-pipeline__eyebrow">{{ activeStep.symbol }}</span>
        <h3>{{ activeStep.label }}</h3>
        <p>{{ activeStep.detail }}</p>
        <dl>
          <div><dt>当前值</dt><dd>{{ activeStep.value }}</dd></div>
          <div><dt>最终结果</dt><dd :class="{ 'is-error': activeScenario.isError }">{{ activeScenario.outcome }}</dd></div>
        </dl>
        <div class="tool-pipeline__artifact">
          <FileOutput :size="18" aria-hidden="true" />
          <span>ToolResultMessage</span>
          <strong>{{ activeScenario.isError ? "ERROR" : "OK" }}</strong>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.tool-pipeline {
  margin: 42px 0 54px;
  overflow: hidden;
  border: 1px solid #31423e;
  border-radius: 8px;
  background: #0a100f;
  color: #f2f0e9;
  box-shadow: 0 24px 64px rgba(10, 16, 15, 0.18);
}

.tool-pipeline > header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 26px 28px 22px;
  border-bottom: 1px solid #31423e;
}

.tool-pipeline__eyebrow {
  color: #8de6c0;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 700;
}

.tool-pipeline h2,
.tool-pipeline h3 {
  border: 0;
  color: #f2f0e9;
  font-family: "Palatino Linotype", Georgia, serif;
}

.tool-pipeline h2 {
  margin: 7px 0 0;
  font-size: 30px;
}

.tool-pipeline__scenarios {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}

.tool-pipeline button {
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.tool-pipeline__scenarios button {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid #31423e;
  border-radius: 4px;
  background: transparent;
  color: #aebbb7;
  font-size: 12px;
}

.tool-pipeline__scenarios button:hover,
.tool-pipeline__scenarios button.is-active {
  border-color: #8de6c0;
  background: #8de6c0;
  color: #0a100f;
}

.tool-pipeline__call {
  display: flex;
  min-height: 48px;
  align-items: center;
  gap: 10px;
  padding: 12px 28px;
  border-bottom: 1px solid #31423e;
  color: #f0cd6a;
}

.tool-pipeline__call code {
  overflow-wrap: anywhere;
  color: inherit;
  font-size: 12px;
}

.tool-pipeline__body {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(280px, 0.92fr);
  min-height: 520px;
}

.tool-pipeline__steps {
  margin: 0;
  padding: 16px 0;
  border-right: 1px solid #31423e;
  list-style: none;
}

.tool-pipeline__steps li {
  margin: 0;
}

.tool-pipeline__steps button {
  display: grid;
  width: 100%;
  min-height: 64px;
  grid-template-columns: 38px minmax(0, 1fr) 50px;
  align-items: center;
  gap: 10px;
  padding: 8px 22px;
  border: 0;
  border-left: 3px solid transparent;
  background: transparent;
  text-align: left;
}

.tool-pipeline__steps button:hover,
.tool-pipeline__steps button.is-active {
  border-left-color: #8de6c0;
  background: #17221f;
}

.tool-pipeline__index,
.tool-pipeline__state,
.tool-pipeline__step-copy code {
  font-family: var(--vp-font-family-mono);
}

.tool-pipeline__index {
  color: #71807c;
  font-size: 11px;
}

.tool-pipeline__step-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.tool-pipeline__step-copy strong {
  font-size: 14px;
}

.tool-pipeline__step-copy code {
  overflow: hidden;
  color: #82908c;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-pipeline__state {
  font-size: 9px;
  font-weight: 700;
  text-align: right;
  text-transform: uppercase;
}

.state-pass .tool-pipeline__state { color: #8de6c0; }
.state-error .tool-pipeline__state { color: #ff8c78; }
.state-skip .tool-pipeline__state { color: #71807c; }
.state-info .tool-pipeline__state { color: #f0cd6a; }

.tool-pipeline__inspector {
  min-width: 0;
  padding: 34px 30px;
  background: #0d1513;
}

.tool-pipeline__inspector h3 {
  margin: 18px 0 12px;
  font-size: 30px;
}

.tool-pipeline__inspector > p {
  min-height: 82px;
  margin: 0;
  color: #aebbb7;
  line-height: 1.7;
}

.tool-pipeline__inspector dl {
  margin: 30px 0 0;
  border-top: 1px solid #31423e;
}

.tool-pipeline__inspector dl > div {
  padding: 16px 0;
  border-bottom: 1px solid #31423e;
}

.tool-pipeline__inspector dt {
  margin-bottom: 7px;
  color: #71807c;
  font-size: 11px;
}

.tool-pipeline__inspector dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  line-height: 1.6;
}

.tool-pipeline__inspector dd.is-error {
  color: #ff8c78;
}

.tool-pipeline__artifact {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin-top: 28px;
  padding: 14px;
  border: 1px solid #31423e;
  border-radius: 5px;
  color: #8de6c0;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
}

.tool-pipeline__artifact strong {
  color: #f2f0e9;
}

@media (max-width: 760px) {
  .tool-pipeline > header {
    align-items: flex-start;
    flex-direction: column;
    padding: 22px 18px 18px;
  }

  .tool-pipeline__scenarios {
    display: grid;
    width: 100%;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .tool-pipeline__scenarios button {
    justify-content: center;
  }

  .tool-pipeline__call {
    padding: 12px 18px;
  }

  .tool-pipeline__body {
    grid-template-columns: 1fr;
  }

  .tool-pipeline__steps {
    border-right: 0;
    border-bottom: 1px solid #31423e;
  }

  .tool-pipeline__steps button {
    padding: 8px 16px;
  }

  .tool-pipeline__inspector {
    min-height: 390px;
    padding: 28px 20px;
  }
}
</style>
