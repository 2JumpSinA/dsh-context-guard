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
import {
  defaultConfig,
  initialState,
  readOccupancy,
  reduce,
  nextTurn,
  describe as describeSignal,
  shouldPush,
  pushText,
  plainConfig,
  TrendTracker,
  STATE_ROUTE,
} from './policy.mjs';

// ⚠️ **只被宿主半边用**：`handover.mjs` import 了 node:fs / node:path，
//    所以它绝不能进 client bundle（bundle 只内联 policy.mjs + client-source.js）。
import { basename, isAbsolute } from 'node:path';

import { composeHandoverBlock, resolveHandoverPath, writeHandoverBlock } from './handover.mjs';

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
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('总开关。关掉后插件只留服务与日志，不出任何提示。')
    .volatile(),
  warnRatio: Schema.number()
    .min(0.1)
    .max(0.95)
    .default(0.45)
    .description('「该收尾了」的占用率阈值（projectedTokens / contextWindow）。一律用比率，不用绝对 token。默认 0.45 由「占用率 → 成本」曲线标定（见 README「阈值与设计取舍」）。')
    .volatile(),
  hardRatio: Schema.number()
    .min(0.1)
    .max(1)
    .default(0.6)
    .description('「该换会话了」的占用率阈值。必须大于 warnRatio。默认 0.6 刻意早于平台 ~80% 的自动压缩点。')
    .volatile(),
  hysteresisRatio: Schema.number()
    .min(0)
    .max(0.2)
    .default(0.05)
    .description('迟滞：占用率要回落到 warnRatio 减去这个值以下，才重新武装（防止在同一水位反复响）。')
    .volatile(),
  cooldownTurns: Schema.number()
    .min(0)
    .max(100)
    .step(1)
    .default(5)
    .description('跨档后静默多少轮，避免刷屏。')
    .volatile(),
  onResume: Schema.boolean()
    .default(true)
    .description('进入一个已经很高的历史会话时也提示（这才是「跨会话」的实质：进去之前没人告诉你）。')
    .volatile(),
  respectCompaction: Schema.boolean()
    .default(true)
    .description('自动压缩正在压水位时不必提示换会话：只在「压缩后仍高于阈值」才算数。')
    .volatile(),
  crossSessionTrend: Schema.boolean()
    .default(true)
    .description('看最近一段时间有几个会话撞过线：几个都撞 ⇒ 措辞升级为「该换工作方式」，而不只是「这个会话该换了」。')
    .volatile(),
  trendWindowHours: Schema.number()
    .min(1)
    .max(168)
    .step(1)
    .default(24)
    .description('跨会话趋势的统计窗口（小时）。')
    .volatile(),
  trendEscalateAt: Schema.number()
    .min(2)
    .max(20)
    .step(1)
    .default(3)
    .description('窗口内撞 hard 的会话数达到这个值，就升级措辞。')
    .volatile(),
  pushChannel: Schema.union(['none', 'wechat'])
    .default('none')
    .description(
      '外推推送通道（默认 none = 不推）。wechat 走本机已有的 wechatNotify 服务；' +
        '推送是显式选择 —— 这个插件不会在你没要求的情况下往你手机里发消息。',
    )
    .volatile(),
  pushMinLevel: Schema.union(['warn', 'hard'])
    .default('hard')
    .description('从哪一档开始外推（hard 才推是默认：warn 只是「该收尾了」，不值得打扰）。')
    .volatile(),
  pushCooldownMinutes: Schema.number()
    .min(0)
    .max(1440)
    .step(1)
    .default(10)
    .description('两次外推之间的全局最小间隔（分钟，0 = 不限制）。同时开着多个会话时防连环打扰。')
    .volatile(),
  handoverOnWarn: Schema.boolean()
    .default(true)
    .description(
      '跨过 warnRatio 时，自动在工作目录的 HANDOVER.md 里起草/刷新一块「机器事实交接」' +
        '（会话/水位/花费/改过的文件/最近几轮摘要）。零 LLM、零额外请求，叙述留给 agent。',
    )
    .volatile(),
  handoverPath: Schema.string()
    .default('HANDOVER.md')
    .description('交接文件：相对**会话工作目录**，或写绝对路径。')
    .volatile(),
  handoverRefreshPercent: Schema.number()
    .min(1)
    .max(25)
    .step(1)
    .default(5)
    .description('水位每再上升这么多个百分点，就刷新一次草稿（45 → 50 → 55 → 60…）。')
    .volatile(),
  handoverTurns: Schema.number()
    .min(1)
    .max(20)
    .step(1)
    .default(6)
    .description('草稿里带几轮「诉求 / 回应」摘要。')
    .volatile(),
  handoverFiles: Schema.number()
    .min(1)
    .max(50)
    .step(1)
    .default(12)
    .description('草稿里带几个「最近改过的文件」（只取 write 类操作）。')
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
 * 真正的内存风险来自 `TrendTracker.events`，它自己按时间窗 prune。
 */
export function createGuardEngine(config = defaultConfig()) {
  /** @type {Map<string, object>} */
  const states = new Map();
  const trend = new TrendTracker(config);
  /** @type {object[]} */
  const log = [];

  const stateOf = (sessionId) => {
    let s = states.get(sessionId);
    if (s === undefined) {
      s = initialState();
      states.set(sessionId, s);
    }
    return s;
  };

  const engine = {
    config,
    trend,
    /**
     * 换一份生效配置（**运行期**，不重挂）。设置页写完之后下一轮就要按新阈值判断，
     * 所以 `apply` 每次入口都调它一次；`config` 一律从 `engine.config` 读，不缓存进闭包。
     */
    setConfig(next) {
      engine.config = next;
      trend.cfg = next;
      return next;
    },
    /** 最近若干条判定（倒序），给排障与将来的 client 半边用。 */
    recent: (limit = 20) => log.slice(-limit).reverse(),
    /** 某会话的当前档位与占用率。 */
    snapshotOf(sessionId) {
      const s = states.get(sessionId);
      return {
        level: s?.level ?? 'none',
        armed: s?.armed ?? false,
        turn: s?.turn ?? 0,
        cooldown: s?.cooldown ?? 0,
        compactionDrop: s?.compactionDrop ?? false,
        occupancy: s?.occupancy ?? null,
      };
    },
    /**
     * 吸收一次投影变化。返回提示信号（无提示时 null）。
     * @param {string} sessionId
     * @param {unknown} pressure
     */
    observe(sessionId, pressure, options = {}) {
      const reading = readOccupancy(pressure);
      const out = reduce(stateOf(sessionId), reading, {
        config: engine.config,
        atTurnBoundary: options.atTurnBoundary === true,
        justCompacted: options.justCompacted === true,
      });
      states.set(sessionId, out.state);
      if (out.signal === null) return null;
      if (!engine.config.enabled) return null;
      if ((out.state.cooldown ?? 0) > 0 && out.signal.kind !== 'enter') return null;
      const described = describeSignal(out.signal, {
        trend: engine.config.crossSessionTrend ? trend.summary() : undefined,
      });
      const record = {
        at: Date.now(),
        sessionId,
        level: out.signal.level,
        kind: out.signal.kind,
        ratioPercent: described.ratioPercent,
        title: described.title,
        body: described.body,
      };
      log.push(record);
      if (log.length > 200) log.splice(0, log.length - 200);
      if (engine.config.crossSessionTrend) trend.note(sessionId, out.signal.level);
      return { signal: out.signal, described, trend: trend.summary() };
    },
    /** 一轮结束：推进轮计数、清压缩标记、消耗冷却。 */
    endTurn(sessionId) {
      const next = nextTurn(stateOf(sessionId), engine.config);
      states.set(sessionId, next);
      return {
        turn: next.turn,
        level: next.level,
        cooldown: next.cooldown,
        occupancy: next.occupancy,
      };
    },
    /** 压缩结束 ⇒ 记一笔「水位刚被压过」，供 respectCompaction 与 UI 说明用。 */
    noteCompaction(sessionId, hadError) {
      if (hadError) return;
      const s = stateOf(sessionId);
      s.compactionDrop = true;
      states.set(sessionId, s);
    },
    /**
     * 解除武装：切模型/换路由之后调用。
     *
     * 理由：官方三个字段是 **last-wins、不是一个原子观测**，切模型后会出现
     * 「新窗口配旧压力」。解除武装意味着「要重新跨越 warn 才再响一次」——
     * 宁可晚一轮提示，也不要拿错配的数字喊「该换会话了」。
     * @returns {boolean} 之前是否处于已武装状态（供日志判断值不值得提一句）
     */
    resetArming(sessionId) {
      const s = stateOf(sessionId);
      const was = s.armed === true || s.level !== 'none';
      s.armed = false;
      s.level = 'none';
      s.cooldown = 0;
      states.set(sessionId, s);
      return was;
    },
    /**
     * 会话打开/恢复：§10.4 说这才是「跨会话」的实质 ——
     * 点进一个已经 85% 的历史会话，进去之前没人告诉你。
     */
    onResume(sessionId, pressure) {
      if (!engine.config.onResume) return null;
      const reading = readOccupancy(pressure);
      if (reading.known !== true) return null;
      if (reading.ratio < engine.config.hardRatio) return null;
      const described = describeSignal(
        {
          kind: 'enter',
          level: 'hard',
          ratio: reading.ratio,
          projectedTokens: reading.projectedTokens,
          contextWindow: reading.contextWindow,
          compactionDrop: false,
        },
        { trend: engine.config.crossSessionTrend ? trend.summary() : undefined },
      );
      return { signal: { kind: 'resume', level: 'hard', ratio: reading.ratio }, described };
    },
  };
  return engine;
}

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
   * 重新解析一次生效配置（volatile 字段读当前值）。只在**真的变了**时换进去并记一行日志，
   * 免得每轮都刷日志、也免得把一个恒等的对象换来换去。
   * @returns {object} 当前生效配置
   */
  const refreshConfig = () => {
    let next;
    try {
      next = normalizeConfig(rawConfig);
    } catch (error) {
      warn(`[${name}] 重新解析设置失败（继续用上一份）：${error?.message ?? error}`);
      return engine.config;
    }
    const current = engine.config;
    const changed = Object.keys(next).some((key) => next[key] !== current[key]);
    if (!changed) return current;
    engine.setConfig(next);
    info(
      `[${name}] 设置已更新：warn=${next.warnRatio} hard=${next.hardRatio} 冷却=${next.cooldownTurns}轮 ` +
        `enabled=${next.enabled} 外推=${next.pushChannel}`,
    );
    return next;
  };

  info(
    `[${name}] 已挂载：warn=${config.warnRatio} hard=${config.hardRatio} 迟滞=${config.hysteresisRatio} ` +
      `冷却=${config.cooldownTurns}轮 onResume=${config.onResume} enabled=${config.enabled} ` +
      `外推=${config.pushChannel}${config.pushChannel === 'none' ? '' : `(${config.pushMinLevel} 档起 / 间隔 ${config.pushCooldownMinutes} 分钟)`}`,
  );
  writeBeacon({
    enabled: config.enabled,
    warnRatio: config.warnRatio,
    hardRatio: config.hardRatio,
    hysteresisRatio: config.hysteresisRatio,
    cooldownTurns: config.cooldownTurns,
    onResume: config.onResume,
    pushChannel: config.pushChannel,
    pushMinLevel: config.pushMinLevel,
    pushCooldownMinutes: config.pushCooldownMinutes,
  });

  /** 一处格式化，避免日志与 UI 措辞各写一套。 */
  const logHit = (hit) => {
    const d = hit.described;
    logger?.warn ? logger.warn(`[${name}] ${d.title} —— ${String(d.body).split('\n').join(' ')}`) : undefined;
  };

  // ————————————————————————————————————————————————————————————————
  // 外推推送（§10.5 之后那条线）：**唯一会跑到用户手机上的副作用**。
  //
  // 三条设计约束，逐条都有理由：
  //   1. **默认关**（`pushChannel: 'none'`）——不请求就打扰人是错的；
  //   2. **只读已算好的结论**：正文就是 `describe()` 的那一句，不额外算、不额外请求（上下文税仍是 0）；
  //   3. **fail-soft**：通道缺席/发送失败只记一笔并写日志，**绝不**把异常抛回投影回调
  //      —— 提示插件不能成为别人的故障源。
  // 通道实现是软依赖：`wechatNotify` 由本机已装的 `dsh-damage-pulse` 提供（同一台机器上
  // damage-pulse 的微信推送走的就是它），缺席时只是推不出去，其余功能一切照旧。
  // ————————————————————————————————————————————————————————————————
  /** @type {{send?: (message: string) => Promise<unknown>}|undefined} */
  let wechatSender;
  const pushState = {
    lastAt: 0,
    lastResult: null,
    sent: 0,
    failed: 0,
    skipped: 0,
    /** 最近若干次外推（倒序），排障与验收用。 */
    history: [],
  };
  const notePush = (entry) => {
    pushState.history.push(entry);
    if (pushState.history.length > 20) pushState.history.splice(0, pushState.history.length - 20);
  };

  /**
   * 一次跨档要不要外推。**先占时刻再发送**：发送是异步的，若不先占，
   * 同一批里的第二条信号会在「上次推送时刻还是 0」的窗口里溜出去。
   */
  const maybePush = (hit) => {
    const live = refreshConfig();
    const decision = shouldPush(hit?.signal?.level, live, {
      now: Date.now(),
      lastPushAt: pushState.lastAt,
    });
    if (decision.push !== true) {
      if (decision.reason !== 'channel-off') pushState.skipped += 1;
      return decision;
    }
    const at = Date.now();
    pushState.lastAt = at;
    const text = pushText(hit.described);
    const finish = (result) => {
      pushState.lastResult = result;
      if (result?.ok === true) pushState.sent += 1;
      else pushState.failed += 1;
      notePush({ at, level: hit.signal.level, ok: result?.ok === true, code: result?.code ?? null });
      if (result?.ok !== true) {
        warn(`[${name}] 外推未成功（${result?.code ?? 'unknown'}）：${String(result?.detail ?? '').slice(0, 200)}`);
      }
    };
    if (typeof wechatSender?.send !== 'function') {
      finish({ ok: false, code: 'channel-absent', detail: 'wechatNotify 服务不可用（未装或未激活）' });
      return decision;
    }
    try {
      Promise.resolve(wechatSender.send(text))
        .then((result) => finish(result ?? { ok: false, code: 'empty-result', detail: '发送无返回' }))
        .catch((error) => finish({ ok: false, code: 'send-failed', detail: String(error?.message ?? error) }));
    } catch (error) {
      finish({ ok: false, code: 'send-failed', detail: String(error?.message ?? error) });
    }
    return decision;
  };

  ctx.inject(['wechatNotify'], (notifyCtx) => {
    const sender = notifyCtx.wechatNotify;
    if (sender === undefined || typeof sender.send !== 'function') {
      warn(`[${name}] 有 wechatNotify 服务但读不到 send()；外推推送保持不可用`);
      return;
    }
    wechatSender = sender;
    info(`[${name}] 外推通道就绪：wechatNotify`);
    notifyCtx.effect(
      () => () => {
        if (wechatSender === sender) wechatSender = undefined;
      },
      `${name}: wechatNotify 软依赖`,
    );
  });

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
      warn(`[${name}] 有 webServer 服务但读不到 register()；浏览器半边将退回内置默认值`);
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
                trend: live.crossSessionTrend ? engine.trend.summary() : undefined,
                recent: engine.recent(10),
                push: {
                  // 通道/档位/间隔一律从**当前生效配置**读，避免这里留一份会过期的副本
                  channel: live.pushChannel,
                  minLevel: live.pushMinLevel,
                  cooldownMinutes: live.pushCooldownMinutes,
                  lastAt: pushState.lastAt,
                  lastResult: pushState.lastResult,
                  sent: pushState.sent,
                  failed: pushState.failed,
                  skipped: pushState.skipped,
                  history: pushState.history.slice(-5).reverse(),
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
    info(`[${name}] 已注册宿主状态路由 ${STATE_ROUTE}（浏览器半边据此用真源阈值，而不是内置默认值）`);
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
   * 水位过 warnRatio 且又走了一个步进 ⇒ 起草/刷新一次。
   * **先占水位再落盘**：写是异步的，不先占的话同一批事件会重复写。
   */
  const maybeDraftHandover = (session, sessionId, pressure) => {
    try {
      const live = refreshConfig();
      if (live.handoverOnWarn !== true) return;
      const reading = readOccupancy(pressure);
      if (reading.known !== true || !Number.isFinite(reading.ratio)) return;
      if (reading.ratio < live.warnRatio) return;
      const step = Math.max(0.01, live.handoverRefreshPercent / 100);
      const prev = draftState.lastRatio.get(sessionId);
      if (prev !== undefined && reading.ratio - prev < step) return;
      if (draftState.pending.has(sessionId)) return;

      const m = material.get(sessionId) ?? {};
      const file = resolveHandoverPath(m.cwd, live.handoverPath);
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
      const block = composeHandoverBlock({ sessionId, now: Date.now(), reading, material: m, config: live, cwd: m.cwd });
      void writeHandoverBlock({ file, sessionId, block })
        .then((result) => {
          const ok = result.status !== 'error';
          if (ok) draftState.written += 1;
          else draftState.failed += 1;
          noteDraft({ at: Date.now(), sessionId, ratio: reading.ratio, ...result });
          info(
            `[${name}] 自动交接草稿${ok ? `（${result.status}）` : '失败'}：${result.path ?? '(无路径)'}` +
              `${ok ? '' : ` —— ${result.error}`}`,
          );
        })
        .catch((error) => {
          draftState.failed += 1;
          noteDraft({ at: Date.now(), sessionId, status: 'error', error: String(error?.message ?? error) });
        })
        .finally(() => draftState.pending.delete(sessionId));
    } catch (error) {
      // 起草失败绝不能影响徽标 / banner / 外推
      warn(`[${name}] 自动交接起草异常（已忽略）：${error?.message ?? error}`);
    }
  };

  // —— 投影变更：喂状态机。软依赖，缺席就只是不响（绝不把整棵树拖死）。
  ctx.inject(['sessionProjections'], (sctx) => {
    const projections = sctx.sessionProjections;
    if (projections === undefined || typeof projections.onChanged !== 'function') {
      warn(`[${name}] 有 sessionProjections 服务但读不到 onChanged；本插件静默降级`);
      return;
    }
    sctx.effect(
      () =>
        projections.onChanged((session, key, value) => {
          const id = sessionIdOf(session);
          if (MATERIAL_KEYS.has(key)) noteMaterial(id, key, value, session);
          if (key !== KEY) return;
          try {
            refreshConfig(); // 设置页改完不用重启：每一轮判断前都读一次当前设置
            const hit = engine.observe(id, value);
            if (hit !== null) {
              logHit(hit);
              maybePush(hit);
            }
            // 45% 起自动起草/刷新交接（零 LLM；写失败只记状态，不影响上面两步）
            maybeDraftHandover(session, id, value);
          } catch (error) {
            // 提示插件绝不能成为别人的故障源：任何意外只记日志，不向上抛。
            warn(`[${name}] observe 异常（已忽略）：${error?.message ?? error}`);
          }
        }),
      `${name}: sessionProjections.onChanged`,
    );
    info(`[${name}] 已订阅 ${KEY} 等 ${MATERIAL_KEYS.size} 个投影（判定 + 交接素材）`);
  });

  // —— 日志事件分派。**这是唯一能看到 turn/end 与 compaction 的地方**。
  ctx.on('session/event', (session, event) => {
    try {
      refreshConfig();
      if (event?.type === 'turn/end') {
        engine.endTurn(sessionIdOf(session));
        return;
      }
      if (event?.type === 'compaction/end') {
        engine.noteCompaction(sessionIdOf(session), Boolean(event.data?.error));
        return;
      }
      // 切模型/路由会换窗口，而官方三个字段是 last-wins、不是原子观测
      // ⇒ 切模型后「新窗口配旧压力」。保守地解除武装，宁可晚一轮提示。
      if (event?.type === 'request/header' || event?.type === 'model/selection') {
        const id = sessionIdOf(session);
        if (engine.resetArming(id)) {
          info(`[${name}] 路由/模型变化：会话 ${id} 的提示武装已重置（避免新窗口配旧压力）`);
        }
      }
    } catch (error) {
      warn(`[${name}] session/event 处理异常（已忽略）：${error?.message ?? error}`);
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
      const hit = engine.onResume(id, snap?.values?.[KEY]);
      if (hit !== null) {
        logHit(hit);
        maybePush(hit);
      }
      // 点进一个**已经很高**的历史会话：同一时刻就该把交接草稿备好（§10.4：会话打开才是「跨会话」的实质）
      maybeDraftHandover(session, id, snap?.values?.[KEY]);
    } catch (error) {
      warn(`[${name}] resume 判定异常（已忽略）：${error?.message ?? error}`);
    }
  });
}

export { defaultConfig, STATE_ROUTE, shouldPush, pushText } from './policy.mjs';
