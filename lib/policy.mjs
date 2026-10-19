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
 * 手动「写好交接」的触发路由（banner 按钮 → `POST DRAFT_ROUTE?sessionId=…`）。
 *
 * 与 `STATE_ROUTE` 一样住在共享策略里：它是两半边之间的契约，写两份迟早漂移。
 * 语义上它是**一次性的强制起草** —— 跳过「水位涨够才刷」的步进闸门，但仍然
 * 尊重 `handoverOnWarn`、尊重 pending 锁、只写机器事实（零 LLM）。
 */
export const DRAFT_ROUTE = '/api/context-guard/draft';

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
    // —— v0.5.0：`crossSessionTrend` / `trendWindowHours` / `trendEscalateAt` **保留为 no-op**。
    //    行为（TrendTracker、banner 正文、/state.trend）已删除；键不删是因为旧 profile 的
    //    cordis.patch.yml 里可能还写着它们，而 schema 不认键会让插件 init 失败 ⇒ 整机起不来。
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
    // —— v0.5.0：`pushChannel` / `pushMinLevel` / `pushCooldownMinutes` **保留为 no-op**（同上）。
    //    外推推送行为与 i18n 已删除；键保留只为兼容旧配置。
    pushChannel: 'none',
    pushMinLevel: 'hard',
    pushCooldownMinutes: 10,
    ...overrides,
  };
}

/*
 * —— 判定状态机已迁走（v0.4.3，复审报告 §2 建议 #6）——
 *
 * `initialState` / `reduce` / `nextTurn` / `inCooldown` / `signalOf` 现在住在 `lib/engine.mjs`。
 * 理由：本文件是**两半边共用**、会被逐字内联进浏览器 bundle 的那份代码；状态机住在里面，
 * 客户端就永远「有一套可用的判定逻辑」，P1-5 那类漂移迟早会回来。搬走之后「客户端没有判定逻辑」
 * 是结构性事实，而不是自觉。
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
 * v0.5.0：`shouldPush` / `pushText` / `TrendTracker` **已删除**。
 *   外推推送：136 个 IM 插件在做同一件事，且它是本插件唯一需要 network/外部服务的组件；
 *   跨会话趋势：只有宿主侧一句正文 + `/state.trend`，且**重启即清零的内存统计**（不是账本）。
 *   两者对应的 i18n 键一并删除；配置键保留为 no-op（见 `defaultConfig` 注释），删键会让旧配置起不来。
 */

/**
 * 提示文案。§10.6：占比数字 + 下一步动作 + 指向交接文档。
 * @param {object} signal
 * @param {object} [opts] { handoffDoc?: string, lang?: 'zh'|'en' }
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
  const compactionLine = signal.compactionDrop === true ? t('banner.compaction') : '';
  /**
   * v0.6.2：自动压缩点的**三态**。
   *   · `config` —— 读到 DSH 解析后的配置：给数字，且**不许**出现「约/推算」；
   *   · `default` —— 只有出厂常量：给数字，但必须同屏带 `≈` + 来源原因；
   *   · `off` —— 自动压缩被关掉：不给数字，改说「不会自动压缩」；
   *   · `none` —— 算不出来（缺窗口/缺预留）：整句省略，不编数字。
   */
  const compactPercent = Number.isFinite(opts.compactPercent) ? opts.compactPercent : null;
  const basis = opts.compactBasis === 'config' || opts.compactBasis === 'default' || opts.compactBasis === 'off' ? opts.compactBasis : 'none';
  const point =
    compactPercent === null || basis === 'off'
      ? ''
      : t(basis === 'config' ? 'banner.body.hard.point.exact' : 'banner.body.hard.point.estimated', {
          percent: compactPercent.toFixed(1),
        });
  const bodyKey =
    basis === 'off' ? 'banner.body.hard.off' : signal.level === 'hard' ? 'banner.body.hard' : 'banner.body.warn';

  return {
    level: signal.level,
    ratioPercent: percent,
    lang,
    title: t(signal.level === 'hard' ? 'banner.title.hard' : 'banner.title.warn', { percent }),
    body: t(bodyKey, {
      projected: kTokens(projected),
      window: kTokens(window_),
      percent,
      compaction: compactionLine,
      doc,
      point,
    }),
  };
}

/** 徽标只显示数字，不显示措辞；无数据时给一句显式的话（不要假装是 0%）。 */
export function badgeText(reading) {
  if (!reading || reading.known !== true || reading.ratio === null) return { text: 'ctx —', known: false };
  return { text: `ctx ${Math.round(reading.ratio * 100)}%`, known: true };
}

/**
 * **显示档位**（v0.4.6，真机故障 §37.4）：把「宿主档位」与「官方占用率」合成一个**只读**的显示值。
 *
 * 为什么需要：宿主镜像的档位只在**事件驱动**时前进（`projection.drive`）。打开一个恢复出来的
 * 历史会话**不产生新事件** —— `hydrate` 只算一遍快照、不通知监听者 —— 所以页面加载那一刻
 * 宿主可能还是 `none`，而官方 `contextPressure` 已经是 67%：徽标有数字、banner 不弹，
 * 要等用户先发一条消息才补上。这是「启动那一刻的基线」问题（§37.5），不是判定问题。
 *
 * 边界（**这不是第二套状态机**）：
 *   · 宿主给了 `warn` / `hard` ⇒ 一律听宿主的，本函数什么都不改；
 *   · 阈值由**宿主投影**随 `warnRatio`/`hardRatio` 下发；缺席时才用 `defaultConfig()` 的出厂值；
 *   · 迟滞、冷却、武装、轮次、日志、外推**一个都不在这里** —— 客户端拿不到也写不了判定状态；
 *   · 宿主显式 `enabled: false` ⇒ 直接 `none`（总开关仍然只在宿主）。
 */
export function displayLevel(view, reading, defaults = undefined) {
  const host = view && LEVELS.includes(view.level) ? view.level : 'none';
  if (host !== 'none') return host;
  if (view && view.enabled === false) return 'none';
  if (!reading || reading.known !== true || !Number.isFinite(reading.ratio)) return host;
  const base = defaults ?? defaultConfig();
  const hard = view && Number.isFinite(view.hardRatio) ? view.hardRatio : base.hardRatio;
  const warn = view && Number.isFinite(view.warnRatio) ? view.warnRatio : base.warnRatio;
  if (Number.isFinite(hard) && reading.ratio >= hard) return 'hard';
  if (Number.isFinite(warn) && reading.ratio >= warn) return 'warn';
  return host;
}

/**
 * **banner 显示档位**（v0.6.3，产品决定：45% 只静默起草，提醒只在 60%）。
 *
 * 为什么撤掉 warn 那条 banner：它没有事实依据（平台事实是「压缩点」，不是「45% 会出事」），
 * 而且 `bannerSeen` 只在点「知道了」时消解 ⇒ 它会在 45→60 的 15pp 里常驻，
 * 训练出「见 banner 就关」的反射，反而稀释 60% 那条的信噪比。
 * 45% 的**起草**保留（`maybeDraftHandover` 仍按 `warnRatio` 触发），只是不再出声。
 *
 * 语义不变：一旦出过声（hard），水位回落后仍沿用 hard，直到用户点「知道了 / ×」。
 * 纯函数：不读不写任何判定状态。
 */
export function shownBannerLevel(level, firedLevel) {
  if (level === 'hard') return 'hard';
  return firedLevel === 'hard' ? 'hard' : 'none';
}
