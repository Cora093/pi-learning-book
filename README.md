# Pi Runtime Book

一本以固定版本 Pi 源码为证据的可视化 Agent Runtime 学习书。

[在线阅读](https://cora093.github.io/pi-learning-book/)

本书不按 Pi package 目录组织知识，而是沿着一个 Agent 从输入走向可评估应用的数据流展开：

1. Agent Loop
2. Tool System
3. Context Engineering
4. Agent Runtime
5. Agent Application Engineering

每章遵循同一条公开证据路径：

```text
源码问题 -> evidence map -> Book 解释 -> 可视化
```

## 公开范围

本仓库只包含可公开、可复核的 Book 内容、源码证据与图形源文件。个人作答、判分、学习进度、Lab 实现、评测运行和私人报告不属于本仓库。

## 固定版本

- 上游：[`earendil-works/pi`](https://github.com/earendil-works/pi)
- 版本：`v0.84.3`
- Commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- 载入方式：`upstream/pi` Git submodule
- 证据规则：每条源码结论记录 `tag + commit + file + symbol`

`upstream/pi` 只读。升级 Pi 版本必须新增迁移决定并重新验证相关证据和章节。

## 仓库结构

| 目录 | 职责 |
|---|---|
| `book/` | 面向读者的 VitePress Book，是项目主产品 |
| `evidence/` | 源码证据地图，不重复 Book 叙事 |
| `diagrams/` | 可维护的图形源文件 |
| `docs/` | 固定源码与项目决定 |
| `scripts/` | Pi pin、内容完整性和公开范围校验 |
| `upstream/pi/` | 固定到 `v0.84.3` 的只读上游源码 |

## 许可证

- Book 文字、证据说明、文档和图：[`CC BY 4.0`](LICENSE-CONTENT)
- Vue、TypeScript、JavaScript、CSS 和构建脚本：[`MIT`](LICENSE-CODE)
- `upstream/pi` 是独立 Git submodule，适用其上游许可证

## 本地运行

```powershell
git clone --recurse-submodules https://github.com/Cora093/pi-learning-book.git
cd pi-learning-book
pnpm install
pnpm dev
```

完整校验：

```powershell
pnpm check
```
