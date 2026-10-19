# dsh-context-guard

npm 包名：**`@2jumpsina/dsh-context-guard`** · [English](README.md)

**会话太长就提醒你收尾换会话**的 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) 插件。

消费官方 `dsh-token-meter` 已经算好的 `contextPressure` 投影，在**一轮结束之后**按双档阈值提示：
「先把交接写进文档，再开新会话」。它会顺着帮你把这句提示**变成动作** —— 跨过阈值时自动往会话工作目录起草一份交接草稿。

**上下文税 = 0**：不注册任何 model-facing 工具、不注入 prompt 段落、不额外发请求。宿主算数，UI 说话。

> 🆕 **v0.5.0（本机，未发布）**：定位从「提示工具」收缩为「记录工具 + 可回原处的交接」。
> 删掉**微信外推**与**跨会话趋势**（配置键保留为 no-op，只为兼容旧配置）；
> 「压缩前快照」换成一张全局**压缩账**（按 `compactionId` 幂等、取压缩前峰值、上限淘汰）；
> banner 的降级态多一行**压缩回执**；写入路径加了 fail-safe（块标记坏了就**拒绝写**，绝不吞正文）。
> 详见 `HANDOVER.md` §39。

> ⚠️ **别敲 `npm i dsh-context-guard`** —— 那个不带 scope 的名字是**第三方**的包（作者 `greenlv`）。
> 本插件的包名是 scoped 的：**`@2jumpsina/dsh-context-guard`**，已发布到 npm（见[安装](#安装)）。

> 🙂 **用起来了？回我一条吧 —— 我想知道还有哪些可以改善的地方。**
> [一句话就够](https://github.com/2JumpSinA/dsh-context-guard/issues/new/choose)：它在你那儿做对了什么、哪里别扭。

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

## 为什么需要它

**一句话**：长会话不是技术故障，而是**每一轮都在涨的账单**。这个插件存在的意义，就是在你**还能行动的那一刻**
把这张账单摆到面前 —— 一轮已经结束、下一次请求还没发出的那几秒。

### 这个问题是可测量的

成本 ≈（平均 prompt 大小）×（调用次数）×（单价）。长会话会把前两个因子**同时**推上去，而单价本身也随占用率上升。
拿**标定这台机器**自己的账本（本地 session 投影缓存，**84 个会话 / 14 天**，自报 ¥252.29）对着官方价表核：

| 测量项 | 数值 |
|---|---|
| 自检（价表 × `contextTimeline.cost`，对账本总额） | ¥254.29 vs ¥252.29 ⇒ **偏差 0.8%**；逐请求金额覆盖总额 **85.4%** |
| 单价随占用率 | 0–10% **¥0.011/次** → 70–80% **¥0.045/次（4.2×）** |
| 历史花费落在哪里 | **≥40%** 占用时的调用吃掉 **37.4%** 的花费；**≥60%** 吃掉 **20.0%** |
| 会话峰值 | **75/75 个会话都不超过 ~80%**（其中 6 个在 79–80% 处骤降）⇒ 平台自己在那一带压缩 |
| 打扰成本（线画在 40% / 50% / 60%） | 每天 **0.78 / 0.57 / 0.50** 次 |

再举一次真实会话 —— 就发生在开发这个插件的仓库里：**584 次调用、2.74 亿 token、¥31.66，其中 98.6% 花在
重读上下文，模型输出只占 0.17%。** 这正是它要对付的失败形态：不崩溃、不报错，只是一张发票。

### 为什么它是这笔交易里便宜的那一半

上面那个公式有个值得写明的形状。一个会话的总额是

```
总额 ≈ Σ_轮 ( prompt_i × 单价(占用_i) )
```

而两个因子是**同向**动的：`prompt_i` 随每一轮单调增长，单价本身也随占用率上升（上面实测过：
**0–10% 时 ¥0.011/次 → 70–80% 时 ¥0.045/次**）。所以一个会话不是「跑得越久、贵得越线性」，而是
**超线性**地变贵 —— 这就是为什么长会话的最后三分之一，明明轮数一样，却可能比头三分之一贵得多。

这正是这个插件值得装的全部理由：**它的边际成本严格为零。**

- 不注册 model-facing 工具、不注入 prompt 段落、不额外发请求 ⇒ **它不往任何请求里加 token**，
  账本上根本查不到它。
- 它唯一让你付出的是结尾那份交接 —— 而那不是付给插件的费用，是你**本来就要做**的事
  （而且通常做得更糟：凭记忆，在一个已经被放弃的会话之后）。
- 它只在**轮边界**出声。轮内的提示没有用 —— 那一轮的 prompt 已经发出去、已经付过钱；
  晚两轮的提示是一张你已无法回避的发票。

所以这笔交易不是「花钱省钱」，而是：**在一张你已经在付的账单上，免费装一个读数** ——
而且装在数字还来得及改变决定的那一刻。

### 为什么别的机制接不住它

- **平台会压缩，但不会跟你商量。** 观测到的会话峰值全都在 ~80% 以下，那正是 DSH 自己压缩的地方。压缩是会话的
  安全网，不是给你的通知 —— 等它触发时，你已经为整段爬升付过钱了。
- **模型自己当不了这个计量器。** `projectedTokens` 由 `dsh-token-meter` 从真实请求算出，模型看不到自己的 prompt
  有多大；而提示只有在**一轮结束之后**才有意义（那一轮的 prompt 已经发出去了）。何况任何「让模型自己注意上下文」
  的做法都要注入 prompt 段落或注册工具 —— 那等于给一个**上下文税问题**再加一笔上下文税。
- **你手上没有读数。** 占用率可以看见，但「该收尾了」不是一次读数能定的：它需要迟滞、冷却、边沿触发、跨会话计数，
  而且要在你**点进一个已经满了的历史会话**时就响。没人一边干活一边盯百分比。

### 它做了什么 —— 以及刻意不做什么

- **上下文税 = 0**：不注册 model-facing 工具、不注入 prompt 段落、不发额外请求。防上下文膨胀的东西，自己不能吃上下文。
- **只消费官方计量器已经算好的数字**：不重复计量、不估算、不猜。
- **每档只响一次，且只在一轮结束时**：双档 + 迟滞 + 边沿触发 + 冷却。
- **fail-closed**：没有分母就完全不判定，徽标显示 `ctx —` 而不是假装 0%。
- **把一句话变成动作**：跨过 `warnRatio` 就地起草一块机器事实草稿（会话、水位、账本花费、本会话写过的文件、
  最近几轮的诉求 / 回应预览，外加「待补」空槽）写进会话工作目录 —— 零 LLM、零额外请求。
- **本插件不联网**（v0.5.0 起删除了微信外推）；能力清单只剩 `fs-read` / `fs-write`。

### 这一节**不**声称什么

- **省下的钱是反事实上界，不是承诺。** 拿本机账本重放：≥40% 占用时发生的那 2741 次调用，若都发生在 0–20%，
  可省 **¥59（23%）**；≥60% 的那批可省 **¥34（14%）**。收尾不是免费的 —— 它恰好要付一次交接的成本。
  这里只声称一件事：**把数字摆在面前时，这个决定能做得更好。**
- **阈值是标定值，不是最优解。** 0.45 / 0.60 来自那 84 个会话；它们是默认值，且每一个都可配置。
- **样本是单机、单 provider、两周。** 价格与压缩行为都会变。
- **它不判断你的任务值不值得做完。** 它只说一句：从这里继续，每轮比重新开始贵好几倍 —— 交接草稿在这里。

## 它做什么

| 半边 | 做什么 |
|---|---|
| **host**（`lib/index.js`） | 订阅 `ctx.sessionProjections.onChanged`，把 `contextPressure` 喂给纯策略；在 `turn/end` 结算一轮；持有设置；`session/created`（新建或从存储恢复）时立刻判一次；`compaction/end`、`request/header` 参与判定；把判定注册成 `contextGuard` **wire 投影**给浏览器半边；注册 `GET /api/context-guard/state`（只读调试镜像）；按设置把结论外推到微信；跨过阈值时**起草交接草稿** |
| **client**（`lib/client.js`，手写单文件 bundle） | 会话头**徽标**（实时占用率，只显示数字、不出声）+ 跨档时**一次性 banner**（占比 + 下一步 + 指向交接文档）；档位/轮次/冷却一律 `useProjection("contextGuard")` **只读**宿主投影 —— 没有本地状态机、不读阈值、不发额外请求（见下面「架构」一节） |

行为要点：

- **判定时机 = 投影变化时（不是 `turn/end`）**：`contextPressure` 在每次请求后更新，插件随即判一次；
  `turn/end` 只做**轮计数与冷却衰减**，`compaction/end` 与 `request/header` 参与判定。
  ⚠️ 早期本节写的是「绝不 mid-turn」，与实现不符。2026-10-17 代码审查后定案**保持实现、改文档**，
  理由是风险不对称：改成只在 `turn/end` 判，一旦该事件没送到就**完全不提示**（漏报）；
  投影即判最坏只是提示出现得早一点。详见 `HANDOVER.md` §33。
- **只响一次**：双档 + 迟滞（回落到 `warn − hysteresis` 才重新武装）+ 边沿触发 + 冷却 N 轮。
- **跨档时给你两个选择**：`写好交接，我复制`（宿主立刻写一次机器事实草稿，并把可复制的开场文本摆出来）与 `知道了`（纯关闭，没有附带动作）。
- **fail-closed**：没有分母（`contextWindow` 缺席）就不判定，徽标显式显示 `ctx —`，**不假装 0%**。

## 架构（v0.4.3）：宿主判，浏览器只读（一份判定）

判定只有一处、显示只有一处，中间靠一条 `wire` 投影连着：

| 层 | 在哪 | 负责什么 |
|---|---|---|
| **判定** | `lib/engine.mjs`（**只在宿主**） | 状态机是纯折叠（`init` + `apply(state, event)`）：档位 / 武装 / 轮次 / 冷却 / 迟滞只算一遍，`compaction/*` 折算进状态 |
| **投影** | `lib/index.js`（宿主） | 把判定注册成 `wire` 投影 **`contextGuard`**：`{ level, armed, turn, cooldown, ratio }`，扁平 JSON，未变化时保持同一引用 |
| **显示** | `lib/client-source.js`（浏览器） | `useProjection("contextGuard")` **只读**显示（徽标 + 一次性 banner）；没有阈值、没有状态机、不发额外请求 |
| **调试镜像** | `GET /api/context-guard/state` | 只读镜像：宿主当前配置 / 最近判定 / 压缩账计数 / 交接统计。浏览器半边**不再**从它抄阈值 |

这样分工换来两件事：

- **一套判定**。以前浏览器半边自带状态机，启动时再从状态路由抄一份阈值 ⇒ 两套冷却、两套迟滞，
  `settleTurn` 还挂在 banner 按钮上（点一下就能在客户端推进轮次）。现在判定只住在 `lib/engine.mjs`，
  连 bundle 里都没有它 —— 这是结构性的：`test/client-sync.test.mjs` 还会静态禁用
  `hostSync` / `setConfig` / `settleTurn` 这些标识符。
- **读到什么就显示什么**。排障面 `window.__DSH_CONTEXT_GUARD__.store.dump()`（全部会话）与
  `viewOf(sessionId)`（单个会话）记录的是**宿主投影说了什么**，不是客户端算了什么；
  投影缺席（旧宿主 / 没装 token-meter）时徽标仍显示占用率，但**不出 banner** ——
  宁可少提示，也不退回本地自算一份。

## 安装

> ⚠️ **别敲 `npm i dsh-context-guard`。** 不带 scope 的 `dsh-context-guard` 归**第三方**所有
> （`greenlv <lgr5945@gmail.com>`；latest `0.2.1`，现已 deprecated 并改名为 `dsh-completion-guard`）。
> 敲那条命令装到的是**他们的**插件，不是这个。本插件的包名是 scoped 的
> **`@2jumpsina/dsh-context-guard`**，已发布到 npm。

### 装进 DSH（推荐）

`dsh plugin` 只是 pnpm 的薄封装：它在 **profile 目录里**做包管理，然后把这个新 bundle 登记进
profile。一条命令，其余全自动：

```powershell
dsh plugin --profile web add @2jumpsina/dsh-context-guard
```

DSH 随后会替你做好这些（都在真机 profile 上验证过）：把依赖写进该 profile 的 `package.json` ·
把包名追加进 `dsh.profile.bundles` —— **这一步才是「它成了一层插件」** · 应用包内
`cordis.patch.yml` 挂上宿主半边，并按 `dsh.client` 声明注入浏览器半边。

⚠️ **装完要重启 dsh。** 源码改动不自愈，新装上的层在启动时才生效。

⚠️ **「装包」≠「挂上」。** 单独 `npm i` 只把文件放进 `node_modules`，不会改任何 profile。

### 从本仓库安装（想跑最新源码时）

```powershell
dsh plugin --profile web add git+ssh://git@github.com/2JumpSinA/dsh-context-guard.git
```

前提：机器上有 `git`，且 GitHub SSH 密钥已配好。⛔ 别用 `github:` 简写
（`dsh plugin --profile web add github:2JumpSinA/dsh-context-guard`）—— 它会被解析成 **HTTPS** clone，
在某些网络下会失败，而报错完全不提「传输方式」这回事。要用就走上面的 `git+ssh://` 或 npm 包名。

### 纯 npm（不用 DSH 的包管理）

只想把文件取下来、自己挂：

```bash
npm i @2jumpsina/dsh-context-guard
```

**本地开发时**（不发布、用 junction 挂进某个 profile）也常见：

```powershell
# 把仓库挂进目标 profile 的 node_modules（路径按你的环境替换）
New-Item -ItemType Junction `
  -Path   $env:DSH_HOME\profiles\<profile>\node_modules\@2jumpsina\dsh-context-guard `
  -Target <仓库路径>
```

然后在那个 profile 的 `cordis.patch.yml`（用户 patch 层）末尾加一条 `insert`：

```yaml
- insert:
    - id: context-guard
      name: '@2jumpsina/dsh-context-guard'
```

> ⚠️ 不要把这个包写进 profile 的 `dsh.profile.bundles` —— 会报 `cannot resolve profile bundle`。
> ⚠️ junction 挂载后，Node 从**真实路径**往上找 `node_modules` ⇒ 仓库里要有它自己的依赖（或让 DSH 从安装位置解析）。

## 配置项

设置页可改，全部即时生效；`config` 字段都是 volatile ⇒ 改完**不用重启**（但改**源码**要重启，见下）。

| 字段 | 默认 | 范围 | 含义 |
|---|---|---|---|
| `enabled` | `true` | bool | 总开关 |
| `locale` | `auto` | `auto`\|`zh`\|`en` | 文案语言；`auto` 由两半边各自推断（宿主看会话首条输入，浏览器看 `navigator.language`，均兜底中文）。⚠️ 这一项**只作用于宿主侧**（草稿块 / 宿主日志 / 推送），浏览器侧的强制项是加载前逃生阀，见「语言」一节 |
| `warnRatio` | `0.45` | 0.1–0.95 | 「该收尾了」的占用率（`projectedTokens / contextWindow`） |
| `hardRatio` | `0.60` | 0.1–1 | 「该换会话了」；必须 > `warnRatio` |
| `hysteresisRatio` | `0.05` | 0–0.2 | 迟滞：回落到 `warn − 此值` 以下才重新武装 |
| `cooldownTurns` | `5` | 0–100 | 跨档后静默多少轮 |
| `onResume` | `true` | bool | 进入一个已经很高的历史会话时也提示 |
| `respectCompaction` | `true` | bool | 自动压缩正在压水位时不提示换会话 |
| `crossSessionTrend` ~ | `true` | bool | **v0.5.0 起 no-op**（趋势已删，仅为兼容旧配置保留） |
| `trendWindowHours` ~ | `24` | 1–168 | **no-op** |
| `trendEscalateAt` ~ | `3` | 2–20 | **no-op** |
| `pushChannel` ~ | `none` | `none`\|`wechat` | **no-op**（外推已删；填 wechat 也不会有任何推送） |
| `pushMinLevel` ~ | `hard` | `warn`\|`hard` | **no-op** |
| `pushCooldownMinutes` ~ | `10` | 0–1440 | **no-op** |
| `handoverOnWarn` | `true` | bool | 跨过 `warnRatio` 时自动起草交接草稿 |
| `handoverPath` | `HANDOVER.md` | string | 相对**会话工作目录**，或绝对路径 |
| `handoverRefreshPercent` | `5` | 1–25 | 水位每再涨这么多点刷新一次草稿 |
| `handoverTurns` | `6` | 1–20 | 草稿里带几轮「诉求 / 回应」摘要 |
| `handoverFiles` | `12` | 1–50 | 草稿里带几个最近写过的文件 |

> `warnRatio` 的 schema 下限是 **0.1**：配 `0.05` 之类的值会让整个插件挂不上
> （`ValidationError: invalid config: $.warnRatio expected number >= 0.1`，状态路由随之 404）。

## 语言 / Language

所有给人看的文案都是双语的（中文 + 英文）：banner、草稿块、宿主日志，以及徽标 / banner 的 UI 文字。
默认 `auto`，两半边**各自解析** —— 它们能看到的线索本来就不一样：

| 半边 | `auto` 看什么 | 兜底 |
|---|---|---|
| 浏览器（徽标 tooltip + banner） | 加载前逃生阀 `window.__DSH_CONTEXT_GUARD__.config.locale` > `navigator.language`（以 `zh` 开头 ⇒ 中文，其余 ⇒ 英文） | 中文 |
| 宿主（草稿块 + 日志 + 推送） | 该会话**首条用户输入**里有没有汉字（`titleInput` —— 走注册表的宿主状态 `stateOf` 读，它没有 `wire`、`onChanged` 收不到） | 中文 |

- **浏览器侧语言 = 加载前逃生阀 `config.locale` > `navigator.language` > `zh`。** 逃生阀必须**在 bundle
  加载之前**预置（`addInitScript` 之类）：语言在模块求值时就固化了。它默认不存在 ⇒ `auto` 几乎总是
  按浏览器语言推断。
- **宿主侧的 `locale` 只影响宿主自己的面**（草稿块、宿主日志的文案）。v0.4.3 起浏览器半边
  **不再**从宿主读语言（那次 `GET /state` 已经拆掉），所以「写 `locale: 'zh'` 让两半边都说中文」
  这句话**不再成立** —— 想强制浏览器侧，只有上面那个**加载前**逃生阀。
- **设置页的字段说明**永远是「English / 中文」合并式一行：DSH 的 config schema 是加载期静态元数据，
  没有 per-locale 描述机制，设置页也无从知道你在看哪个会话。（将来 DSH 支持按 locale 描述，
  这些字符串就搬进文案表，这条注释随之删掉。）
- **逃生阀**：没有会话可看时（启动日志、设置页、状态路由），宿主半边读环境变量
  `DSH_CONTEXT_GUARD_LOCALE=zh|en`；其它取值一律忽略。
- 面向机器的面在任何语言下都是英文：状态路由的 JSON 键名、config 字段名、日志 `code`。
  被翻译的只有给人看的句子。
- 下面那段草稿示例是**中文**会话产出的样子；英文会话结构完全一致，只是标签是英文。

## 宿主状态路由

`GET /api/context-guard/state` —— **只读调试镜像**：给 `curl`、排障和验收脚本看宿主当前的判定设置与统计。
⚠️ v0.4.3 起浏览器半边**不再**从它取数据（档位/冷却走 `contextGuard` 投影，见「架构」一节），
所以它坏掉不会影响徽标与 banner —— 但会让排障少一只眼。

```jsonc
{
  "plugin": "context-guard",
  "at": 1790000000000,
  "config": { /* 上面那张表；handoverPath 只回相对名/文件名，绝不回绝对路径 */ },
  "recent": [ { "sessionId": "…", "level": "warn|hard", "ratioPercent": 52, "title": "…", "body": "…" } ],
  "ledger": { "written": 1, "failed": 0, "unchanged": 0,
              "last": { "at": 1790000000000, "status": "appended", "row": 1 } },
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
- **也能手动触发（v0.3.5）**：banner 上的「写好交接，我复制」会 `POST /api/context-guard/draft`，**跳过「水位涨够才刷」的步进闸门**立刻写一次，然后给出这段可复制的开场白：
  `@HANDOVER.md 接着这份交接继续。请先把「待补」补完再继续任务。` —— 粘到新会话即可接着干。
  （路由与状态路由一样是**本机无认证**的：响应里只回文件名，绝不回绝对路径。）
- **只写机器事实、不写结论** —— 插件不知道你干了什么。请让 agent 在「待补」里写结论/坑/下一步，
  或折进你自己的交接文档后把整块删掉。
- **素材从哪来（2026-09-30 真机核实，0.3.2 修正 —— 包名改成 `@2jumpsina` 作用域的第一个发布版本）**：机器事实取自**宿主状态真源** ——
  注册表 `sessionProjections.stateOf(session, key)`，而**不是**投影变更推送的 **wire 视图**。
  原因：`contextTimeline`（由 `dsh-context` 这类插件注册）的 wire 视图在按需 detail 通道启用后
  是个 **slim head**：水位/规模/工具分布/花费都在，**唯独没有 `fileOps`** —— 重集合只存在于单元
  状态里。v0.3.0 只读 wire 视图 ⇒「改过的文件」永远是 0 个（**恢复会话与会话运行中完全一样**，
  不是两条路的差别）；另外 `turnOutline` 的 wire 视图是**数组**而 v0.3.0 按 `{turns}` 读 ⇒
  「最近几轮」永远印「宿主没有提供」。两处均已修，并各有单测/自检守着。
- **依赖与降级**：`fileOps`、工具分布依赖注册 `contextTimeline` 的插件（如 `dsh-context`）；
  花费依赖 `tokenCost`（如 `dsh-damage-pulse`）。它们缺席时对应段落显示为空 —— 插件**不编造**
  也不失败；宿主注册表若没有 `stateOf`（老版本），自动退回 wire 视图（即 v0.3.0 的行为）。

### 保真的边界（v0.3.6，读这一节比读功能列表有用）

| 东西 | 保真度 | 为什么 |
|---|---|---|
| 会话 / 水位 / 花费 / 改过的文件 / 时间 | **高（可核对）** | 全部来自官方投影；插件不改写、不估算。数字对不上就是宿主投影的问题，不是叙述的问题 |
| **最近 N 轮摘要** | **中（截断）** | 那是压缩后的「诉求 / 回应」，不是原文 ⇒ 只能当**线索**，不能当证据 |
| **待补（结论 / 坑 / 下一步）** | **空** | 插件不判断你干了什么。这三条要由**看过完整对话的人**（你，或旧会话的 agent）来写 |

两个推论，很重要：

1. **只看到摘要的新会话 agent 会「推断」** —— 它没见过那几十轮里的失败尝试、被否掉的方案、口头约定。
   所以请把它补的结论当**草稿**读，不对就改。
2. **旧会话的 agent 写结论比新会话准**（它还在上下文里）。按钮负责零成本的机器事实；结论建议在旧会话里
   一句话让它写，写进块**外**的正文。

> **人工区不会被刷新冲掉（v0.3.6）**：`待补` 区有独立子标记 `<!-- dsh-context-guard:todo:begin/end -->`；
> 水位再涨触发刷新时**只更新上面的机器事实**，`待补` 里的内容原样保留。
> （≤0.3.5 的老块没有这对子标记，靠 `- [ ]` 行锚点兼容一次。）

## 阈值与设计取舍（为什么是 0.45 / 0.60）

- **占用率 = `projectedTokens / contextWindow`**（官方口径：**下一次**请求的 prompt 有多大，不含 output）。
  一律用比率：换模型即换窗口。
- **成本随占用率上升**：按官方定价把「每次调用成本」对占用率拟合，高档位每次调用约是空会话的数倍，
  越晚收尾越贵；越早换会话省下的越多，代价只有一份交接（把它写短）。
- **0.60 这个 hard 线是刻意早于平台自己的动作**：观测到的会话峰值从未超过约 80%（平台自身会在 ~80% 处
  **静默压缩**）。把 hard 放在 80% 会与它抢同一时刻，而 `respectCompaction: true` 又会在被压缩后抑制提示
  ⇒ hard 档可能**永远不出声**。
- **说真话（v0.6.0）**：硬档正文会直接写明「平台约 80% 会自行压缩，压掉的内容拿不回来」。
  注意口径：**不是**「读数永久消失」—— 本插件的压缩账会抢存一行（没记下才是真没了）。
- 两档的分工：`warnRatio` = 开始收尾/写交接；`hardRatio` = 换会话。

## 压缩账（v0.5.0）

平台压缩之后，**压缩前的读数会从平台投影里永久消失**（平台自己吃掉了自己的证据；插件只能抢存一份）。
插件在 `compaction/end` 时往工作目录的 `HANDOVER.md` 追加一行账（独立标记块，**不会被草稿刷新冲掉**）：

```markdown
<!-- dsh-context-guard:ledger:begin -->
### 🗜️ 压缩账（自动追加，勿手改）

| # | 时间 | 会话 | 压缩前峰值 | 尺寸 | 累计花费 | 改过文件 | 事件 |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-19 15:42 | a4b6cffb | 79.8% | ≈160K/1000K | ¥1.84 | 5 | 7f19c0a1 |
<!-- dsh-context-guard:ledger:end -->
```

三条不变量：**按 `compactionId` 幂等**（同一事件重复投递只落一行）、**取压缩前峰值**（不是压缩后的低值）、
**失败不静默**（写失败计入 `/state.ledger.failed`）。压缩后 banner 的降级态会多一行回执：
「压缩前 79.8% · 账本第 1 行 · 现在 20%」。

> 与 `handoverOnWarn` **解耦**：关掉自动起草是关提示，不是关记录。

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

**如果是用 `dsh plugin add` 装的**（正规路径）：一条命令，登记与依赖会被自动对账清掉，
然后**重启那个 dsh 进程**。

```powershell
dsh plugin --profile web remove @2jumpsina/dsh-context-guard
```

**如果是手工 junction 挂的**（本地开发）：删掉 profile 的 `cordis.patch.yml` 里那条 `insert`
（以及设置页可能写在同文件里的 `- id: context-guard` 配置行），
再删掉 profile 的 `node_modules\@2jumpsina\dsh-context-guard`，然后**重启那个 dsh 进程**。
（用 `cmd /c rmdir` 删 junction：**只删链接、不要删到仓库本身**。）

## License

[MIT](./LICENSE)
