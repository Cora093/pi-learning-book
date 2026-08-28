# AGENTS.md

始终使用简体中文交互。

## 项目定位

这是一本以固定 Pi 源码为证据的公开可视化 Agent Runtime 学习书，不是 Pi 的开发检出，也不包含个人学习记录、作答、Lab 实现或评测运行。

学习主线固定为五章：Agent Loop、Tool System、Context Engineering、Agent Runtime、Agent Application Engineering。

## 固定源码

- `upstream/pi/` 是 Git submodule，固定到 `v0.84.3`，只读。
- 绝不直接修改 `upstream/pi/`。
- 不从 Pi `main` 补充结论；所有结论以当前固定 commit 为准。
- 每个源码结论必须记录：`tag + commit + file + symbol`，行号仅作辅助。
- 升级版本必须新增 ADR、迁移证据并重新验证相关章节。

## 内容职责

- `book/` 是主产品，内容必须可独立阅读。
- `evidence/` 保存证据，不重复 Book 叙事。
- `diagrams/` 保存可维护的图形源文件。
- 公共仓库不得加入个人作答、分数、掌握状态、Lab 实现、运行 trace、评测结果或私人报告。

## 验证

修改前端后必须完成：

- `pnpm check`
- Playwright 移动端检查
- 浏览器 console error 检查

## Git

Commit message 使用：

```text
<type>(<scope>):<中文描述>
```

不要修改或提交与当前任务无关的文件。
