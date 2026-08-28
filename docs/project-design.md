# 项目设计：公开的 Pi Runtime Book

## 定位

本仓库发布一套可独立阅读、可回到固定源码核验的 Agent Runtime Book。它公开知识与证据，不记录任何特定学习者的掌握状态或实践产物。

## 五章主线

1. Agent Loop
2. Tool System
3. Context Engineering
4. Agent Runtime
5. Agent Application Engineering

## 内容路径

```text
源码问题 -> evidence map -> Book 解释 -> 可视化
```

`book/` 是公开产品，`evidence/` 提供可核验依据，`diagrams/` 保存图形源文件。三者共享同一个固定 Pi 版本。

## 不在本仓库的内容

个人 Quiz 作答与判分、学习进度、Lab 实现、评测运行、trace、成本记录和私人报告由独立的私有学习仓库管理。公共 Book 不依赖这些内容，也不会因为个人学习状态改变构建结果。

## 完成标准

- 五章内容可独立阅读。
- 所有源码结论具有 `tag + commit + file + symbol` 证据。
- VitePress 构建、公开范围校验和 Pi pin 校验通过。
- 桌面端与移动端没有布局溢出或浏览器 console error。
