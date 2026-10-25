# 变更日志

> 0.7.6 之前的版本说明在 [GitHub Releases](https://github.com/2JumpSinA/dsh-context-guard/releases) 与本仓库 `_recon/release-v*-notes.md`，此处不重复。

## v0.7.6 — 2026-10-22 首发（2026-10-25 补 GitHub Release）

- **0.7.6 = 0.7.5 + docs/CI provenance**：`lib/` 逐字节相同，`git diff v0.7.5..v0.7.6 -- lib test scripts` 为空；变化的只有市场预览图、两份 README 的图链接、`package.json` 的版本号，以及恢复 OIDC 可信发布后重新带上的 SLSA provenance 证明。
- 对使用者的影响：无。只有为了刷新 npm 页面上的图才需要装，已在 0.7.5 的不必升级。
- 附件 `2jumpsina-dsh-context-guard-0.7.6.tgz` 即 npm 上发布的那个 tarball，sha256 `b78d16b329591efcd12951e063664e110a6f329210adbbf674aac101d80dec98`。
