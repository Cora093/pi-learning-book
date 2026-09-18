# Jev 适配评估（本仓库）

- 状态：评估结论，非正式 ADR
- 日期：2026-09-18
- 评估对象：TypeSafe AI **Jev**（System One，常见版本 id `jev-1.13.0` / `jev-latest`）
- 问题：是否值得引入 Jev 来优化 **当前这个公开仓库**（`pi-learning-book`）

## 仓库结论

**不适合。**

本仓库是以固定 Pi 源码为证据的 VitePress 静态学习书，没有 Agent、工具执行、模型路由或运行时审核门控。Jev 擅长的「程序状态 → typed 结构化决策」在这里没有可消费的决策循环。

## 本仓库是什么

| 维度 | 事实 |
|---|---|
| 目标用户 | 想按固定 Pi 版本核验 Agent Runtime 的读者 |
| 主产品 | `book/` VitePress 站点，GitHub Pages 发布 |
| 技术栈 | Vue 3 + VitePress 1.6 + pnpm；无运行时后端 |
| 上游 | `upstream/pi/` submodule，固定 `v0.84.3` @ `4e58f324fae8ebfa98a3d45181fb248072a2afac`，只读 |
| CI | `.github/workflows/verify.yml` 跑 `pnpm check`；`deploy-pages.yml` 构建静态产物 |
| 校验 | `scripts/verify-pi-pin.mjs`、`verify-content.mjs`、`verify-public-scope.mjs`，全部确定性字符串/文件检查 |

Book 前端（`book/.vitepress/theme/components/*.vue`）是教学可视化：预置场景、本地 `ref` 切换。站点内除 VitePress `base` 外没有 `fetch`、没有 LLM、没有分类器。

ADR `0002` 已把 Quiz、判分、Lab、评测运行隔离到 **私有学习仓**。公共仓刻意不含那些决策点。

## 为什么 Jev 对不上

Jev 的工程用法是辅决策层，例如：tool/shell 风险门控、cheap vs reasoning 路由、补丁爆炸半径评分、工单分类、替代脆弱 if-else。

本仓对应位置如下：

1. **没有 Agent harness。** 工具门控存在于上游 Pi 的 `beforeToolCall`（证据 `TS-04`，`packages/agent/src/agent-loop.ts` / `prepareToolCall`），是 Book 讲解对象，不是本仓可改代码。禁止改 `upstream/pi/`。
2. **没有模型调用。** 不存在 cheap/reasoning 路由。
3. **没有 apply patch / 跑评测。** `EvalTraceBench` 是教学样例数据；`AE-13` 明确固定源码也没有 dataset/evaluator runner。
4. **已有门控是确定性的。** pin 一致性、章节完成标记、evidence 字段、私人标记扫描都不需要概率输出。把它们换成 Jev 会引入 API Key、网络抖动和误判，并削弱「固定源码可复核」的产品承诺。

Jev「按构造不幻觉字符串」解决的是开放生成的类型风险。本仓的校验本来就不是生成式的。

## 容易误判成「适合」的点

这些是 **教学内容或他仓职责**，不是本仓运行时插入点：

- `ToolPipeline` 的「执行前策略 / beforeToolCall」：可视化 Pi 行为，无真实 hook。
- 第五章 grader / PASS-FAIL：讲应用层 contract，grader 不在本仓运行。
- 公开范围扫描：看起来像分类，实际是禁止目录与标记的精确匹配（`scripts/verify-public-scope.mjs`）。
- 私人学习仓的 Quiz/Lab/评测：按 ADR `0002` 不在本仓。若评估 Jev，应针对那个仓，而不是给公共 Book 加依赖。

## 若仍想做实验，也不应进本仓 CI

不推荐接入方式：**无**（不引入 SDK / HTTP / MCP / LangChain）。

若只在作者本地 Agent 里做一次性探测（不提交密钥、不改 `package.json`、不进 GitHub Actions），typed questions 可以是：

1. **公开范围（Choice）**  
   `public_scope`：`public_book` / `private_learning` / `mixed`  
   策略：`private_learning` 或 `mixed` → review；不得 auto-merge。  
   本仓已有确定性扫描，Jev 只能当第二意见。

2. **证据是否已读源码（Noul）**  
   `claim_requires_human_source_read`：该 claim 是否必须人工打开 `tag+commit+file+symbol` 才能标 `verified`。  
   策略：高概率 → block 自动 `verified`。  
   这与 `evidence/README.md` 规则一致，但实现应是流程纪律，不是 API。

3. **补丁爆炸半径（Score 0–5）**  
   改动是否触及 `upstream/pi/`、证据 pin、或可视化行为。  
   策略：≥3 → review；触及 submodule → block。  
   用 `git diff` 路径规则更稳。

## 风险

- **API Key**：公共仓库与 GitHub Actions 不应持有 TypeSafe 密钥。
- **延迟**：70–500ms 对静态构建无收益，却让 `pnpm check` 依赖外网。
- **误判**：证据 `verified` 和公开范围是硬约束；概率模型不能当 source of truth。
- **职责边界**：Jev 不写 Book、不读懂 Pi 源码；本仓也不调用 LLM。没有「主模型 / 辅决策」可拆。
- **产品定位**：公共仓加入厂商决策 API，会把可复核的静态书变成带外部智能的服务，与 ADR `0001`/`0002` 相反。

## 替代方案

1. 继续用现有 Node 脚本做门控（已足够）。
2. 证据核验保持人工读固定源码。
3. 作者侧编码 Agent 若需要 tool 风险门控，把 Jev 放在 **编辑器/harness**，不要放进本仓。
4. 私人学习仓若有自动判分或 Lab 路由，再单独评估 Jev。
5. 若只是教学对比 System One vs LLM grader，应写成第五章内容，而不是加运行时依赖。当前五章已完成，不属于本次评估范围。

## MVP（若将来前提变化）

只有出现真实决策循环时才值得做。当前 **不要做**。若私人仓或作者 harness 需要：

1. 在仓外用 HTTP `POST https://api.typesafe.ai/v1/systemone` 对 20 个历史 PR diff 跑公开范围 Choice，对照 `verify-public-scope.mjs`。
2. 看误报/漏报；没有稳定增益则停止。
3. 禁止把密钥、SDK 或 CI job 合入 `pi-learning-book`。
