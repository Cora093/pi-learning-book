# Diagrams

本目录保存可视化源文件，不保存无法维护的截图式结论。

每张图必须：

- 对应一个 Book 问题；
- 标明来自哪个 evidence map；
- 区分持久状态、进程内状态和外部副作用；
- 在 Pi 版本升级后重新验证。

## 已建立

- `01-agent-loop/run-lifecycle.mmd`：Run / Turn / Tool Loop / 队列消息生命周期，对应 AL-01 至 AL-06。
- `01-agent-loop/tool-ordering.mmd`：并行完成顺序与 transcript 顺序，对应 AL-13、AL-14。
- `02-tool-system/contract-layers.mmd`：模型协议、执行协议与应用包装三层关系，对应 TS-01、TS-14、TS-15。
- `02-tool-system/call-pipeline.mmd`：ToolCall 从查找到 ToolResultMessage 的错误归一化路径，对应 TS-02 至 TS-13。
- `03-context-engineering/request-assembly.mmd`：Session 到 provider Context 的两层消息投影，对应 CE-01 至 CE-12。
- `03-context-engineering/compaction-boundary.mmd`：摘要、保留后缀与 split-turn 边界，对应 CE-13 至 CE-16。
- `04-agent-runtime/runtime-state-boundaries.mmd`：Run、Session 与 Application 三份状态的 owner 和恢复关系，对应 AR-01 至 AR-06、AR-10。
- `04-agent-runtime/session-tree.mmd`：append-only entry tree、branch 与 fork 的区别，对应 AR-07 至 AR-09。
- `05-application-engineering/trace-to-evaluation.mmd`：从 Case、Run trace 到 grader 和聚合指标，对应 AE-01 至 AE-13。
- `05-application-engineering/comparison-contract.mmd`：shared contract、两个 adapter 与统一报告边界，对应 AE-15、AE-16。
