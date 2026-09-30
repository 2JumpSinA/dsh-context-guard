# dsh-context-guard

[English](README.md) | 中文

**会话太长就提醒你收尾换会话**的 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) 插件。

消费官方 `dsh-token-meter` 已经算好的 `contextPressure` 投影，在**一轮结束之后**按双档阈值提示：
「先把交接写进文档，再开新会话」。它会顺着帮你把这句提示**变成动作** —— 跨过阈值时自动往会话工作目录起草一份交接草稿。

**上下文税 = 0**：不注册任何 model-facing 工具、不注入 prompt 段落、不额外发请求。宿主算数，UI 说话。

![会话头徽标（ctx 48%）与一次性 banner —— 截图为脱敏版，会话内容已打码](docs/badge-and-banner.png)

---

## ⚠️ 它会写你的工作目录（装之前先看这一段）

- 默认开启（`handoverOnWarn: true`）。当某个会话的**占用率跨过 `warnRatio`（默认 45%）**时，
  插件会在**该会话的工作目录**下创建/改写 `handoverPath`（默认 `HANDOVER.md`），此后水位每涨 5 个点刷新一次。
- 写入的内容是**机器事实**：会话 id、标题、工作目录、占用率、轮数/调用数、**账本花费**、
  **本次会话写过的文件清单**、**最近几轮的用户诉求与回复摘要**，以及一段留给 agent 的「待补」空槽。
  ⇒ **它可能包含敏感内容**（文件路径、你的提问与回复片段），**也可能被 git 提交**。
- 建议：把 `HANDOVER.md` 加进你的 `.gitignore`；或把 `handoverPath` 指到一个**不在仓库里**的路径；
  或直接 `handoverOnWarn: false`。
- 边界：目标父目录不存在 ⇒ 拒绝写入；目标已存在但不是文本类文件（`.json`/`.yml`/…）⇒ 拒绝改写；
  目标是指向别处的**符号链接** ⇒ 拒绝；写入使用原子替换（临时文件 + rename）并收紧权限（`0o600`）。
  任何失败都只记录状态，**绝不影响**徽标 / banner / 推送。

## 它做什么

| 半边 | 做什么 |
|---|---|
| **host**（`lib/index.js`） | 订阅 `ctx.sessionProjections.onChanged`，把 `contextPressure` 喂给纯策略；在 `turn/end` 结算一轮；持有设置；`session/created`（新建或从存储恢复）时立刻判一次；`compaction/end`、`request/header` 参与判定；注册 `GET /api/context-guard/state`；按设置把结论外推到微信；跨过阈值时**起草交接草稿** |
| **client**（`lib/client.js`，手写单文件 bundle） | 会话头**徽标**（实时占用率，只显示数字、不出声）+ 跨档时**一次性 banner**（占比 + 下一步 + 指向交接文档）；启动时从状态路由读回宿主设置（**内置默认 < 宿主真源 < 逃生阀**三层合并） |

行为要点：

- **绝不 mid-turn 提示**：那一轮已经发出去了，提示没有意义。
- **只响一次**：双档 + 迟滞（回落到 `warn − hysteresis` 才重新武装）+ 边沿触发 + 冷却 N 轮。
- **fail-closed**：没有分母（`contextWindow` 缺席）就不判定，徽标显式显示 `ctx —`，**不假装 0%**。

## 安装

```bash
npm i dsh-context-guard
```

DSH 会按包内 `dsh.bundle.patch`（`cordis.patch.yml`）把宿主半边挂上；浏览器半边由 `dsh.client` 声明注入。

**本地开发时**（不发布、用 junction 挂进某个 profile）也常见：

```powershell
# 把仓库挂进目标 profile 的 node_modules（路径按你的环境替换）
New-Item -ItemType Junction `
  -Path   $env:DSH_HOME\profiles\<profile>\node_modules\dsh-context-guard `
  -Target <仓库路径>
```

然后在那个 profile 的 `cordis.patch.yml`（用户 patch 层）末尾加一条 `insert`：

```yaml
- insert:
    - id: context-guard
      name: dsh-context-guard
```

> ⚠️ 不要把这个包写进 profile 的 `dsh.profile.bundles` —— 会报 `cannot resolve profile bundle`。
> ⚠️ junction 挂载后，Node 从**真实路径**往上找 `node_modules` ⇒ 仓库里要有它自己的依赖（或让 DSH 从安装位置解析）。

## 配置项

设置页可改，全部即时生效；`config` 字段都是 volatile ⇒ 改完**不用重启**（但改**源码**要重启，见下）。

| 字段 | 默认 | 范围 | 含义 |
|---|---|---|---|
| `enabled` | `true` | bool | 总开关 |
| `warnRatio` | `0.45` | 0.1–0.95 | 「该收尾了」的占用率（`projectedTokens / contextWindow`） |
| `hardRatio` | `0.60` | 0.1–1 | 「该换会话了」；必须 > `warnRatio` |
| `hysteresisRatio` | `0.05` | 0–0.2 | 迟滞：回落到 `warn − 此值` 以下才重新武装 |
| `cooldownTurns` | `5` | 0–100 | 跨档后静默多少轮 |
| `onResume` | `true` | bool | 进入一个已经很高的历史会话时也提示 |
| `respectCompaction` | `true` | bool | 自动压缩正在压水位时不提示换会话 |
| `crossSessionTrend` | `true` | bool | 统计窗口内几个会话撞过线，用于升级措辞 |
| `trendWindowHours` | `24` | 1–168 | 趋势统计窗口（小时） |
| `trendEscalateAt` | `3` | 2–20 | 窗口内撞 hard 的会话数达到此值则升级措辞 |
| `pushChannel` | `none` | `none`\|`wechat` | 外推通道（默认关） |
| `pushMinLevel` | `hard` | `warn`\|`hard` | 从哪一档开始外推 |
| `pushCooldownMinutes` | `10` | 0–1440 | 两次外推的全局最小间隔 |
| `handoverOnWarn` | `true` | bool | 跨过 `warnRatio` 时自动起草交接草稿 |
| `handoverPath` | `HANDOVER.md` | string | 相对**会话工作目录**，或绝对路径 |
| `handoverRefreshPercent` | `5` | 1–25 | 水位每再涨这么多点刷新一次草稿 |
| `handoverTurns` | `6` | 1–20 | 草稿里带几轮「诉求 / 回应」摘要 |
| `handoverFiles` | `12` | 1–50 | 草稿里带几个最近写过的文件 |

> `warnRatio` 的 schema 下限是 **0.1**：配 `0.05` 之类的值会让整个插件挂不上
> （`ValidationError: invalid config: $.warnRatio expected number >= 0.1`，状态路由随之 404）。

## 宿主状态路由

`GET /api/context-guard/state` —— 浏览器半边据此拿真源阈值，也是排障入口。

```jsonc
{
  "plugin": "context-guard",
  "at": 1790000000000,
  "config": { /* 上面那张表；handoverPath 只回相对名/文件名，绝不回绝对路径 */ },
  "trend": { /* 跨会话趋势汇总，crossSessionTrend=false 时为 undefined */ },
  "recent": [ { "sessionId": "…", "level": "warn|hard", "ratioPercent": 52, "title": "…", "body": "…" } ],
  "push": { "channel": "none", "minLevel": "hard", "cooldownMinutes": 10,
            "lastAt": 0, "lastResult": null, "sent": 0, "failed": 0, "skipped": 0, "history": [] },
  "handover": { "enabled": true, "path": "HANDOVER.md", "refreshPercent": 5,
                "written": 1, "failed": 0, "skipped": 0,
                "last": { "status": "appended|replaced|error|skipped", "path": "HANDOVER.md", "bytes": 1234, "error": null },
                "history": [] }
}
```

## 自动交接草稿

跨过 `warnRatio`（或打开一个已经超过该阈值的会话）时，插件在会话工作目录里维护一块**带标记**的草稿：

```markdown
<!-- dsh-context-guard:begin session-… -->
### 🤖 自动交接草稿（dsh-context-guard · 时间 · 占用 52%）
… 机器事实表格 · 改过的文件 · 最近几轮摘要 · 「待补」空槽 …
<!-- dsh-context-guard:end -->
```

- **幂等**：一个会话一块，刷新时整块替换，**不重复追加**；人工可以整块删除。
- **只写机器事实、不写结论** —— 插件不知道你干了什么。请让 agent 在「待补」里写结论/坑/下一步，
  或折进你自己的交接文档后把整块删掉。
- **素材从哪来（2026-09-30 真机核实，v0.3.1 修正）**：机器事实取自**宿主状态真源** ——
  注册表 `sessionProjections.stateOf(session, key)`，而**不是**投影变更推送的 **wire 视图**。
  原因：`contextTimeline`（由 `dsh-context` 这类插件注册）的 wire 视图在按需 detail 通道启用后
  是个 **slim head**：水位/规模/工具分布/花费都在，**唯独没有 `fileOps`** —— 重集合只存在于单元
  状态里。v0.3.0 只读 wire 视图 ⇒「改过的文件」永远是 0 个（**恢复会话与会话运行中完全一样**，
  不是两条路的差别）；另外 `turnOutline` 的 wire 视图是**数组**而 v0.3.0 按 `{turns}` 读 ⇒
  「最近几轮」永远印「宿主没有提供」。两处均已修，并各有单测/自检守着。
- **依赖与降级**：`fileOps`、工具分布依赖注册 `contextTimeline` 的插件（如 `dsh-context`）；
  花费依赖 `tokenCost`（如 `dsh-damage-pulse`）。它们缺席时对应段落显示为空 —— 插件**不编造**
  也不失败；宿主注册表若没有 `stateOf`（老版本），自动退回 wire 视图（即 v0.3.0 的行为）。

## 阈值与设计取舍（为什么是 0.45 / 0.60）

- **占用率 = `projectedTokens / contextWindow`**（官方口径：**下一次**请求的 prompt 有多大，不含 output）。
  一律用比率：换模型即换窗口。
- **成本随占用率上升**：按官方定价把「每次调用成本」对占用率拟合，高档位每次调用约是空会话的数倍，
  越晚收尾越贵；越早换会话省下的越多，代价只有一份交接（把它写短）。
- **0.60 这个 hard 线是刻意早于平台自己的动作**：观测到的会话峰值从未超过约 80%（平台自身会在 ~80% 处
  compaction）。把 hard 放在 80% 会与它抢同一时刻，而 `respectCompaction: true` 又会在被压缩后抑制提示
  ⇒ hard 档可能**永远不出声**。
- 两档的分工：`warnRatio` = 开始收尾/写交接；`hardRatio` = 换会话。

## 外推推送（微信，默认关）

`pushChannel: 'wechat'` 时，把同一句结论发给本机的 `wechatNotify` 服务（软依赖，通常由
[`dsh-damage-pulse`](https://www.npmjs.com/package/dsh-damage-pulse) 一类插件提供）。
通道缺席或发送失败只记状态（`push.lastResult.code === 'channel-absent'`、`failed++`），**不外溢异常**。
推送是显式选择 —— 这个插件不会在你没要求的情况下往你手机里发消息。

## 安全与隐私

- **状态路由没有插件级认证**：它注册在宿主的 webServer 上（与 DSH Web 同一访问控制）。
  插件侧做的防护是：**只回相对名/文件名**（绝不回本机绝对路径）、`Cache-Control: no-store`、
  不发 CORS 头。**不要**把 DSH Web 暴露到 `0.0.0.0`。
- **写文件的副作用**见文首警告；写入路径来自你自己的设置，不是远端输入。
- **浏览器半边的调试把手** `window.__DSH_CONTEXT_GUARD__`：可读状态、可调档（`override()`），
  但被 `Object.defineProperty` 固定为**不可整体替换**。它只在页面内可用，不提升任何权限
  （那段代码本来就跑在你的 DSH Web 页面里）。
- 插件不联网、不调用任何 LLM、不发送会话内容（除非你显式开微信外推）。

## 测试与本地验收

```bash
npm test          # 单元测试 + "bundle 与源码逐字节同源"校验
npm run build     # 重新生成 lib/client.js（改了 lib/client-source.js 或 lib/policy.mjs 后必须跑）
```

要求 Node `^22.19.0 || >=24.0.0`。

## 排障（都踩过，写下来别再犯）

1. **`.volatile()` 字段拿到的是引用，不是值**：`apply(ctx, config)` 里读 `config.warnRatio` 永远是 `undefined`
   ⇒ 静默用默认值。必须逐字段 `isVolatile(v) ? v.get() : v`（见 `lib/policy.mjs` 的 `plainConfig()`）。
   设置页显示 0.33、插件却按 0.45 判断，就是这么来的。
2. **改了源码不会自愈**：运行中的实例**不重读** profile 的 `cordis.patch.yml`，也不重载已装载的模块
   ⇒ 改配置或改源码后要**重启那个 dsh 进程**（浏览器半边相反：服务端按请求重读 bundle，刷新页面即新）。
3. **`patchReload: live` 不是文件监视**：它管的是那一次组合，不是热重载。
4. **junction 安装时 Node 按真实路径解析依赖** ⇒ 仓库里得有它自己的 `node_modules`（或让 DSH 从安装位置解析）。
5. **`--profile` 是顶层旗标**：`dsh --profile <p> --port <n>` 对；`dsh web --profile <p>` 会报 `select a profile only once`。

## 卸载

删掉 profile 的 `cordis.patch.yml` 里那条 `insert`（以及设置页可能写在同文件里的 `- id: context-guard` 配置行），
再删掉 profile 的 `node_modules/dsh-context-guard`，然后**重启那个 dsh 进程**。

## License

[MIT](./LICENSE)
