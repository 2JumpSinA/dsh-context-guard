/**
 * dsh-context-guard · 纯策略（零依赖，host 半边与 client 半边共用一份）
 *
 * 这里只做「拿官方算好的数字 → 一个提示决策」这一件事，不碰任何 cordis / React / DOM：
 *   - 输入：`contextPressure` projection（`projectedTokens` / `contextWindow`）
 *   - 输出：`{ state, signal }`，signal 只在本轮**跨越**档位的那一刻非 null（边沿触发）
 *
 * 为什么必须是纯函数：§10.2 第 3 条要求这个插件的上下文税 = 0（不注册 model-facing 工具、
 * 不注入任何 prompt 段落）。纯函数可以在真机之外被完整覆盖，装进运行时之前就能证明
 * 「双档 + 迟滞 + 冷却 + compaction 回落 + fail-closed」五条都对。
 *
 * 本文件是 client 半边 `lib/client.js` 里内嵌那段策略的**唯一来源**：
 * `scripts/build-client.mjs` 把本文件（连同 `lib/i18n.mjs`）去掉 import/export 后注入 client 的
 * factory，`test/client-sync.test.mjs` 逐字节核对，所以不存在「两边各写一份、慢慢漂移」。
 *
 * ⚠️ 允许的唯一 import 是 `./i18n.mjs`（文案表，同样会被内联进同一个作用域）—— 见 build 脚本的
 * `SHARED_MODULES`。除此之外本文件必须保持零依赖。
 */
import { makeT } from './i18n.mjs';

/** 档位。'none' = 不提示；'warn' = 该收尾了；'hard' = 该换会话了。 */
export const LEVELS = ['none', 'warn', 'hard'];

/** 档位的可比较序（'none' < 'warn' < 'hard'），给「从哪一档起才外推」用。 */
export const LEVEL_ORDER = { none: 0, warn: 1, hard: 2 };

/**
 * 宿主状态读取路由（**host 注册、client 读取**的那条通路）。
 *
 * 为什么路径要住在共享策略里：它是两半边之间的**契约**。写两份就会出现
 * 「宿主换了路径、浏览器还在读旧路径」这类只在真机上才暴露的漂移，
 * 而 build-client 的同源护栏能把这类漂移直接变成红灯。
 */
export const STATE_ROUTE = '/api/context-guard/state';

/**
 * ⛔ **本文件里最贵的一条坑（2026-09-29 实测踩中）**：
 * 插件 `Config` 里标了 `.volatile()` 的字段，**`apply(ctx, config)` 收到的不是值，而是一个引用对象**
 * —— 只能 `config.warnRatio.get()` 拿到当前值。这是 DSH 让「设置页改完立即生效」的机制
 * （`@deepseek-ai/dsh-llm-deepseek` 的 `plainOptions()` 就是同一个写法）。
 *
 * 不摊平的后果是**静默拿到默认值**：patch 里配了 `warnRatio: 0.33`、设置页写进去了、
 * `settings.describe()` 也显示 0.33，而插件自己一直在按 0.6 判断 —— 没有任何报错，
 * 因为它读的是 `ref.warnRatio === undefined`。本次排查花了整整一轮，记在这里别再犯。
 *
 * 为什么不用 `import { isVolatile } from '@deepseek-ai/cosmokit'`：本插件靠 junction 挂在 profile 里，
 * Node 从**真实路径**（工作区内）解析依赖，那里没有 `@deepseek-ai/*`（`schemastery` 是我们自带的一份）。
 * 而 cosmokit 的判定就是 `Symbol.for('cosmokit.volatile.write') in value`，全局 symbol 跨副本同一把钥匙
 * ⇒ 自己写三行等价判定，比多挂一个包更稳。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 是不是 cosmokit 的 volatile 引用（照 `@deepseek-ai/cosmokit` 的 `isVolatile` 逐字等价）。 */
export function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
}

/**
 * 把 loader 交给插件的配置摊平成普通值（逐字段 `.get()`）。
 * 对普通对象（单测、client 收到的 JSON）是恒等变换，所以两边可以共用同一份。
 */
export function plainConfig(raw) {
  if (raw === null || typeof raw !== 'object') return {};
  const out = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    out[key] = isVolatileRef(value) ? value.get() : value;
  }
  return out;
}

/** 迟滞/冷却是**轮**为单位还是**观测**为单位，由调用方决定；这里只认单调自增的计数。 */
export function defaultConfig(overrides = {}) {
  return {
    enabled: true,
    // 用**官方定价**对「占用率 → 每次调用成本」曲线做过标定后，从 0.6 / 0.8 下调（见 README「阈值与设计取舍」）：
    //   · 观测到的会话峰值从未超过 ~80%（平台自身会在 ~80% 处 compaction）⇒ `hardRatio` 必须明显早于那一刻，
    //     否则 `respectCompaction` 会把提示消音，hard 档可能永远不出声；
    //   · 每次调用的成本随占用率近似线性上升（高档位约是空会话的数倍），因此越晚收尾越贵。
    warnRatio: 0.45,
    hardRatio: 0.6,
    hysteresisRatio: 0.05,
    cooldownTurns: 5,
    onResume: true,
    respectCompaction: true,
    includeCacheShare: true,
    crossSessionTrend: true,
    trendWindowHours: 24,
    trendEscalateAt: 3,
    // —— 自动交接草稿（2026-09-29 新增）。跨过 warnRatio 时由**宿主半边**零 LLM 起草一块机器事实
    //    （会话/水位/花费/改过的文件/最近几轮摘要），叙述留给 agent；只读已算好的投影 ⇒ 上下文税仍是 0。
    //    默认开：这是「一个任务一个会话」的落地动作 —— 45% 开始起草，60% 换会话时交接已经在文件里。
    handoverOnWarn: true,
    handoverPath: 'HANDOVER.md',
    handoverRefreshPercent: 5,
    handoverTurns: 6,
    handoverFiles: 12,
    // —— 文案语言（2026-09-30 新增）。`auto` 由两半边**各自**解析（能看到的线索不同）：
    //    client 看 `navigator.language`，host 看该会话首条用户输入是否含汉字，
    //    两边都拿不到 ⇒ 兜底 `zh`（保持升级前的行为，不惊动现有用户）。
    //    显式 `zh`/`en` 时两半边都听它的；设置页与启动日志用 `DSH_CONTEXT_GUARD_LOCALE` 兜底。
    locale: 'auto',
    // —— 外推推送（§10.5 之后那条线）。默认全关：**推送是显式选择**，
    //    一个提示插件绝不该在用户没要求的情况下往他手机里发消息。
    pushChannel: 'none',
    pushMinLevel: 'hard',
    pushCooldownMinutes: 10,
    ...overrides,
  };
}

/** 初始状态：一档都没武装（armed=false 表示还没进过 warn）。 */
export function initialState() {
  return {
    level: 'none',
    armed: false,
    turn: 0,
    cooldown: 0,
    compactionDrop: false,
    occupancy: null,
  };
}

/**
 * 把一份投影收敛成一次「观测」。
 *
 * ⛔ 一律 fail-closed（§10.3 第 5 条）：三个字段在官方那里是 **last-wins、不是一个原子观测**，
 * 切模型后会出现「新窗口配旧压力」。所以这里做三件保守的事：
 *   1. 分母（contextWindow）缺失 / 非正 / 非有限 ⇒ 不判定，UI 应显示「无数据」；
 *   2. 分子（projectedTokens）缺失 / 非有限 / 为负 ⇒ 同上；
 *   3. 分子 > 分母（只可能来自错配）⇒ 夹到 1.0，不产生 >100% 的荒谬提示。
 *
 * @param {{projectedTokens?: number, pressureTokens?: number, contextWindow?: number}|null|undefined} pressure
 * @returns {{known: boolean, ratio: number|null, ratioRaw: number|null, projectedTokens: number|null, pressureTokens: number|null, contextWindow: number|null, clampMismatch: boolean}}
 */
export function readOccupancy(pressure) {
  const empty = {
    known: false,
    ratio: null,
    ratioRaw: null,
    projectedTokens: null,
    pressureTokens: null,
    contextWindow: null,
    clampMismatch: false,
  };
  if (pressure === null || pressure === undefined || typeof pressure !== 'object') return empty;

  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const projected = num(pressure.projectedTokens);
  const window_ = num(pressure.contextWindow);
  const raw = num(pressure.pressureTokens);

  if (projected === null || projected < 0) return { ...empty, contextWindow: window_, pressureTokens: raw };
  if (window_ === null || window_ <= 0) return { ...empty, projectedTokens: projected, pressureTokens: raw };

  const ratioRaw = projected / window_;
  const clampMismatch = ratioRaw > 1;
  return {
    known: true,
    ratio: clampMismatch ? 1 : ratioRaw,
    ratioRaw,
    projectedTokens: projected,
    pressureTokens: raw,
    contextWindow: window_,
    clampMismatch,
  };
}

/**
 * 核心决策：吸收一次观测。
 *
 * 五条规则对应 §10.3 的五个坑：
 *   1. 挂的是 `projectedTokens / contextWindow`（该不该换会话），不是缓存命中率（那是 damage-pulse 的活）；
 *   2. 一律比率，不用绝对 token（换模型即换窗口）；
 *   3. 双档 warn/hard + 迟滞（回落到 warn−hysteresis 才重新武装）+ 边沿（只在跨越那一刻发信号）+ 冷却 N 轮；
 *   4. compaction 交互：数字掉下来 ⇒ 清掉触发标志；`respectCompaction` 时压缩后的高水位才算数；
 *   5. 数据缺席 ⇒ 不改状态、不发信号（fail-closed）。
 *
 * @param {object} state 上一次的 GuardState
 * @param {object} reading readOccupancy 的返回值
 * @param {object} [options] { respectCompaction?: boolean, atTurnBoundary?: boolean }
 * @returns {{state: object, signal: object|null}}
 */
export function reduce(state, reading, options = {}) {
  const next = { ...state };
  if (!reading || reading.known !== true || reading.ratio === null) {
    // fail-closed：无分母不动状态机，也不清除既有档位（清除要靠 nextTurn 或回落观测）。
    return { state: next, signal: null };
  }

  const cfg = options.config ?? defaultConfig();
  const ratio = reading.ratio;
  const hysteresis = Math.max(0, cfg.hysteresisRatio ?? 0);
  // 回落线：warn 以下 hysteresis 才算「真的下来了」。hard 不设独立回落线 —— 回到 warn 区间即可重新武装。
  const rearmBelow = Math.max(0, cfg.warnRatio - hysteresis);

  const wasLevel = state.level;
  next.occupancy = {
    ratio,
    ratioRaw: reading.ratioRaw,
    projectedTokens: reading.projectedTokens,
    contextWindow: reading.contextWindow,
    clampMismatch: reading.clampMismatch,
  };

  // —— 回落即清旗（§10.3 第 4 条）：压缩遮蔽一段后 projectedTokens 会掉下来。
  if (ratio < rearmBelow) {
    if (wasLevel !== 'none') next.compactionDrop = true; // 记录「掉下来过」，供 UI 说明
    next.level = 'none';
    next.armed = false;
  } else if (ratio < cfg.warnRatio) {
    next.compactionDrop = false;
  }

  if (ratio < cfg.warnRatio) return { state: next, signal: null };

  const level = ratio >= cfg.hardRatio ? 'hard' : 'warn';

  if (!next.armed) {
    next.armed = true;
    next.level = level;
    next.cooldown = Math.max(0, cfg.cooldownTurns ?? 0);
    // compaction 之后仍在高水位：只有当调用方声明「这轮紧跟一次压缩」时才抑制。
    const suppressed =
      cfg.respectCompaction === true && options.atTurnBoundary === true && options.justCompacted === true;
    if (suppressed) return { state: next, signal: null };
    return { state: next, signal: signalOf('enter', level, next) };
  }

  // 已武装：只在档位**升级**的那一次再响（warn → hard），同级重复不响。
  const rank = { none: 0, warn: 1, hard: 2 };
  if (rank[level] > rank[wasLevel]) {
    next.level = level;
    return { state: next, signal: signalOf('escalate', level, next) };
  }
  next.level = level > wasLevel ? level : wasLevel;
  return { state: next, signal: null };
}

/** 收口一只信号，字段名与 UI 措辞都从这里取，避免两边各拼一套。 */
function signalOf(kind, level, state) {
  return {
    kind, // 'enter' | 'escalate'
    level, // 'warn' | 'hard'
    ratio: state.occupancy?.ratio ?? null,
    projectedTokens: state.occupancy?.projectedTokens ?? null,
    contextWindow: state.occupancy?.contextWindow ?? null,
    turn: state.turn,
    compactionDrop: state.compactionDrop === true,
  };
}

/**
 * 一轮结束。§10.4：判定与提示只在 `turn/end`，绝不 mid-turn（那轮已经发出去了，提示没有意义）。
 *
 * @param {object} state
 * @param {object} [cfg]
 * @returns {object} 新状态
 */
export function nextTurn(state, cfg = defaultConfig()) {
  return {
    ...state,
    turn: state.turn + 1,
    cooldown: Math.max(0, (state.cooldown ?? 0) - 1),
    compactionDrop: false,
  };
}

/** 冷却期还没过 ⇒ 本轮即便跨档也不出声（但状态照样更新，徽标照样显示真数字）。 */
export function inCooldown(state) {
  return (state.cooldown ?? 0) > 0;
}

/**
 * 「这一次跨档要不要外推推送」——纯决策，与通道实现分离（§10.5 之后那条线）。
 *
 * 为什么单独抽出来而不是写在 `apply()` 里：推送是**唯一会跑到用户手机上的**副作用，
 * 它必须能在真机之外被逐条证伪（关着不推、不到档不推、冷却内不推），
 * 而不是靠「读一遍代码觉得没问题」。
 *
 * 与 UI 提示的关系：**外推是 UI 的补集，不是替代**。UI 侧的边沿触发已经保证「同一档位只响一次」，
 * 这里再加一道**跨会话的分钟级冷却** —— 否则同时开着三个会话时，三次硬跨档会连着往微信里发三条。
 *
 * @param {string} level 本次信号的档位（'none' | 'warn' | 'hard'）
 * @param {object} [config] 归一化后的配置
 * @param {{now?: number, lastPushAt?: number}} [state] 注入时钟与上次推送时刻（便于单测）
 * @returns {{push: boolean, reason: string, channel: string, cooldownMs: number}}
 */
export function shouldPush(level, config = {}, state = {}) {
  const channel = config.pushChannel ?? 'none';
  const cooldownMs = Math.max(0, Number(config.pushCooldownMinutes ?? 0)) * 60_000;
  const verdict = (push, reason) => ({ push, reason, channel, cooldownMs });
  if (channel === 'none') return verdict(false, 'channel-off');
  if (level === undefined || level === null) return verdict(false, 'no-level');
  const rank = LEVEL_ORDER[level] ?? 0;
  const min = LEVEL_ORDER[config.pushMinLevel ?? 'hard'] ?? LEVEL_ORDER.hard;
  if (rank === 0) return verdict(false, 'level-none');
  if (rank < min) return verdict(false, 'below-min-level');
  const now = typeof state.now === 'number' ? state.now : Date.now();
  const lastPushAt = typeof state.lastPushAt === 'number' ? state.lastPushAt : 0;
  if (lastPushAt > 0 && now - lastPushAt < cooldownMs) return verdict(false, 'cooldown');
  return verdict(true, 'edge');
}

/**
 * 外推推送的正文：一处格式化，UI 与 IM 说同一句话（含指向 `HANDOVER.md` 的下一步）。
 *
 * ⚠️ 语言**优先跟 `described.lang` 走**：`title`/`body` 是 `describe()` 在那一刻按某种语言生成的，
 * 只把前缀换成另一种语言会得到中英混排的一句话。`opts.lang` 是给「调用方自己拼的 described
 * （老代码 / 手工构造）」留的兜底，不是覆盖开关。
 *
 * @param {{title?: string, body?: string, lang?: 'zh'|'en'}} described `describe()` 的结论
 * @param {{lang?: 'zh'|'en'}} [opts] 兜底语言（`described.lang` 缺席时才看它，再不给就是 `zh`）
 * @returns {string}
 */
export function pushText(described, opts = {}) {
  const lang = (described?.lang ?? opts.lang) === 'en' ? 'en' : 'zh';
  const t = makeT(lang);
  const title = described?.title ?? t('push.title');
  const body = described?.body ?? '';
  return t('push.prefix', { title, body });
}

/**
 * 跨会话趋势（§10.5 的第二种语义）。
 *
 * 「最近 3 个会话都撞 hard」比「这个会话该换了」大一号：措辞该升级成「该换工作方式」。
 * 只在内存里存最近 `trendWindowHours` 小时内的触发时刻与档位，重启即清零 —— 这是提示性
 * 统计，不是账本，不值得落盘、更不该因此引入 IO 失败面。
 */
export class TrendTracker {
  /** @param {object} [cfg] */
  constructor(cfg = defaultConfig()) {
    this.cfg = cfg;
    /** @type {{at: number, sessionId: string, level: string}[]} */
    this.events = [];
  }

  /** 记一次触发。同一会话同一档位只记一次（避免徽标刷屏把趋势泡涨）。 */
  note(sessionId, level, at = Date.now()) {
    if (level !== 'warn' && level !== 'hard') return;
    const dup = this.events.some((e) => e.sessionId === sessionId && e.level === level);
    if (dup) return;
    this.events.push({ at, sessionId, level });
    this.prune(at);
  }

  /** 丢掉窗口之外的事件。 */
  prune(at = Date.now()) {
    const cutoff = at - Math.max(1, this.cfg.trendWindowHours ?? 24) * 3600_000;
    this.events = this.events.filter((e) => e.at >= cutoff);
  }

  /**
   * @param {number} [at]
   * @returns {{hardSessions: number, warnSessions: number, escalated: boolean, windowHours: number}}
   */
  summary(at = Date.now()) {
    this.prune(at);
    const hard = new Set();
    const warn = new Set();
    for (const e of this.events) (e.level === 'hard' ? hard : warn).add(e.sessionId);
    return {
      hardSessions: hard.size,
      warnSessions: warn.size,
      escalated: hard.size >= Math.max(2, this.cfg.trendEscalateAt ?? 3),
      windowHours: this.cfg.trendWindowHours ?? 24,
    };
  }
}

/**
 * 提示文案。§10.6：占比数字 + 下一步动作 + 指向交接文档。
 *
 * 刻意**不自造**上下文传递机制，而是指回本工作区既有的 `HANDOVER.md` 惯例
 * （新会话入场成本 ≈3K token）。与 `dsh-migrate-on-429` 的分工：这里只是预防性提示。
 *
 * @param {object} signal
 * @param {object} [opts] { trend?: object, handoffDoc?: string, lang?: 'zh'|'en' }
 * @returns {{title: string, body: string, ratioPercent: number, level: string, lang: 'zh'|'en'}}
 */
export function describe(signal, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  const t = makeT(lang);
  const doc = opts.handoffDoc ?? 'HANDOVER.md';
  const ratio = signal.ratio ?? 0;
  const percent = Math.round(ratio * 100);
  const projected = signal.projectedTokens;
  const window_ = signal.contextWindow;
  const kTokens = (n) => (typeof n === 'number' ? `${Math.round(n / 1000)}K` : '?');
  const trend = opts.trend;
  const trendLine =
    trend && trend.escalated ? t('banner.trend', { hours: trend.windowHours, sessions: trend.hardSessions }) : '';
  const compactionLine = signal.compactionDrop === true ? t('banner.compaction') : '';

  return {
    level: signal.level,
    ratioPercent: percent,
    lang,
    title: t(signal.level === 'hard' ? 'banner.title.hard' : 'banner.title.warn', { percent }),
    body: t('banner.body', {
      projected: kTokens(projected),
      window: kTokens(window_),
      percent,
      compaction: compactionLine,
      doc,
      trend: trendLine,
    }),
  };
}

/** 徽标只显示数字，不显示措辞；无数据时给一句显式的话（不要假装是 0%）。 */
export function badgeText(reading) {
  if (!reading || reading.known !== true || reading.ratio === null) return { text: 'ctx —', known: false };
  return { text: `ctx ${Math.round(reading.ratio * 100)}%`, known: true };
}

export { signalOf };
