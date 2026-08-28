---
title: 证据规则
---

# 证据规则

<div class="chapter-status">状态：五章 79 条 evidence map 已核验</div>

Book 中的每个技术结论都必须能回到固定源码复核。

## 最小记录

```yaml
chapter: "01-agent-loop"
question: "待回答的问题"
claim: "待验证，不提前写成结论"
source:
  tag: "v0.84.3"
  commit: "由固定源码填写"
  file: "packages/..."
  symbol: "SymbolName"
  lines: null
verification:
  method: "read | test | experiment"
  status: "open"
```

## 引用优先级

1. `tag + commit + file + symbol`
2. 必要时补充行号
3. 可执行测试或最小实验
4. 官方文档仅作解释辅助，不能替代实现证据

完整模板位于仓库根目录的 `evidence/template.yaml`。

## 第一章 Agent Loop

- 证据地图：`evidence/01-agent-loop/AL-01` 至 `AL-15`
- 研究索引：`evidence/01-agent-loop/source-notes.md`
- 固定版本：Pi `v0.84.3` @ `4e58f324fae8ebfa98a3d45181fb248072a2afac`
- 验证边界：源码与测试断言已逐条读取；上游未安装依赖，因此本次没有执行 upstream Vitest

## 第二章 Tool System

- 证据地图：`evidence/02-tool-system/TS-01` 至 `TS-16`
- 研究索引：`evidence/02-tool-system/source-notes.md`，含 28 条原始证据
- 固定版本：Pi `v0.84.3` @ `4e58f324fae8ebfa98a3d45181fb248072a2afac`
- 验证边界：Core、provider adapter 与 Coding Agent wrapper 源码已核对；上游未安装依赖，未执行 upstream Vitest

## 第三章 Context Engineering

- 证据地图：`evidence/03-context-engineering/CE-01` 至 `CE-16`
- 研究索引：`evidence/03-context-engineering/source-notes.md`，含 20 条原始证据
- 固定版本：Pi `v0.84.3` @ `4e58f324fae8ebfa98a3d45181fb248072a2afac`
- 验证边界：请求组装、资源加载、消息投影与 compaction 源码已核对；上游未安装依赖，未执行 upstream Vitest

## 第四章 Agent Runtime

- 证据地图：`evidence/04-agent-runtime/AR-01` 至 `AR-16`
- 研究索引：`evidence/04-agent-runtime/source-notes.md`，含 16 条候选证据
- 固定版本：Pi `v0.84.3` @ `4e58f324fae8ebfa98a3d45181fb248072a2afac`
- 验证边界：现行 AgentSession 与 Harness v2 基础件/driver 边界已核对；上游未安装依赖，未执行 upstream Vitest

## 第五章 Agent Application Engineering

- 证据地图：`evidence/05-application-engineering/AE-01` 至 `AE-16`
- 研究索引：`evidence/05-application-engineering/source-notes.md`，含 16 条候选证据
- 固定版本：Pi `v0.84.3` @ `4e58f324fae8ebfa98a3d45181fb248072a2afac`
- 验证边界：trace、failure、usage/cost 与 evaluation 缺失边界已核对；上游未安装依赖，未执行 upstream Vitest
