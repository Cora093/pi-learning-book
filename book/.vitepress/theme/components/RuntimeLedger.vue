<script setup lang="ts">
import { computed, ref } from "vue";
import { Activity, AppWindow, Check, Database, GitBranch, History, Play, RotateCcw } from "@lucide/vue";

type ScenarioId = "running" | "settled" | "resume" | "branch";
type Tone = "live" | "durable" | "external";

interface Plane {
  label: string;
  owner: string;
  state: string;
  detail: string;
  tone: Tone;
  icon: typeof Activity;
}

interface Scenario {
  id: ScenarioId;
  label: string;
  caption: string;
  signal: string;
  eventLog: string[];
  planes: Plane[];
}

const scenarios: Scenario[] = [
  {
    id: "running",
    label: "运行中",
    caption: "Tool 还在执行；内存状态领先于最后一条持久记录。",
    signal: "isStreaming = true",
    eventLog: ["turn_start", "message_end(user)", "tool_execution_start"],
    planes: [
      { label: "Run 内存状态", owner: "Agent", state: "active Run", detail: "streamingMessage 与 pendingToolCallIds 仍在变化。", tone: "live", icon: Activity },
      { label: "Session 持久记录", owner: "SessionManager", state: "leaf = user-17", detail: "尚未出现本次 assistant/toolResult 的完整 entry。", tone: "durable", icon: Database },
      { label: "Application 业务状态", owner: "Host", state: "task = executing", detail: "审批单、路由和 UI 状态仍由宿主维护。", tone: "external", icon: AppWindow },
    ],
  },
  {
    id: "settled",
    label: "已稳定",
    caption: "最后一个 Core Run 及其订阅者已经结算，Session 不再自动续跑。",
    signal: "agent_settled",
    eventLog: ["agent_end", "append message entry", "await subscribers", "agent_settled"],
    planes: [
      { label: "Run 内存状态", owner: "Agent", state: "idle", detail: "activeRun 已清空，waitForIdle 已 resolve。", tone: "live", icon: Check },
      { label: "Session 持久记录", owner: "SessionManager", state: "leaf = assistant-21", detail: "message_end 对应的 entry 已追加到当前 leaf。", tone: "durable", icon: Database },
      { label: "Application 业务状态", owner: "Host", state: "task = review", detail: "宿主可在稳定点开放切换、审批或下一步操作。", tone: "external", icon: AppWindow },
    ],
  },
  {
    id: "resume",
    label: "恢复",
    caption: "从当前 leaf 回溯 root，并用 compaction summary 与保留尾部重建 Context。",
    signal: "open / continueRecent",
    eventLog: ["read JSONL", "build leaf path", "restore model settings", "build context"],
    planes: [
      { label: "Run 内存状态", owner: "Agent", state: "new idle instance", detail: "持久记录重建 messages；旧进程内 activeRun 不会复活。", tone: "live", icon: RotateCcw },
      { label: "Session 持久记录", owner: "SessionManager", state: "same file, same leaf", detail: "继续写原 JSONL；其他 branch 不自动进入 Context。", tone: "durable", icon: History },
      { label: "Application 业务状态", owner: "Host", state: "load separately", detail: "业务实体必须从应用存储或显式 custom entry 恢复。", tone: "external", icon: AppWindow },
    ],
  },
  {
    id: "branch",
    label: "分支",
    caption: "先移动同文件 leaf；下一次 append 才生成新的 child。fork 才创建新文件。",
    signal: "branch(entryId)",
    eventLog: ["select ancestor", "move in-memory leaf", "append new child", "old branch preserved"],
    planes: [
      { label: "Run 内存状态", owner: "AgentSession", state: "context replaced", detail: "选中路径重建 messages，不并行保留旧 active Run。", tone: "live", icon: GitBranch },
      { label: "Session 持久记录", owner: "SessionManager", state: "one tree, two children", detail: "旧 entry 不改不删；fork 才发布新的 session 文件。", tone: "durable", icon: Database },
      { label: "Application 业务状态", owner: "Host", state: "policy required", detail: "宿主要决定业务状态跟随、复制还是拒绝分支。", tone: "external", icon: AppWindow },
    ],
  },
];

const activeId = ref<ScenarioId>("running");
const active = computed(() => scenarios.find((scenario) => scenario.id === activeId.value) ?? scenarios[0]);
</script>

<template>
  <section class="runtime-ledger" aria-labelledby="runtime-ledger-title">
    <header class="runtime-ledger__header">
      <div>
        <span class="runtime-ledger__kicker">RUNTIME STATE LEDGER</span>
        <h2 id="runtime-ledger-title">同一个时刻，三份状态</h2>
      </div>
      <code>{{ active.signal }}</code>
    </header>

    <div class="runtime-ledger__tabs" role="tablist" aria-label="运行时场景">
      <button
        v-for="scenario in scenarios"
        :key="scenario.id"
        type="button"
        role="tab"
        :aria-selected="activeId === scenario.id"
        :class="{ 'is-active': activeId === scenario.id }"
        @click="activeId = scenario.id"
      >
        {{ scenario.label }}
      </button>
    </div>

    <p class="runtime-ledger__caption">{{ active.caption }}</p>

    <div class="runtime-ledger__planes">
      <article v-for="plane in active.planes" :key="plane.label" :class="`tone-${plane.tone}`">
        <div class="runtime-ledger__plane-head">
          <component :is="plane.icon" :size="19" aria-hidden="true" />
          <span>{{ plane.label }}</span>
        </div>
        <strong>{{ plane.state }}</strong>
        <p>{{ plane.detail }}</p>
        <small>OWNER · {{ plane.owner }}</small>
      </article>
    </div>

    <div class="runtime-ledger__log" aria-label="事件记录">
      <Play :size="16" aria-hidden="true" />
      <ol>
        <li v-for="event in active.eventLog" :key="event"><code>{{ event }}</code></li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.runtime-ledger {
  margin: 34px 0 44px;
  overflow: hidden;
  border: 1px solid #2c3a36;
  border-radius: 6px;
  color: #edf5f2;
  background: #0d1513;
}

.runtime-ledger__header {
  display: flex;
  min-height: 106px;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 22px 26px;
  border-bottom: 1px solid #2c3a36;
}

.runtime-ledger__kicker {
  color: #63d7b0;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  letter-spacing: 0;
}

.runtime-ledger__header h2 {
  margin: 7px 0 0;
  border: 0;
  color: #edf5f2;
  font-size: 24px;
  line-height: 1.2;
}

.runtime-ledger__header > code {
  max-width: 210px;
  overflow-wrap: anywhere;
  color: #e9c75b;
  background: #1a2522;
}

.runtime-ledger__tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid #2c3a36;
}

.runtime-ledger__tabs button {
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

.runtime-ledger__tabs button:last-child { border-right: 0; }
.runtime-ledger__tabs button:hover { color: #edf5f2; background: #17221f; }
.runtime-ledger__tabs button.is-active { color: #0d1513; background: #63d7b0; }

.runtime-ledger__caption {
  min-height: 64px;
  margin: 0;
  padding: 20px 26px;
  color: #b8c5c1;
  border-bottom: 1px solid #2c3a36;
}

.runtime-ledger__planes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.runtime-ledger__planes article {
  display: flex;
  min-width: 0;
  min-height: 248px;
  flex-direction: column;
  padding: 24px;
  border-right: 1px solid #2c3a36;
}

.runtime-ledger__planes article:last-child { border-right: 0; }
.runtime-ledger__planes article.tone-live { box-shadow: inset 0 3px #63d7b0; }
.runtime-ledger__planes article.tone-durable { box-shadow: inset 0 3px #e9c75b; }
.runtime-ledger__planes article.tone-external { box-shadow: inset 0 3px #ee826f; }

.runtime-ledger__plane-head {
  display: flex;
  align-items: center;
  gap: 9px;
  color: #91a09b;
  font-size: 12px;
}

.runtime-ledger__planes strong {
  margin-top: 24px;
  overflow-wrap: anywhere;
  color: #edf5f2;
  font-family: var(--vp-font-family-mono);
  font-size: 17px;
}

.runtime-ledger__planes p {
  margin: 12px 0 20px;
  color: #b8c5c1;
  font-size: 13px;
  line-height: 1.65;
}

.runtime-ledger__planes small {
  margin-top: auto;
  overflow-wrap: anywhere;
  color: #6f807a;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
}

.runtime-ledger__log {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 62px;
  padding: 13px 24px;
  border-top: 1px solid #2c3a36;
  color: #63d7b0;
  background: #111b18;
}

.runtime-ledger__log ol {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: runtime-event;
}

.runtime-ledger__log li { min-width: 0; counter-increment: runtime-event; }
.runtime-ledger__log li::before { content: counter(runtime-event) ". "; color: #61716c; }
.runtime-ledger__log code { overflow-wrap: anywhere; color: #b8c5c1; background: transparent; }

@media (max-width: 760px) {
  .runtime-ledger__header { align-items: flex-start; flex-direction: column; gap: 14px; padding: 20px; }
  .runtime-ledger__tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .runtime-ledger__tabs button:nth-child(2) { border-right: 0; }
  .runtime-ledger__tabs button:nth-child(-n + 2) { border-bottom: 1px solid #2c3a36; }
  .runtime-ledger__caption { padding: 18px 20px; }
  .runtime-ledger__planes { grid-template-columns: 1fr; }
  .runtime-ledger__planes article { min-height: 212px; padding: 22px 20px; border-right: 0; border-bottom: 1px solid #2c3a36; }
  .runtime-ledger__planes article:last-child { border-bottom: 0; }
  .runtime-ledger__log { padding: 14px 20px; }
}
</style>
