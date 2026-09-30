# tools/ —— **本机专用**，不进 npm 包，也不该被外部用户依赖

这里的脚本硬编码了作者机器上的路径（Chrome 可执行文件、`playwright-core` 的绝对路径、`dsh-url.ps1`），
它们的作用是**对着真实运行的 DSH 实例做验收**，所以天然与具体机器绑定。

`package.json` 的 `files` 白名单**不含**本目录 ⇒ 发布到 npm 的 tarball 里没有它们。

## ⛔ 凭据纪律（读之前先读这一段）

这些脚本需要从 daemon 的 stdout 日志里取 `?token=`（**登录凭据**）来打开页面。因此：

1. **daemon 的 banner 里带 token** —— 用 PowerShell 的 `*>` 把 stdout 重定向到文件，**就等于把凭据写进了工作区**。
   本仓库的 `.gitignore` 已兜底 `tools/out/`、`*.log`、`*.jsonl`，但**不要**把这些产物复制到别处（网盘、聊天记录、issue）。
2. 脚本自身**只把 token 用在 `page.goto()` 的 URL 里**，不打印、不落盘；
   `probe-boot.mjs` 顶部那段注释是这条纪律的原文，其余脚本应保持一致。
3. **产物里出现过 token 就当作已泄露**：重启那个 daemon 实例（token 随进程生命周期更换），再删产物。

## 脚本

| 脚本 | 作用 |
|---|---|
| `check-live.mjs` | 对着**运行中**的实例只读检查：客户端模块图/ bundle 能否 materialize / 宿主状态路由是否应答 / 交接草稿面 |
| `verify-client.mjs` | 浏览器半边真机验收（19 项，对着隔离实例跑），产出 `tools/out/client-verify.json` |
| `selftest.mjs` | 假 ctx 真跑 `apply()`：契约、Config、软 inject、事件分派、外推、交接草稿、双语（72 项） |
| `probe-boot.mjs` / `probe-slots.mjs` / `inspect-slots.mjs` / `dump-state.mjs` / `dump-dom.mjs` | 真机排障与席位探测 |

## 跑法要点

- 都需要一个**隔离实例**（别对着自己的主实例）；README 的「本机验收」一节有启动命令。
- `--log=<探针日志>` 用来取 token（也可以给 `DSH_PROBE_TOKEN` 环境变量）。
- `dump-dom.mjs` **刻意不落页面文本**（`.bodyText` / `.html` 会搬运对话内容）—— 别把它加回来。
