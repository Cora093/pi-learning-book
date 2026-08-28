# Evidence

本目录保存源码证据地图。证据回答“这个结论由哪段固定源码支持”，Book 负责回答“怎样让读者理解”。

## 规则

- 一条记录只支持一个可验证结论。
- 固定记录 `tag + commit + file + symbol`；行号可选。
- `status: verified` 前必须实际读取固定源码。
- 推断、文档描述和运行结果分别标注，不能混为源码事实。
- 章节开始时再创建对应 evidence map，不提前填充。

使用 `template.yaml` 建立章节证据文件。

## 当前进度

- `01-agent-loop/`：15 条独立 evidence map 已核验，另有一份完整源码研究索引。
- `02-tool-system/`：16 条独立 evidence map 已核验，研究索引保留 28 条原始证据。
- `03-context-engineering/`：16 条独立 evidence map 已核验，研究索引保留 20 条原始证据。
- `04-agent-runtime/`：16 条独立 evidence map 已核验，研究索引保留实现状态与所有权边界。
- `05-application-engineering/`：16 条独立 evidence map 已核验，研究索引保留 trace、failure、metrics 与 evaluation 边界。
- 上游测试源码已读取，但 submodule 没有安装依赖，本次未运行 upstream Vitest；各记录必须保留这一验证边界。
