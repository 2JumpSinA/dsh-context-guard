# 变更日志

> 0.7.6 之前的版本说明在 [GitHub Releases](https://github.com/2JumpSinA/dsh-context-guard/releases) 与本仓库 `_recon/release-v*-notes.md`，此处不重复。

## v0.7.7 — 2026-10-25

- **0.7.7 = 0.7.6 + 打包预览图**：`files` 增加 `docs/ui-badge-and-banner.png` 与 `docs/badge-and-banner.png`。
  此前 `files` 排除了 `docs/`，README 的相对路径在 npm 页面上取不到文件，两张图是坏的。
- 刻意只加这两张，而不是 `docs/`：`docs/preview-1.png`、`docs/preview-2.png` 与它们逐字节相同，
  只服务于市场列表页，随包发出等于多背 ~400 KB。
- 运行时零变化：`lib/` 与 0.7.6 相同。

## v0.7.6 — 2026-10-22 首发（2026-10-25 补 GitHub Release）

- **0.7.6 = 0.7.5 + docs/CI provenance**：`lib/` 逐字节相同，`git diff v0.7.5..v0.7.6 -- lib test scripts` 为空；变化的只有市场预览图、两份 README 的图链接、`package.json` 的版本号，以及恢复 OIDC 可信发布后重新带上的 SLSA provenance 证明。
- 对使用者的影响：无。只有为了刷新 npm 页面上的图才需要装，已在 0.7.5 的不必升级。
- 附件 `2jumpsina-dsh-context-guard-0.7.6.tgz` 即 npm 上发布的那个 tarball，sha256 `b78d16b329591efcd12951e063664e110a6f329210adbbf674aac101d80dec98`。
