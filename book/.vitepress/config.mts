import { defineConfig } from "vitepress";

const base = process.env.GITHUB_ACTIONS ? "/pi-learning-book/" : "/";

export default defineConfig({
  lang: "zh-CN",
  title: "Pi Runtime Book",
  description: "以固定版本 Pi 源码为证据的可视化 Agent Runtime 学习书",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#0a100f" }],
    ["meta", { name: "color-scheme", content: "dark light" }],
  ],
  themeConfig: {
    siteTitle: "Pi Runtime Book",
    nav: [
      { text: "学习路径", link: "/guide/learning-path" },
      { text: "五章", link: "/chapters/01-agent-loop/" },
    ],
    sidebar: [
      {
        text: "开始",
        items: [
          { text: "学习路径", link: "/guide/learning-path" },
          { text: "证据规则", link: "/evidence/" },
        ],
      },
      {
        text: "五章主线",
        items: [
          { text: "01 Agent Loop", link: "/chapters/01-agent-loop/" },
          { text: "02 Tool System", link: "/chapters/02-tool-system/" },
          { text: "03 Context Engineering", link: "/chapters/03-context-engineering/" },
          { text: "04 Agent Runtime", link: "/chapters/04-agent-runtime/" },
          { text: "05 Application Engineering", link: "/chapters/05-application-engineering/" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/Cora093/pi-learning-book" }],
    search: { provider: "local" },
    outline: { label: "本页目录", level: [2, 3] },
    docFooter: { prev: "上一页", next: "下一页" },
    lastUpdated: { text: "最后更新" },
    editLink: {
      pattern: "https://github.com/Cora093/pi-learning-book/edit/main/book/:path",
      text: "在 GitHub 编辑此页",
    },
    footer: {
      message: "以固定源码、真实证据和可维护可视化学习 Agent Runtime。",
      copyright: "Pi Runtime Book",
    },
  },
});
