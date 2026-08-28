<script setup lang="ts">
import { computed, ref } from "vue";
import { BookOpen, Braces, Database, FileText, Gauge, Layers3, Scissors, Wrench } from "@lucide/vue";

type BlockState = "included" | "summary" | "deferred" | "filtered";

interface ContextBlock {
  id: string;
  label: string;
  source: string;
  tokens: number;
  state: BlockState;
  note: string;
  icon: typeof Layers3;
}

interface Strategy {
  id: string;
  label: string;
  caption: string;
  blocks: ContextBlock[];
}

const strategies: Strategy[] = [
  {
    id: "full",
    label: "全量",
    caption: "未做 transform；标准消息全部交给 convertToLlm。",
    blocks: [
      { id: "system", label: "基础 System Prompt", source: "buildSystemPrompt", tokens: 5200, state: "included", note: "工具说明、guidelines、cwd 与 project context。", icon: FileText },
      { id: "skills", label: "Skill 索引", source: "formatSkillsForPrompt", tokens: 1800, state: "included", note: "只列 name、description、location，不内联完整正文。", icon: BookOpen },
      { id: "old", label: "旧历史", source: "AgentContext.messages", tokens: 28000, state: "included", note: "早期 user、assistant 与 toolResult 原文。", icon: Database },
      { id: "recent", label: "近期 Turns", source: "AgentContext.messages", tokens: 16000, state: "included", note: "当前任务附近的完整消息。", icon: Layers3 },
      { id: "tools", label: "Tool Schemas", source: "AgentContext.tools", tokens: 6000, state: "included", note: "本轮可用 Tool 的 name、description 与 parameters。", icon: Wrench },
      { id: "ui", label: "UI 通知", source: "custom AgentMessage", tokens: 900, state: "filtered", note: "convertToLlm 过滤模型不理解的消息。", icon: Braces },
    ],
  },
  {
    id: "pruned",
    label: "裁剪",
    caption: "transformContext 在 AgentMessage 层移除旧消息，再做协议转换。",
    blocks: [
      { id: "system", label: "基础 System Prompt", source: "buildSystemPrompt", tokens: 5200, state: "included", note: "systemPrompt 不经过 transformContext(messages)。", icon: FileText },
      { id: "skills", label: "Skill 索引", source: "formatSkillsForPrompt", tokens: 1800, state: "included", note: "仍保留可发现元数据。", icon: BookOpen },
      { id: "old", label: "旧历史", source: "transformContext", tokens: 28000, state: "filtered", note: "直接裁掉意味着这些事实不再进入本轮请求。", icon: Scissors },
      { id: "recent", label: "近期 Turns", source: "AgentContext.messages", tokens: 16000, state: "included", note: "保留最近完整交互。", icon: Layers3 },
      { id: "external", label: "动态检索片段", source: "transformContext", tokens: 3200, state: "included", note: "外部注入是 transformContext 的契约能力，不代表 Pi 自带 RAG。", icon: Database },
      { id: "tools", label: "Tool Schemas", source: "AgentContext.tools", tokens: 6000, state: "included", note: "工具集合独立于 messages transform。", icon: Wrench },
    ],
  },
  {
    id: "compacted",
    label: "压缩",
    caption: "旧历史变成摘要，近期 Turns 从 firstKeptEntryId 起保留原文。",
    blocks: [
      { id: "system", label: "基础 System Prompt", source: "buildSystemPrompt", tokens: 5200, state: "included", note: "应用层每次重建 system prompt。", icon: FileText },
      { id: "skills", label: "Skill 索引", source: "formatSkillsForPrompt", tokens: 1800, state: "included", note: "完整 Skill 正文仍按需读取。", icon: BookOpen },
      { id: "summary", label: "Compaction Summary", source: "CompactionEntry.summary", tokens: 4200, state: "summary", note: "摘要替代 cut point 之前的消息，不等于原文无损保存。", icon: Scissors },
      { id: "recent", label: "近期 Turns", source: "firstKeptEntryId → head", tokens: 20000, state: "included", note: "切点按 Turn 边界选择，避免从 tool result 中间切开。", icon: Layers3 },
      { id: "tools", label: "Tool Schemas", source: "AgentContext.tools", tokens: 6000, state: "included", note: "下一次请求仍携带当前工具声明。", icon: Wrench },
    ],
  },
  {
    id: "lazy",
    label: "按需读取",
    caption: "System Prompt 先给 Skill 索引；模型调用 read 后，正文作为 toolResult 进入下一 Turn。",
    blocks: [
      { id: "system", label: "基础 System Prompt", source: "buildSystemPrompt", tokens: 5200, state: "included", note: "包含使用 Skill 的规则。", icon: FileText },
      { id: "skills", label: "Skill 索引", source: "formatSkillsForPrompt", tokens: 1800, state: "included", note: "name、description、location 足够先做选择。", icon: BookOpen },
      { id: "body", label: "Skill 完整正文", source: "read tool", tokens: 9000, state: "deferred", note: "首次请求不内联；真正相关时才读取。", icon: BookOpen },
      { id: "recent", label: "近期 Turns", source: "AgentContext.messages", tokens: 16000, state: "included", note: "read 结果会在下一 Turn 成为新的 toolResult。", icon: Layers3 },
      { id: "tools", label: "Tool Schemas", source: "AgentContext.tools", tokens: 6000, state: "included", note: "没有 read 工具时，buildSystemPrompt 不追加 Skill 索引。", icon: Wrench },
    ],
  },
];

const activeStrategyId = ref(strategies[0].id);
const contextWindow = ref(64000);
const activeStrategy = computed(() => strategies.find((strategy) => strategy.id === activeStrategyId.value) ?? strategies[0]);
const includedTokens = computed(() =>
  activeStrategy.value.blocks
    .filter((block) => block.state === "included" || block.state === "summary")
    .reduce((sum, block) => sum + block.tokens, 0),
);
const usedPercent = computed(() => Math.min(100, Math.round((includedTokens.value / contextWindow.value) * 100)));
const headroom = computed(() => Math.max(0, contextWindow.value - includedTokens.value));

const stateLabel: Record<BlockState, string> = {
  included: "IN",
  summary: "SUMMARY",
  deferred: "LATER",
  filtered: "OUT",
};
</script>

<template>
  <section class="context-composer" aria-labelledby="context-composer-title">
    <header>
      <div>
        <span class="context-composer__eyebrow">REQUEST ASSEMBLY</span>
        <h2 id="context-composer-title">下一次模型请求里有什么</h2>
      </div>
      <div class="context-composer__strategies" aria-label="Context 策略">
        <button
          v-for="strategy in strategies"
          :key="strategy.id"
          type="button"
          :class="{ 'is-active': strategy.id === activeStrategyId }"
          @click="activeStrategyId = strategy.id"
        >{{ strategy.label }}</button>
      </div>
    </header>

    <div class="context-composer__budget">
      <div class="context-composer__budget-title">
        <Gauge :size="17" aria-hidden="true" />
        <span>教学预算</span>
        <strong>{{ (contextWindow / 1000).toFixed(0) }}k</strong>
      </div>
      <input v-model.number="contextWindow" type="range" min="32000" max="128000" step="8000" aria-label="教学 Context Window" />
      <div class="context-composer__meter" aria-hidden="true"><span :style="{ width: `${usedPercent}%` }"></span></div>
      <div class="context-composer__budget-stats">
        <span>请求 {{ (includedTokens / 1000).toFixed(1) }}k</span>
        <span>余量 {{ (headroom / 1000).toFixed(1) }}k</span>
      </div>
    </div>

    <p class="context-composer__caption">{{ activeStrategy.caption }}</p>

    <div class="context-composer__body">
      <ol class="context-composer__blocks">
        <li v-for="block in activeStrategy.blocks" :key="block.id" :class="`state-${block.state}`">
          <component :is="block.icon" :size="18" aria-hidden="true" />
          <span class="context-composer__copy"><strong>{{ block.label }}</strong><small>{{ block.source }}</small></span>
          <span class="context-composer__tokens">{{ (block.tokens / 1000).toFixed(1) }}k</span>
          <span class="context-composer__state">{{ stateLabel[block.state] }}</span>
          <p>{{ block.note }}</p>
        </li>
      </ol>

      <aside class="context-composer__request">
        <span class="context-composer__eyebrow">streamFunction(model, context)</span>
        <h3>LLM Context</h3>
        <div><strong>systemPrompt</strong><span>独立字符串</span></div>
        <div><strong>messages</strong><span>transform → convert</span></div>
        <div><strong>tools</strong><span>当前 Tool schemas</span></div>
        <p>滑块中的 token 数值用于比较策略，不是 Pi 对这段示例数据的实测值。</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.context-composer {
  margin: 42px 0 54px;
  overflow: hidden;
  border: 1px solid #33413e;
  border-radius: 8px;
  background: #101513;
  color: #f3f0e8;
  box-shadow: 0 24px 64px rgba(10, 16, 15, 0.18);
}

.context-composer > header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 26px 28px 22px;
  border-bottom: 1px solid #33413e;
}

.context-composer__eyebrow {
  color: #ff9f89;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 700;
}

.context-composer h2,
.context-composer h3 {
  border: 0;
  color: #f3f0e8;
  font-family: "Palatino Linotype", Georgia, serif;
}

.context-composer h2 { margin: 7px 0 0; font-size: 30px; }
.context-composer h3 { margin: 18px 0 24px; font-size: 29px; }

.context-composer__strategies {
  display: inline-grid;
  grid-template-columns: repeat(4, auto);
  gap: 3px;
  padding: 3px;
  border: 1px solid #33413e;
  border-radius: 5px;
}

.context-composer button {
  min-height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: #a9b4b0;
  font-size: 12px;
  cursor: pointer;
}

.context-composer button:hover,
.context-composer button.is-active {
  background: #ff9f89;
  color: #101513;
}

.context-composer__budget {
  display: grid;
  grid-template-columns: 130px minmax(160px, 1fr) minmax(120px, 0.7fr) 160px;
  align-items: center;
  gap: 18px;
  padding: 14px 28px;
  border-bottom: 1px solid #33413e;
}

.context-composer__budget-title,
.context-composer__budget-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
}

.context-composer__budget-title { color: #f0cd6a; }
.context-composer__budget-title strong { color: #f3f0e8; }
.context-composer__budget-stats { justify-content: flex-end; color: #a9b4b0; }

.context-composer input[type="range"] {
  width: 100%;
  accent-color: #ff9f89;
}

.context-composer__meter {
  height: 4px;
  overflow: hidden;
  background: #2b3532;
}

.context-composer__meter span {
  display: block;
  height: 100%;
  background: #ff9f89;
  transition: width 180ms ease;
}

.context-composer__caption {
  min-height: 48px;
  margin: 0;
  padding: 13px 28px;
  border-bottom: 1px solid #33413e;
  color: #a9b4b0;
  font-size: 13px;
}

.context-composer__body {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(250px, 0.65fr);
}

.context-composer__blocks {
  margin: 0;
  padding: 14px 0;
  border-right: 1px solid #33413e;
  list-style: none;
}

.context-composer__blocks li {
  display: grid;
  min-height: 86px;
  grid-template-columns: 24px minmax(0, 1fr) 45px 58px;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 10px 24px;
  border-left: 3px solid transparent;
}

.context-composer__blocks li.state-included { border-left-color: #8de6c0; }
.context-composer__blocks li.state-summary { border-left-color: #f0cd6a; }
.context-composer__blocks li.state-deferred { border-left-color: #8ab7ff; }
.context-composer__blocks li.state-filtered { opacity: 0.48; }

.context-composer__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.context-composer__copy strong { font-size: 14px; }
.context-composer__copy small,
.context-composer__tokens,
.context-composer__state {
  font-family: var(--vp-font-family-mono);
  font-size: 9px;
}

.context-composer__copy small { overflow: hidden; color: #788682; text-overflow: ellipsis; white-space: nowrap; }
.context-composer__tokens { color: #a9b4b0; text-align: right; }
.context-composer__state { color: #ff9f89; font-weight: 700; text-align: right; }

.context-composer__blocks li > p {
  grid-column: 2 / -1;
  margin: -3px 0 0;
  color: #a9b4b0;
  font-size: 12px;
  line-height: 1.5;
}

.context-composer__request {
  padding: 34px 28px;
  background: #0b100f;
}

.context-composer__request > div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 15px 0;
  border-top: 1px solid #33413e;
}

.context-composer__request > div span {
  color: #788682;
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  text-align: right;
}

.context-composer__request > p {
  margin: 32px 0 0;
  color: #788682;
  font-size: 11px;
  line-height: 1.6;
}

@media (max-width: 760px) {
  .context-composer > header { align-items: flex-start; flex-direction: column; padding: 22px 18px 18px; }
  .context-composer__strategies { width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .context-composer__budget { grid-template-columns: 1fr; gap: 10px; padding: 16px 18px; }
  .context-composer__budget-stats { justify-content: space-between; }
  .context-composer__caption { min-height: 68px; padding: 13px 18px; }
  .context-composer__body { grid-template-columns: 1fr; }
  .context-composer__blocks { border-right: 0; border-bottom: 1px solid #33413e; }
  .context-composer__blocks li { grid-template-columns: 22px minmax(0, 1fr) 42px 52px; padding: 10px 14px; }
  .context-composer__request { min-height: 360px; padding: 30px 20px; }
}
</style>
