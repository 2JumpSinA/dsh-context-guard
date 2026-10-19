/**
 * dsh-context-guard · node 半边入口
 *
 * 只做三件事，全部是**只读消费**：
 *   1. 订阅 `ctx.sessionProjections.onChanged`，把官方 token-meter 已经算好的
 *      `contextPressure`（provider 锚定的「下一次请求 prompt 会有多大」）喂给纯策略；
 *   2. 在**日志事件** `turn/end` 上结算一轮（§10.4：绝不 mid-turn 判定 ——
 *      那轮已经发出去了，提示没有意义）；
 *   3. 持有设置真源（schemastery `Config`）+ 跨会话趋势，并把结论写进运行日志。
 *
 * ⛔ **上下文税 = 0** —— 这是本插件最该守住的性质（§10.2）：
 *     不注册 model-facing 工具、不注入 system-prompt 段落、不碰 messages / `llm/stream`，
 *     不产生任何额外请求，也不打断 KV 前缀缓存。
 *
 * ⛔ 阈值必须由本插件持有（§10.1 末尾）：官方 `TokenMeterConfig = Record<string, never>`，
 *     计量器**故意没有任何设置项**，阈值只能住在消费侧。
 *
 * ⚠️ 真机代际与事件形状（2026-09-23 实测，别照抄网上的教程）：
 *   - **`turn/end` 不是 `ctx.on` 事件名**。会话服务在 `ctx.on` 上只声明了
 *     `session/created` / `session/disposed` / `session/event` / `session/flush` 四个；
 *     `turn/end`、`compaction/*`、`model/selection` 都是**日志事件**，必须走
 *     `ctx.on('session/event', (session, event) => …)` 再按 `event.type` 分派。
 *   - 也**没有 `ctx.session` 这个服务**。
 *   - `contextPressure` 这个键属于 **dsh-token-meter**（declaration merging 挂进
 *     `SessionProjectionMap`），token-meter 一卸载键就消失 ⇒ 三个字段全 optional，
 *     一律 fail-closed（policy.readOccupancy 负责）。
 *   - `sessionProjections` **不写进 `inject`**：按官方注释，容忍缺席要用
 *     `ctx.inject(['sessionProjections'], …)`；硬 inject 缺席会让 fiber 停在 PENDING 静默不加载。
 *   - `reusable` 不是 API，别 export。
 */
import Schema from '@deepseek-ai/schemastery';
import { appendFileSync } from 'node:fs';
import { makeT, pickLocale } from './i18n.mjs';
import {
  describe as describeSignal,
  defaultConfig,
  readOccupancy,
  plainConfig,
  STATE_ROUTE,
  DRAFT_ROUTE,
} from './policy.mjs';
import { createGuardEngine, MIRROR_KEY, MIRROR_STATE_VERSION, mirrorStateSchema, mirrorViewSchema } from './engine.mjs';

// ⚠️ **只被宿主半边用**：`handover.mjs` import 了 node:fs / node:path，
//    所以它绝不能进 client bundle（bundle 只内联 policy.mjs + client-source.js）。
import { basename, isAbsolute } from 'node:path';

import {
  appendLedgerRow,
  changedFiles,
  composeHandoverBlock,
  fmtTime,
  probeFiles,
  readTodoFilled,
  resolveHandoverPath,
  writeHandoverBlock,
} from './handover.mjs';

export const name = 'context-guard';

/** 不需要任何硬依赖服务：`sessionProjections` 走软 inject（见文件头）。 */
export const inject = [];

/** 官方投影键。字符串写死是安全的：它是 token-meter 的 wire 契约名。 */
const KEY = 'contextPressure';

/**
 * 启动信标：只在 `DSH_CONTEXT_GUARD_BEACON` 指向一个文件路径时才写一行 JSON。
 *
 * 为什么需要它：「插件真被 profile 装载、`apply()` 真跑过」这件事在 headless 里
 * **没有别的可观测面** —— `--dump-config` 只组合配置层、不执行 init（因此退出码 0 不是验收），
 * 而 cordis 的启动日志默认不去 stdout。于是留一个显式的、默认关闭的信标，
 * 让「真机装载」这句话有证据可查，而不是靠推断。
 * 任何写失败都吞掉 —— 提示插件绝不能因为一个排障开关把宿主拖下水。
 */
function writeBeacon(config) {
  const path = process.env.DSH_CONTEXT_GUARD_BEACON;
  if (typeof path !== 'string' || path.length === 0) return;
  try {
    appendFileSync(
      path,
      `${JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        plugin: name,
        event: 'apply',
        config,
        sessionProjections: 'inject-requested',
      })}\n`,
      'utf8',
    );
  } catch {
    /* 信标失败不影响任何功能 */
  }
}

/**
 * 设置 schema（§10.7）。字段**必须 `.volatile()`**：`dsh-settings` 用 `volatileForm(schema)`
 * 决定这一条 entry 有没有设置页 —— 一个 volatile 节点都没有时它返回 `undefined`，
 * 整页设置直接不生成（`dsh-settings/lib/index.js:418-419`），写入时还会抛
 * `Plugin entry "<ns>" has no volatile fields`。这是踩过的坑（profile 的 `cordis.patch.yml`
 * 里 `installSection` 那条注释是同一个 API 分裂的产物）。
 *
 * schemastery 没有 `label`，表单渲染的是属性名，人话写在 `description` 里。
 *
 * ⚠️ **这些 `description` 不走 `lib/i18n.mjs`**（§19.6.2 第 3 条的刻意选择）：schema 是**加载期静态
 * 元数据**，DSH 没有 per-locale 描述机制，设置页也无从知道会话语言 ⇒ 这里用「English / 中文」
 * 合并式，两种语言下都可读，且不需要任何机制。**将来 DSH 若支持按 locale 描述，这里换成查表即可。**
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description(
      'Master switch. When off, the plugin keeps serving and logging but shows no prompts. / ' +
        '总开关。关掉后插件只留服务与日志，不出任何提示。',
    )
    .volatile(),
  locale: Schema.union(['auto', 'zh', 'en'])
    .default('auto')
    .description(
      'Text language for banners, the handoff draft and host logs. auto resolves per half: the browser half ' +
        'reads navigator.language, the host half checks whether the session\u2019s first user input contains Chinese ' +
        'characters; with no clue at all it falls back to zh. DSH_CONTEXT_GUARD_LOCALE is the escape hatch for ' +
        'settings-page and startup logs. / ' +
        'banner、草稿块与宿主日志的语言。auto 由两半边各自解析：浏览器半边看 navigator.language，' +
        '宿主半边看该会话首条用户输入是否含汉字；两边都没线索时兜底 zh。' +
        '设置页与启动日志可用环境变量 DSH_CONTEXT_GUARD_LOCALE 兜底（逃生阀）。',
    )
    .volatile(),
  warnRatio: Schema.number()
    .min(0.1)
    .max(0.95)
    .default(0.45)
    .description(
      'Occupancy threshold for \u201ctime to wrap up\u201d (projectedTokens / contextWindow). Always a ratio, never ' +
        'absolute tokens. The 0.45 default is calibrated against the occupancy-to-cost curve (see README, ' +
        '\u201cThresholds and tradeoffs\u201d). / ' +
        '「该收尾了」的占用率阈值（projectedTokens / contextWindow）。一律用比率，不用绝对 token。' +
        '默认 0.45 由「占用率 → 成本」曲线标定（见 README「阈值与设计取舍」）。',
    )
    .volatile(),
  hardRatio: Schema.number()
    .min(0.1)
    .max(1)
    .default(0.6)
    .description(
      'Occupancy threshold for \u201cstart a new session\u201d. Must be greater than warnRatio. The 0.6 default ' +
        'deliberately stays ahead of the platform\u2019s automatic compaction at ~80%. / ' +
        '「该换会话了」的占用率阈值。必须大于 warnRatio。默认 0.6 刻意早于平台 ~80% 的自动压缩点。',
    )
    .volatile(),
  hysteresisRatio: Schema.number()
    .min(0)
    .max(0.2)
    .default(0.05)
    .description(
      'Hysteresis: occupancy must fall below warnRatio minus this value before the guard re-arms (stops it ' +
        'firing again at the same level). / ' +
        '迟滞：占用率要回落到 warnRatio 减去这个值以下，才重新武装（防止在同一水位反复响）。',
    )
    .volatile(),
  cooldownTurns: Schema.number()
    .min(0)
    .max(100)
    .step(1)
    .default(5)
    .description(
      'How many turns to stay quiet after a level crossing, to avoid repeat prompts. / 跨档后静默多少轮，避免刷屏。',
    )
    .volatile(),
  onResume: Schema.boolean()
    .default(true)
    .description(
      'Also prompt when you open an already-full historical session (this is what \u201ccross-session\u201d really ' +
        'means: nobody warned you before you entered). / ' +
        '进入一个已经很高的历史会话时也提示（这才是「跨会话」的实质：进去之前没人告诉你）。',
    )
    .volatile(),
  respectCompaction: Schema.boolean()
    .default(true)
    .description(
      'Do not suggest switching sessions while automatic compaction is pressing the level down: only \u201cstill ' +
        'above the threshold after compaction\u201d counts. / ' +
        '自动压缩正在压水位时不必提示换会话：只在「压缩后仍高于阈值」才算数。',
    )
    .volatile(),
  // —— v0.5.0：趋势与外推的行为已删除。这六个键**保留为 no-op**（只为了兼容旧 profile 里的配置：
  //    schema 不认键会让插件 init 失败 ⇒ 整机起不来）。设置页仍会显示它们，描述里写明已停用。
  crossSessionTrend: Schema.boolean()
    .default(true)
    .description('（已停用 v0.5.0：跨会话趋势已删除，此键仅为兼容旧配置保留。）')
    .volatile(),
  trendWindowHours: Schema.number()
    .min(1)
    .max(168)
    .step(1)
    .default(24)
    .description('（已停用 v0.5.0：仅为兼容旧配置保留，无任何作用。）')
    .volatile(),
  trendEscalateAt: Schema.number()
    .min(2)
    .max(20)
    .step(1)
    .default(3)
    .description('（已停用 v0.5.0：仅为兼容旧配置保留，无任何作用。）')
    .volatile(),
  pushChannel: Schema.union(['none', 'wechat'])
    .default('none')
    .description('（已停用 v0.5.0：微信外推已删除，此键仅为兼容旧配置保留；填 wechat 也不会有任何推送。）')
    .volatile(),
  pushMinLevel: Schema.union(['warn', 'hard'])
    .default('hard')
    .description('（已停用 v0.5.0：仅为兼容旧配置保留，无任何作用。）')
    .volatile(),
  pushCooldownMinutes: Schema.number()
    .min(0)
    .max(1440)
    .step(1)
    .default(10)
    .description('（已停用 v0.5.0：仅为兼容旧配置保留，无任何作用。）')
    .volatile(),
  handoverOnWarn: Schema.boolean()
    .default(true)
    .description(
      'When the session crosses warnRatio, draft/refresh a block of machine facts in the working directory\u2019s ' +
        'HANDOVER.md (session / occupancy / cost / changed files / last turns). Zero LLM, zero extra requests; ' +
        'the narrative is left to the agent. / ' +
        '跨过 warnRatio 时，自动在工作目录的 HANDOVER.md 里起草/刷新一块「机器事实交接」' +
        '（会话/水位/花费/改过的文件/最近几轮摘要）。零 LLM、零额外请求，叙述留给 agent。',
    )
    .volatile(),
  handoverPath: Schema.string()
    .default('HANDOVER.md')
    .description(
      'Handoff file: relative to the **session working directory**, or an absolute path. / ' +
        '交接文件：相对**会话工作目录**，或写绝对路径。',
    )
    .volatile(),
  handoverRefreshPercent: Schema.number()
    .min(1)
    .max(25)
    .step(1)
    .default(5)
    .description(
      'Refresh the draft every time occupancy rises by this many percentage points (45 → 50 → 55 → 60…). / ' +
        '水位每再上升这么多个百分点，就刷新一次草稿（45 → 50 → 55 → 60…）。',
    )
    .volatile(),
  handoverTurns: Schema.number()
    .min(1)
    .max(20)
    .step(1)
    .default(6)
    .description(
      'How many \u201crequest / response\u201d turns to include in the draft. / 草稿里带几轮「诉求 / 回应」摘要。',
    )
    .volatile(),
  handoverFiles: Schema.number()
    .min(1)
    .max(50)
    .step(1)
    .default(12)
    .description(
      'How many recently changed files to include (write operations only). / ' +
        '草稿里带几个「最近改过的文件」（只取 write 类操作）。',
    )
    .volatile(),
});

/**
 * 把 schema 解析出来的配置再收敛一道（夹取范围、保证 hard > warn）。
 * 纯函数，单测直接跑它。
 *
 * ⚠️ 入口第一件事是 `plainConfig()` 摊平 volatile 引用 —— 见 `policy.mjs` 里那条注释，
 * 不摊平就是「设置页显示 0.33、插件按 0.6 判断」这种无声事故。
 */
export function normalizeConfig(raw) {
  const cfg = defaultConfig();
  const source = plainConfig(raw);
  const num = (value, fallback, min, max) => {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, n));
  };
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const str = (value, fallback, max = 400) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : fallback;
  const merged = {
    ...cfg,
    enabled: bool(source.enabled, cfg.enabled),
    warnRatio: num(source.warnRatio, cfg.warnRatio, 0.1, 0.95),
    hardRatio: num(source.hardRatio, cfg.hardRatio, 0.1, 1),
    hysteresisRatio: num(source.hysteresisRatio, cfg.hysteresisRatio, 0, 0.2),
    cooldownTurns: num(source.cooldownTurns, cfg.cooldownTurns, 0, 100),
    onResume: bool(source.onResume, cfg.onResume),
    respectCompaction: bool(source.respectCompaction, cfg.respectCompaction),
    includeCacheShare: bool(source.includeCacheShare, cfg.includeCacheShare),
    crossSessionTrend: bool(source.crossSessionTrend, cfg.crossSessionTrend),
    trendWindowHours: num(source.trendWindowHours, cfg.trendWindowHours, 1, 168),
    trendEscalateAt: num(source.trendEscalateAt, cfg.trendEscalateAt, 2, 20),
    // 语言：白名单收敛（不认识的取值一律回 `auto`，而不是悄悄变成某种语言）。
    locale: source.locale === 'zh' || source.locale === 'en' ? source.locale : 'auto',
    // 枚举一律白名单收敛：**不认识的通道退回 none**（宁可闭嘴，也不要推错地方）。
    pushChannel: source.pushChannel === 'wechat' ? 'wechat' : 'none',
    pushMinLevel: source.pushMinLevel === 'warn' ? 'warn' : 'hard',
    pushCooldownMinutes: num(source.pushCooldownMinutes, cfg.pushCooldownMinutes, 0, 1440),
    // 自动交接草稿：`handoverPath` 走字符串白名单（空串 ⇒ 退回默认，绝不让它变成写根目录）。
    handoverOnWarn: bool(source.handoverOnWarn, cfg.handoverOnWarn),
    handoverPath: str(source.handoverPath, cfg.handoverPath),
    handoverRefreshPercent: num(source.handoverRefreshPercent, cfg.handoverRefreshPercent, 1, 25),
    handoverTurns: num(source.handoverTurns, cfg.handoverTurns, 1, 20),
    handoverFiles: num(source.handoverFiles, cfg.handoverFiles, 1, 50),
  };
  // hard 必须严格大于 warn，否则「双档」退化成一档、迟滞也就没意义了。
  if (!(merged.hardRatio > merged.warnRatio)) {
    merged.hardRatio = Math.min(1, merged.warnRatio + 0.05);
  }
  return merged;
}

/**
 * 一台会话一个状态机。刻意不做 LRU 上限的「聪明」限制：状态是几个标量的对象，
 * 一千个会话也就几十 KB；而按会话淘汰会带来「点回旧会话时提示重新武装」的假提示。
 * v0.5.0：趋势已删，内存风险只剩按会话的四个 Map（见 `session/disposed` 的清理 TODO）。
 */
export { createGuardEngine } from './engine.mjs';

/**
 * 插件主体。
 *
 * ⚠️ `rawConfig` 里标了 volatile 的字段是**引用**，值会随设置页写入而变 ⇒
 * **不能只在挂载时读一次**。这里保留 `rawConfig`，并在每个入口（投影变化、轮结束、
 * 会话打开、状态路由读取）先 `refreshConfig()`：变了就换进 engine，下一轮立即按新阈值判断。
 * 这就是「设置页改完不用重启」的落地方式（写文件≠生效，读引用才是）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const engine = createGuardEngine(config);
  // 服务名与包名解耦：别的消费者（以及将来的 client 半边）按能力名取。
  ctx.provide('contextGuard', engine);
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger;
  const info = (msg) => (logger?.info ? logger.info(msg) : undefined);
  const warn = (msg) => (logger?.warn ? logger.warn(msg) : undefined);

  /**
   * 宿主日志的语言（§19.6.2 第 4 条）。**每次调用现算**：设置页改完 `locale` 之后要立即用新语言，
   * 缓存一份就会印旧语言。没有会话上下文的场合（挂载 / 设置变更 / 状态路由）走这条：
   * 显式设置 > `DSH_CONTEXT_GUARD_LOCALE` > `zh`。有会话的场合用下面的 `localeOf()`。
   */
  const bootT = () => makeT(pickLocale(engine.config.locale, { env: process.env.DSH_CONTEXT_GUARD_LOCALE }));

  /**
   * 重新解析一次生效配置（volatile 字段读当前值）。只在**真的变了**时换进去并记一行日志，
   * 免得每轮都刷日志、也免得把一个恒等的对象换来换去。
   * @returns {object} 当前生效配置
   */
  const refreshConfig = () => {
    let next;
    try {
      next = normalizeConfig(rawConfig);
    } catch (error) {
      warn(bootT()('log.config.parseFailed', { name, error: error?.message ?? error }));
      return engine.config;
    }
    const current = engine.config;
    const changed = Object.keys(next).some((key) => next[key] !== current[key]);
    if (!changed) return current;
    engine.setConfig(next);
    info(
      bootT()('log.config.updated', {
        name,
        warn: next.warnRatio,
        hard: next.hardRatio,
        cooldown: next.cooldownTurns,
        enabled: next.enabled,
      }),
    );
    return next;
  };

  info(
    bootT()('log.mounted', {
      name,
      warn: config.warnRatio,
      hard: config.hardRatio,
      hysteresis: config.hysteresisRatio,
      cooldown: config.cooldownTurns,
      onResume: config.onResume,
      enabled: config.enabled,
    }),
  );
  writeBeacon({
    enabled: config.enabled,
    warnRatio: config.warnRatio,
    hardRatio: config.hardRatio,
    hysteresisRatio: config.hysteresisRatio,
    cooldownTurns: config.cooldownTurns,
    onResume: config.onResume,
  });

  /** 一处格式化，避免日志与 UI 措辞各写一套（语言跟着**那次提示**走：`described.lang`）。 */
  const logHit = (hit) => {
    const d = hit.described;
    if (!logger?.warn) return;
    const t = makeT(d.lang === 'en' ? 'en' : 'zh');
    logger.warn(t('log.hit', { name, title: d.title, body: String(d.body).split('\n').join(' ') }));
  };

  // ————————————————————————————————————————————————————————————————
  // ————————————————————————————————————————————————————————————————
  // v0.5.0：外推推送（微信）**已删除**。理由：136 个 IM 插件在做同一件事；它是本插件唯一
  // 需要 `network` capability 与外部服务（`wechatNotify`）的组件，删掉后能力清单只剩 fs 读写。
  // 配置键 `pushChannel` / `pushMinLevel` / `pushCooldownMinutes` **保留为 no-op**（见 Config 注释）：
  // 删键会让旧 profile 里写着 `pushChannel: wechat` 的用户在 schema 校验阶段失败 ⇒ 插件 init 失败
  // ⇒ 整机起不来（§19 的教训）。行为删、键不删。
  // ————————————————————————————————————————————————————————————————

  /**
   * 宿主状态读取路由 —— **这是 client 半边拿到「真源设置」的通路**（原先的未做完项）。
   *
   * 为什么用一条 HTTP 路由而不是 settings 远端：客户端的设置镜像
   * （`@deepseek-ai/dsh-client-ui-settings` 的 `SettingsDescribeMirror`）会一次读回**所有**命名空间，
   * 而本插件要的只是自己那几个阈值 + 一点运行时状态；自有路由的载荷是精确的、可 `curl` 直接验收的
   * （不需要浏览器就能证明宿主半边活着），而且不引入任何新的客户端依赖。
   * 与 damage-pulse 已装实现（`/api/token-monitor/usage`）走的是同一条路。
   */
  /**
   * 状态路由是**本机无认证**路由（安全审计 P1-2）⇒ 只回相对名/文件名，绝不回本机绝对路径。
   * 绝对路径会泄露用户名与目录结构；`handoverPath` 与 `handover.last.path` 都过这一层。
   */
  const publicPath = (p) => (typeof p === 'string' && isAbsolute(p) ? basename(p) : p);

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer;
    if (server === undefined || typeof server.register !== 'function') {
      warn(bootT()('log.web.noRegister', { name }));
      return;
    }
    webCtx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: STATE_ROUTE,
          handler: (_req, res) => {
            try {
              // 先刷新：浏览器半边读到的必须是**当前**设置（设置页改完刷新页面就该变）
              const live = refreshConfig();
              const payload = {
                plugin: name,
                at: Date.now(),
                // ⚠️ 这条路由**无认证**（宿主 webServer 的既有访问控制之外，插件不做校验）⇒ 绝不回本机绝对路径。
                config: { ...live, handoverPath: publicPath(live.handoverPath) },
                recent: engine.recent(10),
                // v0.5.0：`push` / `trend` 已删除；`ledger` 是记录工具唯一的命门（写失败必须可见）。
                ledger: {
                  written: ledgerState.written,
                  failed: ledgerState.failed,
                  unchanged: ledgerState.unchanged,
                  last: ledgerState.last,
                },
                handover: {
                  enabled: live.handoverOnWarn === true,
                  path: publicPath(live.handoverPath),
                  refreshPercent: live.handoverRefreshPercent,
                  written: draftState.written,
                  failed: draftState.failed,
                  skipped: draftState.skipped,
                  last: draftState.last,
                  history: draftState.history.slice(-3).reverse(),
                },
              };
              const body = JSON.stringify(payload);
              res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Length': Buffer.byteLength(body),
              });
              res.end(body);
            } catch (error) {
              // 路由自己抛异常会把响应挂死，所以这里必须兜住并给一个明确的 500。
              const body = JSON.stringify({ plugin: name, error: String(error?.message ?? error) });
              try {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(body);
              } catch {
                /* 响应已经废了，无可挽回 */
              }
            }
          },
        }),
      `${name}: ${STATE_ROUTE}`,
    );

    /**
     * 手动起草路由：`POST /api/context-guard/draft?sessionId=…`
     *
     * 为什么用 query 而不是 JSON body：不必在宿主里手写请求体累积与超时处理 —— 这个路由只需要
     * 一个会话 id，而 `req.url` 一定在。少一段可能出错的代码。
     * ⚠️ 与状态路由一样是本机无认证路由 ⇒ 响应里**只有文件名**，绝不回绝对路径（P1-2）。
     */
    webCtx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: DRAFT_ROUTE,
          handler: async (req, res) => {
            const reply = (code, payload) => {
              const body = JSON.stringify({ plugin: name, ...payload });
              try {
                res.writeHead(code, {
                  'Content-Type': 'application/json; charset=utf-8',
                  'Cache-Control': 'no-store',
                  'Content-Length': Buffer.byteLength(body),
                });
                res.end(body);
              } catch {
                /* 响应已经废了，无可挽回 */
              }
            };
            try {
              if (String(req?.method ?? 'GET').toUpperCase() !== 'POST') {
                reply(405, { ok: false, reason: 'method-not-allowed' });
                return;
              }
              const url = new URL(String(req?.url ?? ''), 'http://127.0.0.1');
              const sessionId = url.searchParams.get('sessionId');
              if (!sessionId) {
                reply(400, { ok: false, reason: 'missing-sessionId' });
                return;
              }
              const out = await draftNow(sessionId);
              reply(200, { at: Date.now(), ...out });
            } catch (error) {
              reply(500, { ok: false, reason: 'exception', message: String(error?.message ?? error) });
            }
          },
        }),
      `${name}: ${DRAFT_ROUTE}`,
    );
    info(bootT()('log.web.routeRegistered', { name, route: STATE_ROUTE }));
  });

  const sessionIdOf = (session) => String(session?.id ?? session?.header?.id ?? 'unknown');

  // ————————————————————————————————————————————————————————————————
  // 自动交接草稿：跨过 warnRatio 时，把**已经算好的投影**拼成一块机器事实交接写进工作目录。
  //
  // 四条设计约束：
  //   1. **零 LLM / 零额外请求**：素材全部来自 session projection（tokenCost / contextTimeline /
  //      turnOutline / sessionStats / title / contextPressure）⇒ 上下文税仍然是 0；
  //   2. **不写叙述**：插件不知道你干了什么 —— 它只写可核对的机器事实 + 「待补」空槽；
  //   3. **fail-soft**：拿不到 cwd、写不进去、权限不足 ⇒ 只记状态与日志，绝不抛回投影回调；
  //   4. **幂等且有界**：一个会话一块（带 sessionId 标记），水位每上升 handoverRefreshPercent 才刷一次。
  // ————————————————————————————————————————————————————————————————
  /** 宿主能给的「交接素材」投影；交素材只为草稿服务，不参与判定。 */
  const MATERIAL_KEYS = new Set([KEY, 'tokenCost', 'sessionStats', 'contextTimeline', 'turnOutline', 'title', 'titleInput']);
  /** @type {Map<string, object>} 每会话的最新素材（含 cwd / createdAt，来自 session 本身） */
  const material = new Map();

  /**
   * 注册表服务本身 —— 起草时要问它拿**宿主状态真源**（见 `draftMaterial`）。
   * 软依赖：服务缺席 / 版本没有 `stateOf` 时，退化成只读 onChanged 送来的「线上视图」，
   * 草稿照写，只是少「改过的文件」那一段。
   * @type {object|null}
   */
  let projectionsRef = null;

  /**
   * 该会话的文案语言（§19.6.2 第 2 条，host 半边）。
   *
   * 线索是「这个会话的**首条用户输入**有没有汉字」，载体是 `titleInput` 投影。
   *
   * ⛔ **必须走宿主状态真源 `stateOf`**（2026-09-30 第十二棒修正，代价是一轮代码审查）：
   * 最初只读 `onChanged` 送来的值 —— 那是**错的**，而且是静默的。
   * `dsh-session-projection` 的 `drive()` 只在单元声明了 `wire` 时才通知监听者
   * （`const wire = registration.def.wire; if (changed && wire !== void 0) …`），
   * 而 `titleInput` 的注册**没有 `wire`** ⇒ 它压根不上线 ⇒ `material.titleInput` 永远是
   * `undefined` ⇒ 宿主半边永远兜底 `zh`，于是「英文界面的浏览器 + 英文会话」会得到
   * **浏览器半边英文、宿主半边中文**的输出。
   *
   * ⚠️ 别被 `title` 投影骗到：它写的是 `wire: { viewSchema, view: state => state }`
   * —— 那是 `wire` 对象**内部**的 `view` 字段。**有 `wire` 才上线**，与
   * `contextTimeline`（有 wire 但被砍成 slim head，§18.6）是同一条规律的两面。
   *
   * 拿不到任何线索（没有 session / `stateOf` 缺席 / 抛异常）⇒ 退到
   * `DSH_CONTEXT_GUARD_LOCALE` → `zh`（保持升级前的行为，不惊动现有用户）。
   *
   * @param {object|null|undefined} session 真源读取需要它（`stateOf(session, key)`）
   * @param {string} sessionId
   * @returns {'zh'|'en'}
   */
  const localeOf = (session, sessionId) => {
    const cfg = engine.config;
    if (cfg.locale === 'zh' || cfg.locale === 'en') return cfg.locale;
    // 线上视图路径保留成保底：哪天 DSH 给 `titleInput` 补上 `wire`，这里会自己拿到值。
    let titleInput = material.get(sessionId)?.titleInput;
    if (titleInput === undefined && session !== null && session !== undefined) {
      try {
        if (typeof projectionsRef?.stateOf === 'function') titleInput = projectionsRef.stateOf(session, 'titleInput');
      } catch {
        /* 语言猜不出来不是故障，更不该影响判定：静默走下面的兜底 */
      }
    }
    const first = Array.isArray(titleInput?.first) ? titleInput.first[0] : titleInput?.first;
    const sample = typeof first?.text === 'string' ? first.text : typeof first === 'string' ? first : undefined;
    return pickLocale('auto', { sampleText: sample, env: process.env.DSH_CONTEXT_GUARD_LOCALE });
  };

  const noteMaterial = (sessionId, key, value, session) => {
    let m = material.get(sessionId);
    if (m === undefined) {
      m = {
        cwd: session?.cwd ?? session?.header?.cwd ?? null,
        createdAt: session?.header?.createdAt ?? session?.createdAt ?? null,
      };
      material.set(sessionId, m);
    }
    m[key] = value;
    if (m.cwd === null || m.cwd === undefined) m.cwd = session?.cwd ?? session?.header?.cwd ?? null;
  };

  /**
   * 起草用的素材 = onChanged 送来的「线上视图」**叠加**注册表里的**宿主状态真源**。
   *
   * ⚠️ 2026-09-30（第十一棒）实测更正 —— §18.6 那个「素材为什么缺」的悬案，答案是
   * **投影的 wire 视图被砍过，而重集合只在单元状态里**：
   *   · `contextTimeline`（由 profile 插件 `dsh-context` 注册）的 wire 视图在**按需 detail
   *     通道已启用**时是 `buildTimelineHead` 的 **slim head** —— 里面有 `contextWindow` /
   *     `timing.tools` / `cost` / `counts` / `detailRev`，**唯独没有 `fileOps`**（fileOps 与
   *     requests / surface / archive 一起只在 `detailCollectionsOf`，即 detail 载荷里）。
   *     所以只读 onChanged 的值 ⇒「改过的文件」**永远是 0 个**，而且
   *     **resume 与运行中完全一样**（不是两条路的差别，是 head 本来就不含 fileOps）。
   *   · `turnOutline` 的 wire 视图是**数组**（`view: (state) => state.turns`），状态才是
   *     `{ turns, draft }` ⇒ 读 `value.turns` 永远是空的。
   * 宿主插件拿真源的正门是注册表的 `stateOf(session, key)`：**单元宿主状态**，与 wire 视图
   * 无关、无额外请求、零 LLM。取不到（键未注册 / 老版本没有 stateOf / 抛异常）就退回线上视图
   * ——fail-soft，绝不把起草拖死。
   *
   * ⚠️ 返回值是**活引用**（契约要求调用方不得改写）。这里只 `{...m}` 浅拷一层、覆盖键引用，
   * **不把它存进 `material`**，用完即弃：既避免长期持有大数组，也避免读到「后来才变」的状态。
   */
  const draftMaterial = (session, sessionId) => {
    const recorded = material.get(sessionId) ?? {};
    if (projectionsRef === null || typeof projectionsRef.stateOf !== 'function') return recorded;
    const out = { ...recorded };
    for (const key of MATERIAL_KEYS) {
      try {
        const state = projectionsRef.stateOf(session, key);
        if (state !== undefined) out[key] = state;
      } catch {
        /* 单个键读不到就继续用线上视图：素材缺失不是故障，更不该影响判定 */
      }
    }
    return out;
  };

  const draftState = {
    /** 每个会话上次起草时的水位：避免同一水位重复写，也避免 compaction 掉下来后重复写。 */
    lastRatio: new Map(),
    /** 正在写（异步）的会话：同一会话不并发写同一个文件。 */
    pending: new Set(),
    written: 0,
    failed: 0,
    /** 静默跳过（例如会话没有 header.cwd）：不是故障，但要在状态面里看得见。 */
    skipped: 0,
    last: null,
    history: [],
  };

  const noteDraft = (entry) => {
    draftState.last = entry;
    draftState.history.push(entry);
    if (draftState.history.length > 10) draftState.history.splice(0, draftState.history.length - 10);
  };

  /**
   * 压缩账的写入计数（v0.5.0）。`/state` 会原样回它 —— **写失败静默 = 记录工具不存在**，
   * 所以这里必须可观测（而不是像 v0.4.1 那样连「这次没写」都看不出来）。
   */
  const ledgerState = {
    written: 0,
    failed: 0,
    unchanged: 0,
    skipped: 0,
    last: null,
  };

  /**
   * 手动起草（banner 按钮）需要的两样东西：**该会话最新的压力值**与 **session 引用**。
   *
   * 为什么不在路由里现查：`readOccupancy` 要的是 `contextPressure` 投影的原值，而路由只拿到
   * 一个 sessionId；宿主状态真源 `stateOf` 只对外开放「单元状态」，拿不到这个投影的原始值。
   * 所以在投影回调里顺手存一份 —— 同一会话的路由请求一定是「刚才那条投影之后」发出的。
   * @type {Map<string, unknown>}
   */
  const lastPressure = new Map();
  /** @type {Map<string, object|null>} 起草时 `draftMaterial` / `localeOf` 需要 session 本身。 */
  const lastSession = new Map();

  /**
   * v0.4.1：每个会话最近 30 次读数的**环形记录**。
   * 压缩发生时投影已经变成"压缩后的低水位"，所以快照必须取**压缩前的峰值**（ring 里 ratio 最大的那次），
   * 不能读"当前值" —— 否则写出来的就是压缩后，那就没有信息量了。
   * @type {Map<string, Array<{ratio:number, projectedTokens:number|null, contextWindow:number|null, at:number}>>}
   */
  const recentReadings = new Map();

  /**
   * ⚠️ v0.4.3：这里原来有一个 `pendingCompaction` Map（`compaction/end` 打标记、
   * 紧随其后的那次观测消费它，作为 `justCompacted` 传给判定）。
   *
   * 现在这个标记**折进判定状态本身**（`state.pendingCompaction`，见 `lib/engine.mjs` 的 `fold`）：
   * 它由 `compaction/end` 事件置位、由下一次 `observation` 消费。好处是「压缩这件事」只有一条
   * 推导路径（事件流 → 状态），不再需要宿主半边维护另一份与状态并行、可能不同步的簿记。
   *
   * `respectCompaction` 的生效路径不变：`compaction/end` → 标记 → 下一次观测被抑制一次。
   * `test/wiring.test.mjs` 用假 `sessionProjections` 驱动真 `apply()` 钉着它。
   */

  /** 取该会话最近读数的峰值（没有记录就 null）。 */
  const peakReading = (sessionId) => {
    const ring = recentReadings.get(sessionId);
    if (!ring || ring.length === 0) return null;
    return ring.reduce((best, item) => (item.ratio > best.ratio ? item : best), ring[0]);
  };

  /**
   * 「压缩账」（v0.5.0，零 LLM，取代 v0.4.1 的每会话快照块）。
   *
   * 平台压缩之后，**压缩前的读数**就永久查不到了（平台自己吃掉了自己的证据）—— 这是本插件
   * 唯一结构上不可替代的产出。这里在 `compaction/end` 时把本次压缩前的峰值追加成一行：
   *   · **与 `handoverOnWarn` 解耦**：关掉「自动起草」是关提示，不是关记录；
   *   · **幂等键 = `compactionId`**（宿主事件载荷里有）：重复投递/重放/重试都只落一行；
   *   · ring 为空（daemon 刚重启）时仍然写一行，峰值列标「未知」—— 有标注的记录比没有记录强；
   *   · fail-soft：任何异常只记日志，绝不影响压缩本身。
   */
  function writeLedgerRow(session, sessionId, event) {
    let locale = 'zh';
    try {
      const live = refreshConfig();
      const m = material.get(sessionId) ?? {};
      const file = resolveHandoverPath(m.cwd, live.handoverPath);
      if (file === null) {
        ledgerState.skipped += 1;
        ledgerState.last = { at: Date.now(), status: 'skipped', error: 'no-cwd' };
        return;
      }
      const peak = peakReading(sessionId);
      const cost = m.tokenCost && Number.isFinite(m.tokenCost.cost) ? m.tokenCost.cost : null;
      const files = changedFiles(m.contextTimeline?.fileOps, 50).length;
      const size =
        peak && Number.isFinite(peak.projectedTokens) && Number.isFinite(peak.contextWindow)
          ? `≈${Math.round(peak.projectedTokens / 1000)}K/${Math.round(peak.contextWindow / 1000)}K`
          : '';
      const eventId = typeof event?.data?.compactionId === 'string' ? event.data.compactionId : '';
      locale = localeOf(session, sessionId);
      const entry = {
        at: fmtTime(Date.now()),
        sessionId,
        peakPercent: peak && Number.isFinite(peak.ratio) ? peak.ratio * 100 : null,
        size,
        cost,
        files,
        eventId,
      };
      void appendLedgerRow({ file, entry, locale })
        .then((result) => {
          const t = makeT(locale);
          const path = result.path ?? t('log.handover.noPath');
          if (result.status === 'error') {
            ledgerState.failed += 1;
            ledgerState.last = { at: Date.now(), status: 'error', error: result.error };
            warn(t('log.ledger.failed', { name, path, error: result.error }));
            return;
          }
          if (result.status === 'unchanged') ledgerState.unchanged += 1;
          else ledgerState.written += 1;
          ledgerState.last = { at: Date.now(), status: result.status, row: result.seq ?? null };
          info(t('log.ledger.written', { name, status: `${result.status}${result.seq ? ` #${result.seq}` : ''}`, path }));
          // 压缩回执（P1）：把「压缩前峰值 / 账本行号 / 时刻」交给宿主镜像，banner 降级态读它。
          if (Number.isFinite(entry.peakPercent) && Number.isFinite(result.seq)) {
            engine.noteReceipt(sessionId, { peakPercent: entry.peakPercent, row: result.seq, at: Date.now() });
          }
        })
        .catch((error) => {
          ledgerState.failed += 1;
          ledgerState.last = { at: Date.now(), status: 'error', error: String(error?.message ?? error) };
          warn(makeT(locale)('log.ledger.failed', { name, path: '(async)', error: String(error?.message ?? error) }));
        });
    } catch (error) {
      ledgerState.failed += 1;
      ledgerState.last = { at: Date.now(), status: 'error', error: String(error?.message ?? error) };
      warn(makeT(locale)('log.ledger.failed', { name, path: '(exception)', error: String(error?.message ?? error) }));
    }
  }

  /**
   * 手动「写好交接」：**跳过水位/步进闸门**，立刻写一次。
   *
   * 与 `maybeDraftHandover` 的四点一致性（刻意保持，别在改这个函数时破坏）：
   *   (a) 仍然尊重 `handoverOnWarn`（用户在设置里关掉了就不写）；
   *   (b) 仍然尊重 `pending` 锁（同一会话不并发写同一文件）；
   *   (c) 仍然**只写机器事实**、零 LLM（素材全来自投影，见 `draftMaterial`）；
   *   (d) 失败**不抛**，把原因放进返回值 —— 路由层只负责把它变成 JSON。
   *
   * ⚠️ 返回值里的路径一律只有**文件名**（`basename`）：这条路由与状态路由一样是本机无认证的，
   *    绝对路径会泄露用户名与目录结构（安全审计 P1-2）。
   */
  async function draftNow(sessionId) {
    const live = refreshConfig();
    if (live.handoverOnWarn !== true) return { ok: false, reason: 'disabled' };
    if (draftState.pending.has(sessionId)) return { ok: false, reason: 'busy' };
    const session = lastSession.get(sessionId) ?? null;
    let reading = readOccupancy(lastPressure.get(sessionId));
    /**
     * v0.4.6（真机故障 §37.4 的连带症状）：**恢复出来的会话**在 `session/created` 那一刻还没有
     * `contextPressure`（异步恢复），于是 `lastPressure` 是空的、徽标有 67% 而按钮却报
     * `no-reading`；`material` 也可能因为「快照里一个键都没有」而压根没建（cwd 丢失 ⇒ `no-path`）。
     * 手动点击的时刻读数一定已经就绪 ⇒ 当场补读一次（**只读**，不写判定状态）。
     */
    if (session !== null && (reading.known !== true || !Number.isFinite(reading.ratio))) {
      try {
        const snap = projectionsRef?.snapshot?.(session, [KEY]);
        const fresh = snap?.values?.[KEY];
        if (fresh !== undefined) {
          lastPressure.set(sessionId, fresh);
          noteMaterial(sessionId, KEY, fresh, session);
          reading = readOccupancy(fresh);
        }
      } catch {
        /* 读不到就照旧返回 no-reading：按钮会给一句人话原因 */
      }
    }
    if (reading.known !== true || !Number.isFinite(reading.ratio)) return { ok: false, reason: 'no-reading' };
    // 素材缺席时补一条最小记录（cwd / createdAt 来自会话本身，不需要投影）
    if (material.get(sessionId) === undefined) noteMaterial(sessionId, KEY, lastPressure.get(sessionId), session);
    const m = material.get(sessionId) ?? {};
    const file = resolveHandoverPath(m.cwd, live.handoverPath);
    if (file === null) return { ok: false, reason: 'no-path' };

    const locale = localeOf(session, sessionId);
    const draftMat = draftMaterial(session, sessionId);
    // v0.6.0：写时校验关键文件还在不在（只读本机文件系统；有界；异步在 compose 之外）。
    const limit = live.handoverFiles ?? 12;
    const probePaths = changedFiles(draftMat.contextTimeline?.fileOps, limit).map((f) => f.path);
    const fileFacts = await probeFiles(probePaths, m.cwd ?? null, { limit });
    const block = composeHandoverBlock({
      sessionId,
      now: Date.now(),
      reading,
      material: draftMat,
      config: live,
      cwd: m.cwd,
      locale,
      fileFacts,
      verifiedAt: Date.now(),
    });

    draftState.pending.add(sessionId);
    try {
      const result = await writeHandoverBlock({ file, sessionId, block });
      const ok = result.status !== 'error';
      if (ok) draftState.written += 1;
      else draftState.failed += 1;
      noteDraft({ at: Date.now(), sessionId, ratio: reading.ratio, ...result });
      // 手动写成功也推进水位基线：否则紧接着的水位自动刷新会再写一次同样的内容。
      if (ok) draftState.lastRatio.set(sessionId, reading.ratio);
      const t = makeT(locale);
      const path = result.path ?? t('log.handover.noPath');
      info(
        ok
          ? t('log.handover.written', { name, status: result.status, path })
          : t('log.handover.failed', { name, path, error: result.error }),
      );
      return ok
        ? {
            ok: true,
            status: result.status,
            doc: basename(file),
            // v0.4.0：「结论还在不在」变成状态面上的一个字段 —— 刚写是空模板 ⇒ false；
            // 沿用了旧的人工区（0.3.6 的保留逻辑）⇒ true；读不到文件时 null（不知道）。
            todoFilled: await readTodoFilled(file, sessionId),
          }
        : { ok: false, reason: 'write-failed', message: result.error };
    } catch (error) {
      draftState.failed += 1;
      noteDraft({ at: Date.now(), sessionId, status: 'error', error: String(error?.message ?? error) });
      return { ok: false, reason: 'exception', message: String(error?.message ?? error) };
    } finally {
      draftState.pending.delete(sessionId);
    }
  }

  /**
   * 水位过 warnRatio 且又走了一个步进 ⇒ 起草/刷新一次。
   * **先占水位再落盘**：写是异步的，不先占的话同一批事件会重复写。
   */
  const maybeDraftHandover = (session, sessionId, pressure) => {
    /** 同步闸门与占位必须在**第一次 await 之前**完成（否则同一批投影事件会重复写）。 */
    let live;
    let reading;
    let file;
    let locale;
    let draftMat;
    let cwd;
    try {
      live = refreshConfig();
      if (live.handoverOnWarn !== true) return;
      reading = readOccupancy(pressure);
      if (reading.known !== true || !Number.isFinite(reading.ratio)) return;
      if (reading.ratio < live.warnRatio) return;
      const step = Math.max(0.01, live.handoverRefreshPercent / 100);
      const prev = draftState.lastRatio.get(sessionId);
      if (prev !== undefined && reading.ratio - prev < step) return;
      if (draftState.pending.has(sessionId)) return;

      const m = material.get(sessionId) ?? {};
      cwd = m.cwd ?? null;
      file = resolveHandoverPath(cwd, live.handoverPath);
      if (file === null) {
        // **静默跳过**：有些会话确实没有 cwd，这不是故障。
        // ⚠️ 这里刻意不用 warn —— 提示插件的日志会被用户与断言当噪声读，
        //    而且「没有 cwd」这件事在状态路由的 handover.last 里看得见就够了。
        draftState.skipped += 1;
        noteDraft({ at: Date.now(), sessionId, status: 'skipped', error: 'no-cwd', path: null });
        return;
      }

      draftState.lastRatio.set(sessionId, reading.ratio);
      draftState.pending.add(sessionId);
      // 素材走 draftMaterial（宿主状态真源优先），cwd / createdAt 仍取记录值；
      // 语言按**这个会话**解析（显式设置 > 首条输入是否含汉字 > 环境变量 > zh）。
      // ⚠️ 在**起草前算一次并捕获**：异步改造后，落地那一刻会话可能已经变了。
      locale = localeOf(session, sessionId);
      draftMat = draftMaterial(session, sessionId);
    } catch (error) {
      warn(makeT(localeOf(session, sessionId))('log.handover.exception', { name, error: error?.message ?? error }));
      return;
    }

    void (async () => {
      try {
        // v0.6.0：写时校验关键文件还在不在（只读本机文件系统；有界；异步在 compose 之外）。
        const limit = live.handoverFiles ?? 12;
        const paths = changedFiles(draftMat.contextTimeline?.fileOps, limit).map((f) => f.path);
        const fileFacts = await probeFiles(paths, cwd, { limit });
        const block = composeHandoverBlock({
          sessionId,
          now: Date.now(),
          reading,
          material: draftMat,
          config: live,
          cwd,
          locale,
          fileFacts,
          verifiedAt: Date.now(),
        });
        const result = await writeHandoverBlock({ file, sessionId, block });
        const ok = result.status !== 'error';
        if (ok) draftState.written += 1;
        else draftState.failed += 1;
        noteDraft({ at: Date.now(), sessionId, ratio: reading.ratio, ...result });
        const t = makeT(locale);
        const path = result.path ?? t('log.handover.noPath');
        info(
          ok
            ? t('log.handover.written', { name, status: result.status, path })
            : t('log.handover.failed', { name, path, error: result.error }),
        );
      } catch (error) {
        draftState.failed += 1;
        noteDraft({ at: Date.now(), sessionId, status: 'error', error: String(error?.message ?? error) });
      } finally {
        draftState.pending.delete(sessionId);
      }
    })();
  };

  // —— 投影变更：喂状态机。软依赖，缺席就只是不响（绝不把整棵树拖死）。
  ctx.inject(['sessionProjections'], (sctx) => {
    const projections = sctx.sessionProjections;
    if (projections === undefined) {
      warn(bootT()('log.projections.noOnChanged', { name }));
      return;
    }
    /**
     * 把宿主的判定结果注册成一个 `wire` 投影（v0.4.3，复审报告 §2 建议 #1）。
     *
     * 位置很重要：这行在 `onChanged` 之前，且**不依赖** `onChanged` —— 注册只需要 `register`。
     * 于是「浏览器半边拿不到判定」这件事不再取决于 HTTP 路由，而是走宿主自己的投影广播。
     * 全部失败路径都收敛成一条 warn：提示插件绝不能因为一条可选通道把宿主拖下水。
     *
     * ⚠️ 单元的 `apply`/`view` 都在 `engine` 上（见 `lib/engine.mjs` 的长注释），这里只做接线。
     */
    if (typeof projections.register === 'function') {
      try {
        sctx.effect(
          () =>
            projections.register({
              key: MIRROR_KEY,
              stateVersion: MIRROR_STATE_VERSION,
              stateSchema: mirrorStateSchema(),
              init: (header) => engine.mirrorInit(header),
              apply: (state) => engine.mirrorApply(state),
              wire: {
                viewSchema: mirrorViewSchema(),
                view: (state) => engine.mirrorView(state),
              },
            }),
          `${name}: ${MIRROR_KEY}`,
        );
        info(bootT()('log.projection.registered', { name, key: MIRROR_KEY, version: MIRROR_STATE_VERSION }));
      } catch (error) {
        warn(bootT()('log.projection.registerFailed', { name, key: MIRROR_KEY, error: error?.message ?? error }));
      }
    } else {
      warn(bootT()('log.projection.noRegister', { name }));
    }
    if (typeof projections.onChanged !== 'function') {
      warn(bootT()('log.projections.noOnChanged', { name }));
      return;
    }
    // 起草用的宿主状态真源（`stateOf`）。老版本注册表没有 stateOf 时退化成线上视图；
    // 随本 fiber 释放，避免插件卸载后还握着一个已经作废的服务引用。
    projectionsRef = projections;
    sctx.effect(
      () => () => {
        projectionsRef = null;
      },
      `${name}: projectionsRef`,
    );
    sctx.effect(
      () =>
        projections.onChanged((session, key, value) => {
          const id = sessionIdOf(session);
          if (MATERIAL_KEYS.has(key)) noteMaterial(id, key, value, session);
          if (key !== KEY) return;
          // 手动起草路由要用：记住该会话**最新的压力原值**与 session 引用（见 draftNow 注释）
          lastPressure.set(id, value);
          lastSession.set(id, session);
          // v0.4.1：记下读数（压缩后靠这个 ring 取"压缩前峰值"，当前值已经不可用了）
          const snap = readOccupancy(value);
          if (snap.known === true && Number.isFinite(snap.ratio)) {
            const ring = recentReadings.get(id) ?? [];
            ring.push({
              ratio: snap.ratio,
              projectedTokens: snap.projectedTokens,
              contextWindow: snap.contextWindow,
              at: Date.now(),
            });
            if (ring.length > 30) ring.splice(0, ring.length - 30);
            recentReadings.set(id, ring);
          }
          try {
            refreshConfig(); // 设置页改完不用重启：每一轮判断前都读一次当前设置
            /**
             * 判定点：**投影变化时**（不是 `turn/end`）。
             *
             * P1-2 的定案（2026-10-17 代码审查后）：README / package.json 原本写 "at turn end"，
             * 但实现一直是「投影变化即判」，而且 `tools/selftest.mjs` 有 14 项场景把这件事当**规格**钉着。
             * 两条路里选了**改文档、不改时机**，理由是风险不对称：
             *   · 保持投影即判 ⇒ 最坏只是 banner 出现得早一点（时序，不是正确性）；
             *   · 改成只在 turn/end 判 ⇒ 一旦某个会话的 `turn/end` 没送到，就**完全不提示**（漏报）。
             * （实测过后者：selftest 立刻红 14 项 —— 因为它只推投影、不发 turn/end。）
             *
             * `justCompacted`：v0.4.3 起它是**状态里的** `pendingCompaction`（由 `compaction/end`
             * 事件置位、由这一次观测消费，见 `lib/engine.mjs` 的 `fold`）—— 所以这里不再需要
             * 传任何东西，也不再需要宿主自己维护那个一次性 Map。
             */
            const hit = engine.observe(id, value, { locale: localeOf(session, id) });
            if (hit !== null) {
              logHit(hit);
            }
            // 45% 起自动起草/刷新交接（零 LLM；写失败只记状态，不影响判定）
            maybeDraftHandover(session, id, value);
          } catch (error) {
            // 提示插件绝不能成为别人的故障源：任何意外只记日志，不向上抛。
            warn(makeT(localeOf(session, id))('log.observe.exception', { name, error: error?.message ?? error }));
          }
        }),
      `${name}: sessionProjections.onChanged`,
    );
    info(bootT()('log.projections.subscribed', { name, key: KEY, count: MATERIAL_KEYS.size }));

    /**
     * 启动补判（v0.4.5，2026-10-19 真机故障）：把**已存在的会话**按已知读数折一次状态。
     *
     * 为什么需要：插件在 13:05 刚起来时，`session/created` 拿到的快照可能还没回放出
     * `contextPressure`，于是那个会话在宿主状态里停在 `none`；而浏览器页面加载时的基线
     * 正是读这个状态 ⇒ **一个 67% 的历史会话在你不发新消息之前不弹 banner**（真机复现：
     * 发了消息后才弹，因为新事件把状态算成了 hard）。
     *
     * 只在启动做一次、**silent**（不记日志、不外推），拿不到读数就跳过。
     */
    try {
      const sessionsService = ctx.get('sessions');
      if (sessionsService !== undefined && typeof sessionsService.list === 'function') {
        let seeded = 0;
        for (const session of sessionsService.list()) {
          try {
            const id = sessionIdOf(session);
            const snap = projections.snapshot(session, [KEY]);
            const pressure = snap?.values?.[KEY];
            if (pressure !== undefined && engine.seed(id, pressure)) seeded += 1;
          } catch {
            /* 单个会话失败不影响其它会话 */
          }
        }
        if (seeded > 0) info(bootT()('log.projections.seeded', { name, count: seeded }));
      }
    } catch (error) {
      warn(bootT()('log.projections.seedFailed', { name, error: error?.message ?? error }));
    }
  });

  // —— 日志事件分派。**这是唯一能看到 turn/end 与 compaction 的地方**。
  ctx.on('session/event', (session, event) => {
    try {
      refreshConfig();
      if (event?.type === 'turn/end') {
        // ⚠️ 判定**不在这里**（见 `onChanged` 里 P1-2 的定案说明）；这里只推进轮计数、衰减冷却。
        engine.endTurn(sessionIdOf(session));
        return;
      }
      if (event?.type === 'compaction/end') {
        /**
         * 压缩是否失败：**只在这一处解析一次**（D2，2026-10-17 复审）。
         *
         * 载荷实况（DSH 0.2.0-rc.2，`dsh-compaction-basic`）：成功事件是
         * `{ compactionId, turn, sourceCommandId? }` —— **根本没有 `error` 键**；
         * 失败才追加 `error: errorChain(error)`，而 `errorChain` 返回的是**字符串**
         * （`String(current)` / `current.message`）。
         *
         * 历史 bug：这里写的是 `event.data?.error !== true`，字符串 `!== true` 恒为 `true`
         * ⇒ **失败路径与成功路径走完全相同的分支**（失败压缩也置标记、也写压缩前快照）；
         * 而紧邻的上一行却用 `Boolean(event.data?.error)`（对字符串是正确的）—— 同一段两套判据。
         *
         * 现在统一成「键在不在」的真值判断：`undefined` / `null` 视为成功，
         * 其余任何值（字符串、对象、布尔）一律视为失败。
         * 注意**不能**用 `Boolean(data?.error)`：`error: ''` 是可能出现的空消息，
         * 布尔化会把它误判成成功。
         */
        const failed = event.data?.error !== undefined && event.data?.error !== null;
        const sid = sessionIdOf(session);
        // 载荷解析**只在这一处**（上面那段注释）；标记本身折进状态里（`pendingCompaction`），
        // 失败时清掉 —— 失败/异常结束的压缩并没有真的把水位压下来，不该抑制下一次提示。
        engine.noteCompaction(sid, failed);
        // v0.5.0：平台压缩后，压缩前的读数就查不到了 —— 这里追加一行「压缩账」
        // （只对**真的压过**的那次写；失败路径不落盘，那是没走完的压缩，写它没有信息量）。
        if (!failed) writeLedgerRow(session, sid, event);
        return;
      }
      // 切模型/路由会换窗口，而官方三个字段是 last-wins、不是原子观测
      // ⇒ 切模型后「新窗口配旧压力」。保守地解除武装，宁可晚一轮提示。
      if (event?.type === 'request/header' || event?.type === 'model/selection') {
        const id = sessionIdOf(session);
        if (engine.resetArming(id)) {
          info(makeT(localeOf(session, id))('log.arming.reset', { name, session: id }));
        }
      }
    } catch (error) {
      warn(bootT()('log.sessionEvent.exception', { name, error: error?.message ?? error }));
    }
  });

  // —— 会话创建（新建**或**从存储恢复，二者都是这一个事件）。
  // `session/created` 是同步 emit：抛出会否决并回滚创建，所以这里必须什么都吞掉。
  ctx.on('session/created', (session) => {
    try {
      refreshConfig();
      const projections = ctx.get('sessionProjections');
      if (projections === undefined || typeof projections.snapshot !== 'function') return;
      const id = sessionIdOf(session);
      const snap = projections.snapshot(session, [...MATERIAL_KEYS]);
      for (const [k, v] of Object.entries(snap?.values ?? {})) noteMaterial(id, k, v, session);
      const hit = engine.onResume(id, snap?.values?.[KEY], { locale: localeOf(session, id) });
      if (hit !== null) {
        logHit(hit);
      }
      // 点进一个**已经很高**的历史会话：同一时刻就该把交接草稿备好（§10.4：会话打开才是「跨会话」的实质）
      lastPressure.set(id, snap?.values?.[KEY]);
      lastSession.set(id, session);
      maybeDraftHandover(session, id, snap?.values?.[KEY]);
    } catch (error) {
      warn(bootT()('log.resume.exception', { name, error: error?.message ?? error }));
    }
  });
  // —— 会话销毁（v0.6.0）：清掉按会话的四个 Map + 引擎状态/回执。
  // daemon 是常驻的，不清就是「打开过的会话一个都不释放」——与「零税」的定位相反。
  ctx.on('session/disposed', (session) => {
    try {
      const id = sessionIdOf(session);
      if (id === 'unknown') return;
      material.delete(id);
      lastPressure.delete(id);
      lastSession.delete(id);
      recentReadings.delete(id);
      draftState.lastRatio.delete(id);
      engine.forget(id);
    } catch (error) {
      warn(bootT()('log.sessionEvent.exception', { name, error: error?.message ?? error }));
    }
  });
}

export { defaultConfig, STATE_ROUTE, DRAFT_ROUTE } from './policy.mjs';
