<script setup lang="ts">
import { ArrowRight, BookOpen, CircleDashed } from "@lucide/vue";
import { withBase } from "vitepress";

const chapters = [
  { id: "01", title: "Agent Loop", question: "Agent 到底怎样跑起来？", status: "内容完成", href: "/chapters/01-agent-loop/", tone: "mint", state: "complete" },
  { id: "02", title: "Tool System", question: "Agent 怎样操作真实世界？", status: "内容完成", href: "/chapters/02-tool-system/", tone: "yellow", state: "complete" },
  { id: "03", title: "Context Engineering", question: "每一轮究竟应该知道什么？", status: "内容完成", href: "/chapters/03-context-engineering/", tone: "coral", state: "complete" },
  { id: "04", title: "Agent Runtime", question: "Loop 怎样成为可扩展 Runtime？", status: "内容完成", href: "/chapters/04-agent-runtime/", tone: "mint", state: "complete" },
  { id: "05", title: "Application Engineering", question: "怎样证明 Agent 值得上线？", status: "内容完成", href: "/chapters/05-application-engineering/", tone: "yellow", state: "complete" },
];
</script>

<template>
  <section class="course-map" aria-labelledby="course-map-title">
    <div class="section-kicker">
      <BookOpen :size="17" aria-hidden="true" />
      <span>LEARNING SEQUENCE</span>
    </div>
    <div class="course-map__heading">
      <div>
        <h2 id="course-map-title">五章，一条运行时主线</h2>
        <p>Book 内容按认知依赖逐章展开，每章都从问题走向源码证据与可视化解释。</p>
      </div>
      <div class="course-map__legend" aria-label="当前状态">
        <CircleDashed :size="17" aria-hidden="true" />
        <span>五章内容与证据已完成</span>
      </div>
    </div>

    <ol class="course-map__list">
      <li v-for="(chapter, index) in chapters" :key="chapter.id" :class="[`tone-${chapter.tone}`, `state-${chapter.state}`]">
        <a :href="withBase(chapter.href)" class="chapter-link">
          <span class="chapter-index">{{ chapter.id }}</span>
          <span class="chapter-copy">
            <span class="chapter-copy__title">
              <strong>{{ chapter.title }}</strong>
              <em>{{ chapter.status }}</em>
            </span>
            <small>{{ chapter.question }}</small>
          </span>
          <ArrowRight :size="20" aria-hidden="true" />
        </a>
        <span v-if="index < chapters.length - 1" class="chapter-connector" aria-hidden="true"></span>
      </li>
    </ol>

    <div class="course-map__gate">
      <BookOpen :size="20" aria-hidden="true" />
      <p><strong>证据路径</strong><span>固定 Pi 版本、记录真实 symbol，并把未验证推断明确留在结论之外。</span></p>
    </div>
  </section>
</template>
