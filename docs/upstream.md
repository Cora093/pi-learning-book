# Upstream Pi

这是 `pi-learning-book` 的项目文档，不是 Pi 官方 README。Pi 官方 README 位于 `upstream/pi/README.md`。

`upstream/pi/` 是 `earendil-works/pi` 的只读 Git submodule，固定到正式发布 tag `v0.84.3`。

初始化：

```powershell
git submodule update --init --recursive
pnpm verify:pin
```

禁止直接在 submodule 中修改 Book、证据地图或项目代码。
