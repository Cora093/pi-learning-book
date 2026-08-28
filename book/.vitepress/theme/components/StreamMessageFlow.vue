<script setup lang="ts">
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from "@lucide/vue";
import { computed, onUnmounted, ref } from "vue";

type ScenarioId = "text" | "tool";

interface StreamStep {
  event: string;
  delta: string;
  phase: "准备" | "接收" | "定稿";
  message: string;
  detail: string;
  emitted: string;
  partial: boolean;
}

interface StreamScenario {
  id: ScenarioId;
  label: string;
  prompt: string;
  steps: StreamStep[];
}

const scenarios: StreamScenario[] = [
  {
    id: "text",
    label: "文本回答",
    prompt: "用户：北京今天冷吗？",
    steps: [
      {
        event: "message_start",
        delta: "尚未收到内容",
        phase: "准备",
        message: "（空）",
        detail: "先在消息数组末尾放入一个尚未完成的 AssistantMessage。",
        emitted: "message_start",
        partial: true,
      },
      {
        event: "text_delta",
        delta: '"北京"',
        phase: "接收",
        message: "北京",
        detail: "第一个文本片段到达，原来的临时消息被新版本替换。",
        emitted: "message_update",
        partial: true,
      },
      {
        event: "text_delta",
        delta: '"今天偏冷"',
        phase: "接收",
        message: "北京今天偏冷",
        detail: "第二个片段不是一条新消息，它继续更新同一个数组位置。",
        emitted: "message_update",
        partial: true,
      },
      {
        event: "text_delta",
        delta: '"，建议加外套。"',
        phase: "接收",
        message: "北京今天偏冷，建议加外套。",
        detail: "界面可以随着 message_update 刷新，但 transcript 仍只有一条 assistant 消息。",
        emitted: "message_update",
        partial: true,
      },
      {
        event: "stream end",
        delta: "最终 AssistantMessage",
        phase: "定稿",
        message: "北京今天偏冷，建议加外套。",
        detail: "最终消息替换临时版本，partial 状态结束。",
        emitted: "message_end",
        partial: false,
      },
    ],
  },
  {
    id: "tool",
    label: "工具调用",
    prompt: "用户：读取 config.json",
    steps: [
      {
        event: "message_start",
        delta: "尚未收到内容",
        phase: "准备",
        message: "（空）",
        detail: "工具调用同样从一条临时 AssistantMessage 开始。",
        emitted: "message_start",
        partial: true,
      },
      {
        event: "thinking_delta",
        delta: '"需要读取文件"',
        phase: "接收",
        message: "thinking: 需要读取文件",
        detail: "thinking 内容进入当前消息，并触发一次界面更新。",
        emitted: "message_update",
        partial: true,
      },
      {
        event: "toolcall_delta",
        delta: 'name: "read_file"',
        phase: "接收",
        message: "thinking: 需要读取文件\ntoolCall: read_file(…)",
        detail: "工具名先到达时，调用参数仍可能不完整。",
        emitted: "message_update",
        partial: true,
      },
      {
        event: "toolcall_delta",
        delta: 'arguments: { "path": "config.json" }',
        phase: "接收",
        message: 'thinking: 需要读取文件\ntoolCall: read_file({ "path": "config.json" })',
        detail: "后续片段补齐参数，仍然只替换同一个临时消息。",
        emitted: "message_update",
        partial: true,
      },
      {
        event: "stream end",
        delta: "最终 AssistantMessage",
        phase: "定稿",
        message: 'thinking: 需要读取文件\ntoolCall: read_file({ "path": "config.json" })',
        detail: "调用定稿后，runLoop() 才从最终消息中找出 toolCall 并执行。",
        emitted: "message_end",
        partial: false,
      },
    ],
  },
];

const selectedId = ref<ScenarioId>("text");
const currentIndex = ref(0);
const playing = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

const selectedScenario = computed(
  () => scenarios.find((scenario) => scenario.id === selectedId.value) ?? scenarios[0],
);
const currentStep = computed(() => selectedScenario.value.steps[currentIndex.value]);
const progress = computed(() => ((currentIndex.value + 1) / selectedScenario.value.steps.length) * 100);

function stopPlayback() {
  if (timer) clearInterval(timer);
  timer = undefined;
  playing.value = false;
}

function selectScenario(id: ScenarioId) {
  stopPlayback();
  selectedId.value = id;
  currentIndex.value = 0;
}

function previousStep() {
  stopPlayback();
  currentIndex.value = Math.max(0, currentIndex.value - 1);
}

function nextStep() {
  stopPlayback();
  currentIndex.value = Math.min(selectedScenario.value.steps.length - 1, currentIndex.value + 1);
}

function resetFlow() {
  stopPlayback();
  currentIndex.value = 0;
}

function goToStep(index: number) {
  stopPlayback();
  currentIndex.value = index;
}

function togglePlayback() {
  if (playing.value) {
    stopPlayback();
    return;
  }

  if (currentIndex.value === selectedScenario.value.steps.length - 1) currentIndex.value = 0;
  playing.value = true;
  timer = setInterval(() => {
    if (currentIndex.value >= selectedScenario.value.steps.length - 1) {
      stopPlayback();
      return;
    }
    currentIndex.value += 1;
  }, 1150);
}

onUnmounted(stopPlayback);
</script>

<template>
  <section class="stream-flow" aria-labelledby="stream-flow-title">
    <header class="stream-flow__header">
      <div>
        <span class="stream-flow__eyebrow">MESSAGE SLOT · AL-03</span>
        <h2 id="stream-flow-title">看着一条消息慢慢定稿</h2>
      </div>
      <div class="stream-flow__scenarios" role="tablist" aria-label="选择流式响应场景">
        <button
          v-for="scenario in scenarios"
          :key="scenario.id"
          type="button"
          role="tab"
          :aria-selected="selectedId === scenario.id"
          :class="{ 'is-selected': selectedId === scenario.id }"
          @click="selectScenario(scenario.id)"
        >
          {{ scenario.label }}
        </button>
      </div>
    </header>

    <div class="stream-flow__prompt">{{ selectedScenario.prompt }}</div>

    <div class="stream-flow__stage" aria-live="polite">
      <div class="stream-flow__incoming">
        <span class="stream-flow__label">本步收到</span>
        <strong>{{ currentStep.event }}</strong>
        <code>{{ currentStep.delta }}</code>
      </div>

      <div class="stream-flow__message">
        <div class="stream-flow__message-head">
          <span>context.messages[last]</span>
          <span :class="{ 'is-final': !currentStep.partial }">
            {{ currentStep.partial ? "PARTIAL" : "FINAL" }}
          </span>
        </div>
        <div class="stream-flow__message-body">
          <span class="stream-flow__role">assistant</span>
          <p>{{ currentStep.message }}</p>
        </div>
      </div>

      <div class="stream-flow__outgoing">
        <span class="stream-flow__label">对外发出</span>
        <strong>{{ currentStep.emitted }}</strong>
        <p>{{ currentStep.detail }}</p>
      </div>
    </div>

    <ol class="stream-flow__steps" aria-label="流式消息处理步骤">
      <li
        v-for="(step, index) in selectedScenario.steps"
        :key="`${selectedScenario.id}-${step.event}-${index}`"
        :class="{ 'is-current': index === currentIndex, 'is-complete': index < currentIndex }"
      >
        <button type="button" :aria-label="`查看第 ${index + 1} 步：${step.event}`" @click="goToStep(index)">
          <span>{{ index + 1 }}</span>
          <small>{{ step.phase }}</small>
        </button>
      </li>
    </ol>

    <footer class="stream-flow__controls">
      <div class="stream-flow__progress" aria-hidden="true">
        <span :style="{ width: `${progress}%` }"></span>
      </div>
      <div class="stream-flow__buttons">
        <button type="button" title="回到开头" aria-label="回到开头" @click="resetFlow">
          <RotateCcw :size="17" aria-hidden="true" />
        </button>
        <button type="button" title="上一步" aria-label="上一步" :disabled="currentIndex === 0" @click="previousStep">
          <ChevronLeft :size="19" aria-hidden="true" />
        </button>
        <button type="button" class="stream-flow__play" :title="playing ? '暂停' : '播放'" :aria-label="playing ? '暂停' : '播放'" @click="togglePlayback">
          <Pause v-if="playing" :size="18" aria-hidden="true" />
          <Play v-else :size="18" aria-hidden="true" />
        </button>
        <button
          type="button"
          title="下一步"
          aria-label="下一步"
          :disabled="currentIndex === selectedScenario.steps.length - 1"
          @click="nextStep"
        >
          <ChevronRight :size="19" aria-hidden="true" />
        </button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.stream-flow {
  margin: 42px 0 54px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}

.stream-flow__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 26px 20px;
  border-bottom: 1px solid var(--vp-c-divider);
}

.stream-flow__eyebrow,
.stream-flow__label,
.stream-flow__message-head,
.stream-flow__role {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 700;
}

.stream-flow__eyebrow {
  color: var(--vp-c-brand-1);
}

.stream-flow__header h2 {
  margin: 7px 0 0;
  border: 0;
  font-family: "Palatino Linotype", Georgia, serif;
  font-size: 29px;
  line-height: 1.18;
}

.stream-flow__scenarios {
  display: inline-flex;
  flex: 0 0 auto;
  min-height: 38px;
  padding: 3px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
}

.stream-flow button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  color: var(--vp-c-text-2);
  background: transparent;
  cursor: pointer;
}

.stream-flow__scenarios button {
  min-height: 30px;
  padding: 0 13px;
  border-radius: 4px;
  font-size: 12px;
}

.stream-flow__scenarios button:hover,
.stream-flow__scenarios button.is-selected {
  color: var(--prb-ink);
  background: var(--prb-mint);
}

.stream-flow__prompt {
  padding: 13px 26px;
  border-bottom: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
  font-size: 13px;
}

.stream-flow__stage {
  display: grid;
  grid-template-columns: minmax(150px, 0.62fr) minmax(280px, 1.25fr) minmax(190px, 0.83fr);
  min-height: 250px;
}

.stream-flow__incoming,
.stream-flow__outgoing,
.stream-flow__message {
  min-width: 0;
  padding: 28px 24px;
}

.stream-flow__incoming,
.stream-flow__message {
  border-right: 1px solid var(--vp-c-divider);
}

.stream-flow__label {
  display: block;
  margin-bottom: 20px;
  color: var(--vp-c-text-3);
}

.stream-flow__incoming strong,
.stream-flow__outgoing strong {
  display: block;
  overflow-wrap: anywhere;
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
}

.stream-flow__incoming code {
  display: block;
  margin-top: 14px;
  padding: 0;
  overflow-wrap: anywhere;
  color: var(--vp-c-brand-1);
  background: transparent;
  font-size: 12px;
  line-height: 1.7;
  white-space: normal;
}

.stream-flow__message {
  background: var(--vp-c-bg);
}

.stream-flow__message-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--vp-c-text-3);
}

.stream-flow__message-head span:last-child {
  color: #9a6700;
}

.stream-flow__message-head span.is-final {
  color: var(--vp-c-brand-1);
}

.stream-flow__message-body {
  min-height: 128px;
  margin-top: 18px;
  padding: 18px;
  border-left: 3px solid var(--prb-yellow);
  background: color-mix(in srgb, var(--prb-yellow) 9%, var(--vp-c-bg));
}

.stream-flow__role {
  color: var(--vp-c-text-3);
}

.stream-flow__message-body p {
  margin: 12px 0 0;
  overflow-wrap: anywhere;
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-line;
}

.stream-flow__outgoing p {
  min-height: 90px;
  margin: 16px 0 0;
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.stream-flow__steps {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin: 0;
  padding: 0 22px 18px;
  list-style: none;
}

.stream-flow__steps li {
  position: relative;
}

.stream-flow__steps li::before {
  position: absolute;
  top: 17px;
  right: 50%;
  left: -50%;
  height: 1px;
  content: "";
  background: var(--vp-c-divider);
}

.stream-flow__steps li:first-child::before {
  display: none;
}

.stream-flow__steps button {
  position: relative;
  z-index: 1;
  display: grid;
  width: 100%;
  justify-items: center;
  gap: 5px;
}

.stream-flow__steps button > span {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid var(--vp-c-divider);
  border-radius: 50%;
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
}

.stream-flow__steps small {
  font-size: 11px;
}

.stream-flow__steps li.is-complete button > span,
.stream-flow__steps li.is-current button > span {
  color: var(--prb-ink);
  background: var(--prb-mint);
  border-color: var(--prb-mint);
}

.stream-flow__steps li.is-current small {
  color: var(--vp-c-text-1);
  font-weight: 700;
}

.stream-flow__controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 24px;
  padding: 14px 22px;
  border-top: 1px solid var(--vp-c-divider);
}

.stream-flow__progress {
  height: 3px;
  overflow: hidden;
  background: var(--vp-c-divider);
}

.stream-flow__progress span {
  display: block;
  height: 100%;
  background: var(--vp-c-brand-1);
  transition: width 180ms ease;
}

.stream-flow__buttons {
  display: flex;
  gap: 4px;
}

.stream-flow__buttons button {
  width: 34px;
  height: 34px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
}

.stream-flow__buttons button:hover:not(:disabled) {
  color: var(--prb-ink);
  background: var(--prb-mint);
  border-color: var(--prb-mint);
}

.stream-flow__buttons button:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.stream-flow__buttons .stream-flow__play {
  color: var(--prb-ink);
  background: var(--prb-mint);
  border-color: var(--prb-mint);
}

@media (max-width: 840px) {
  .stream-flow__header {
    align-items: flex-start;
    flex-direction: column;
    padding: 22px 18px 18px;
  }

  .stream-flow__scenarios {
    width: 100%;
  }

  .stream-flow__scenarios button {
    flex: 1;
  }

  .stream-flow__prompt {
    padding: 13px 18px;
  }

  .stream-flow__stage {
    grid-template-columns: 1fr;
  }

  .stream-flow__incoming,
  .stream-flow__message {
    border-right: 0;
    border-bottom: 1px solid var(--vp-c-divider);
  }

  .stream-flow__incoming,
  .stream-flow__outgoing,
  .stream-flow__message {
    padding: 22px 18px;
  }

  .stream-flow__message-body,
  .stream-flow__outgoing p {
    min-height: 0;
  }

  .stream-flow__steps {
    padding: 0 10px 18px;
  }

  .stream-flow__steps small {
    font-size: 10px;
  }

  .stream-flow__controls {
    grid-template-columns: 1fr;
    gap: 14px;
  }

  .stream-flow__buttons {
    justify-content: center;
  }
}
</style>
