<script setup lang="ts">
import {
  ChevronLeft,
  ChevronRight,
  CircleStop,
  FastForward,
  MessageSquareMore,
  Pause,
  Play,
  RotateCcw,
  Wrench,
} from "@lucide/vue";
import { computed, onUnmounted, ref, watch } from "vue";

type StepTone = "run" | "turn" | "message" | "tool" | "queue" | "stop";

interface TraceStep {
  event: string;
  title: string;
  detail: string;
  lane: string;
  tone: StepTone;
  context: string;
}

interface TraceScenario {
  id: string;
  label: string;
  summary: string;
  icon: typeof CircleStop;
  steps: TraceStep[];
}

const scenarios: TraceScenario[] = [
  {
    id: "answer",
    label: "直接回答",
    summary: "一个 Run 只包含一个 Turn；模型没有发出 toolCall。",
    icon: CircleStop,
    steps: [
      { event: "agent_start", title: "Run 开始", detail: "低层循环发出运行边界事件。", lane: "RUN", tone: "run", context: "0 条消息" },
      { event: "turn_start", title: "Turn 01", detail: "第一次模型请求即将开始。", lane: "TURN", tone: "turn", context: "0 条消息" },
      { event: "message_end · user", title: "写入问题", detail: "用户消息进入当前上下文。", lane: "MESSAGE", tone: "message", context: "user" },
      { event: "message_start · assistant", title: "开始流式响应", detail: "partial assistant message 先进入上下文。", lane: "MESSAGE", tone: "message", context: "user → assistant*" },
      { event: "message_update", title: "增量到达", detail: "文本、thinking 或 tool call 增量持续替换 partial。", lane: "MESSAGE", tone: "message", context: "user → assistant*" },
      { event: "message_end · assistant", title: "响应定稿", detail: "最终 AssistantMessage 替换 partial，stopReason=stop。", lane: "MESSAGE", tone: "message", context: "user → assistant" },
      { event: "turn_end", title: "Turn 结束", detail: "本 Turn 没有 tool result。", lane: "TURN", tone: "turn", context: "user → assistant" },
      { event: "agent_end", title: "Run 事件结束", detail: "没有 steering 或 follow-up，循环退出。", lane: "RUN", tone: "stop", context: "user → assistant" },
    ],
  },
  {
    id: "tool",
    label: "工具循环",
    summary: "一个 Run 包含两个 Turn；tool result 成为下一次模型请求的输入。",
    icon: Wrench,
    steps: [
      { event: "agent_start", title: "Run 开始", detail: "一次 prompt() 对应一个活动 Run。", lane: "RUN", tone: "run", context: "0 条消息" },
      { event: "turn_start", title: "Turn 01", detail: "第一轮模型请求开始。", lane: "TURN", tone: "turn", context: "0 条消息" },
      { event: "message_end · user", title: "写入问题", detail: "例：读取 config.json。", lane: "MESSAGE", tone: "message", context: "user" },
      { event: "message_end · assistant", title: "模型请求工具", detail: "AssistantMessage.content 中出现 toolCall。", lane: "MESSAGE", tone: "message", context: "user → assistant(toolCall)" },
      { event: "tool_execution_start", title: "工具预检", detail: "查找工具、准备参数、schema 校验、beforeToolCall。", lane: "TOOL", tone: "tool", context: "user → assistant(toolCall)" },
      { event: "tool_execution_update", title: "工具进度", detail: "execute() 可以选择推送部分结果。", lane: "TOOL", tone: "tool", context: "user → assistant(toolCall)" },
      { event: "tool_execution_end", title: "工具完成", detail: "结果经过 afterToolCall 后发出完成事件。", lane: "TOOL", tone: "tool", context: "user → assistant(toolCall)" },
      { event: "message_end · toolResult", title: "结果进入记录", detail: "ToolResultMessage 被追加到上下文。", lane: "MESSAGE", tone: "message", context: "user → assistant → toolResult" },
      { event: "turn_end", title: "Turn 01 结束", detail: "这个 Turn 包含 assistant response 和工具执行。", lane: "TURN", tone: "turn", context: "user → assistant → toolResult" },
      { event: "turn_start", title: "Turn 02", detail: "toolCall 让内层循环继续。", lane: "TURN", tone: "turn", context: "user → assistant → toolResult" },
      { event: "message_start · assistant", title: "再次请求模型", detail: "模型现在能看到 tool result。", lane: "MESSAGE", tone: "message", context: "user → assistant → toolResult → assistant*" },
      { event: "message_update", title: "生成最终回答", detail: "响应继续以增量事件更新。", lane: "MESSAGE", tone: "message", context: "user → assistant → toolResult → assistant*" },
      { event: "message_end · assistant", title: "响应定稿", detail: "没有新的 toolCall。", lane: "MESSAGE", tone: "message", context: "user → assistant → toolResult → assistant" },
      { event: "turn_end", title: "Turn 02 结束", detail: "工具循环到此收敛。", lane: "TURN", tone: "turn", context: "user → assistant → toolResult → assistant" },
      { event: "agent_end", title: "Run 事件结束", detail: "没有后续队列消息，运行退出。", lane: "RUN", tone: "stop", context: "user → assistant → toolResult → assistant" },
    ],
  },
  {
    id: "queue",
    label: "队列消息",
    summary: "Steering 在当前工具批次之后注入；follow-up 在循环本来要停时注入。",
    icon: MessageSquareMore,
    steps: [
      { event: "agent_start", title: "Run 开始", detail: "运行边界建立。", lane: "RUN", tone: "run", context: "user" },
      { event: "turn_start", title: "Turn 01", detail: "模型返回一批 tool calls。", lane: "TURN", tone: "turn", context: "user" },
      { event: "message_end · assistant", title: "工具请求定稿", detail: "此时用户又排入一条 steering。", lane: "MESSAGE", tone: "message", context: "user → assistant(toolCalls)" },
      { event: "tool_execution_end × N", title: "先完成整批工具", detail: "Steering 不会跳过当前 assistant message 已经发出的工具。", lane: "TOOL", tone: "tool", context: "user → assistant(toolCalls)" },
      { event: "message_end · toolResult × N", title: "写入全部结果", detail: "结果按 assistant 源顺序进入上下文。", lane: "MESSAGE", tone: "message", context: "user → assistant → toolResults" },
      { event: "turn_end", title: "Turn 01 结束", detail: "直到这里才轮询 steering。", lane: "TURN", tone: "turn", context: "user → assistant → toolResults" },
      { event: "getSteeringMessages", title: "注入 Steering", detail: "消息在下一次模型请求前写入上下文。", lane: "QUEUE", tone: "queue", context: "… → toolResults → steering" },
      { event: "turn_start", title: "Turn 02", detail: "模型处理修正后的方向。", lane: "TURN", tone: "turn", context: "… → steering" },
      { event: "message_end · assistant", title: "暂时收敛", detail: "无新工具、无新 steering。", lane: "MESSAGE", tone: "message", context: "… → steering → assistant" },
      { event: "turn_end", title: "Turn 02 结束", detail: "内层循环准备退出。", lane: "TURN", tone: "turn", context: "… → steering → assistant" },
      { event: "getFollowUpMessages", title: "注入 Follow-up", detail: "只在 Agent 本来要停止时检查。", lane: "QUEUE", tone: "queue", context: "… → assistant → followUp" },
      { event: "turn_start", title: "Turn 03", detail: "同一个 Run 继续处理追加工作。", lane: "TURN", tone: "turn", context: "… → followUp" },
      { event: "message_end · assistant", title: "追加工作完成", detail: "模型给出最后响应。", lane: "MESSAGE", tone: "message", context: "… → followUp → assistant" },
      { event: "turn_end", title: "Turn 03 结束", detail: "两个队列都为空。", lane: "TURN", tone: "turn", context: "… → followUp → assistant" },
      { event: "agent_end", title: "Run 事件结束", detail: "外层循环最终退出。", lane: "RUN", tone: "stop", context: "完整 transcript" },
    ],
  },
];

const selectedId = ref("tool");
const currentIndex = ref(0);
const playing = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

const selectedScenario = computed(() => scenarios.find((scenario) => scenario.id === selectedId.value) ?? scenarios[0]);
const currentStep = computed(() => selectedScenario.value.steps[currentIndex.value]);
const progress = computed(() => ((currentIndex.value + 1) / selectedScenario.value.steps.length) * 100);

function stopPlayback() {
  if (timer) clearInterval(timer);
  timer = undefined;
  playing.value = false;
}

function selectScenario(id: string) {
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

function resetTrace() {
  stopPlayback();
  currentIndex.value = 0;
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
  }, 900);
}

watch(selectedId, stopPlayback);
onUnmounted(stopPlayback);
</script>

<template>
  <section class="loop-trace" aria-labelledby="loop-trace-title">
    <header class="loop-trace__header">
      <div>
        <span class="loop-trace__eyebrow">EVENT TRACE · PI v0.84.3</span>
        <h2 id="loop-trace-title">把一次 Run 拆开看</h2>
      </div>
      <div class="loop-trace__scenarios" role="tablist" aria-label="选择运行场景">
        <button
          v-for="scenario in scenarios"
          :key="scenario.id"
          type="button"
          role="tab"
          :aria-selected="selectedId === scenario.id"
          :class="{ 'is-selected': selectedId === scenario.id }"
          @click="selectScenario(scenario.id)"
        >
          <component :is="scenario.icon" :size="16" aria-hidden="true" />
          <span>{{ scenario.label }}</span>
        </button>
      </div>
    </header>

    <p class="loop-trace__summary">{{ selectedScenario.summary }}</p>

    <div class="loop-trace__stage">
      <ol class="loop-trace__rail" aria-label="事件顺序">
        <li
          v-for="(step, index) in selectedScenario.steps"
          :key="`${selectedScenario.id}-${step.event}-${index}`"
          :class="[`tone-${step.tone}`, { 'is-current': index === currentIndex, 'is-complete': index < currentIndex }]"
        >
          <span class="loop-trace__index">{{ String(index + 1).padStart(2, "0") }}</span>
          <span class="loop-trace__marker" aria-hidden="true"></span>
          <span class="loop-trace__event">{{ step.event }}</span>
          <span class="loop-trace__lane">{{ step.lane }}</span>
        </li>
      </ol>

      <aside class="loop-trace__inspector" aria-live="polite">
        <span class="loop-trace__counter">STEP {{ currentIndex + 1 }} / {{ selectedScenario.steps.length }}</span>
        <h3>{{ currentStep.title }}</h3>
        <p>{{ currentStep.detail }}</p>
        <dl>
          <div>
            <dt>事件</dt>
            <dd>{{ currentStep.event }}</dd>
          </div>
          <div>
            <dt>上下文</dt>
            <dd>{{ currentStep.context }}</dd>
          </div>
        </dl>
      </aside>
    </div>

    <footer class="loop-trace__controls">
      <div class="loop-trace__progress" aria-hidden="true">
        <span :style="{ width: `${progress}%` }"></span>
      </div>
      <div class="loop-trace__buttons">
        <button type="button" title="回到开头" aria-label="回到开头" @click="resetTrace">
          <RotateCcw :size="17" aria-hidden="true" />
        </button>
        <button type="button" title="上一步" aria-label="上一步" :disabled="currentIndex === 0" @click="previousStep">
          <ChevronLeft :size="19" aria-hidden="true" />
        </button>
        <button type="button" class="loop-trace__play" :title="playing ? '暂停' : '播放'" :aria-label="playing ? '暂停' : '播放'" @click="togglePlayback">
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
        <button type="button" title="跳到结尾" aria-label="跳到结尾" @click="currentIndex = selectedScenario.steps.length - 1">
          <FastForward :size="17" aria-hidden="true" />
        </button>
      </div>
    </footer>
  </section>
</template>
