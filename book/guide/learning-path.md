---
title: 学习路径
---

# 学习路径

<div class="chapter-status">状态：五章正文、源码证据与可视化全部完成</div>

本项目采用固定顺序：

```text
源码问题
  ↓
证据地图
  ↓
Book 与可视化
  ↓
跨章节运行时心智模型
```

这条顺序描述的是知识依赖，不按 Pi package 目录切割内容。读者可以从任意章节进入，但前一章会提供后一章所需的控制流和数据边界。

## 五章依赖

| 顺序 | 章节 | 核心问题 | 内容状态 |
|---|---|---|---|
| 01 | Agent Loop | 一次 Run 的数据怎样流动 | 已完成 |
| 02 | Tool System | Tool 如何让 Loop 继续 | 已完成 |
| 03 | Context Engineering | 一次 Turn 的上下文来自哪里 | 已完成 |
| 04 | Agent Runtime | Run、Session 与 Application state 如何分工 | 已完成 |
| 05 | Application Engineering | 如何记录并解释完整 Run trace | 已完成 |

## 学习季规则

- 固定 Pi `v0.84.3`，不追随 `main`。
- 所有源码结论记录 `tag + commit + file + symbol`。
- 未核验的推断必须标记为待验证。
- 版本升级需要迁移证据并重新验证受影响章节。
