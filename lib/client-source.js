/**
 * dsh-context-guard · client 半边 UI（被 `scripts/build-client.mjs` 内联进 client.js）
 *
 * 这一半做三件事（§10.2 第 4 条「宿主算数、UI 说话」的 UI 侧）：
 *   1. 会话头徽标：实时占用率，**只显示数字、不出声**；
 *   2. 跨越 warn/hard 时一次性 banner：占比 + 下一步动作 + 指向 `HANDOVER.md`（§10.6）；
 *   3. 两个槽位共用**同一台状态机**（否则徽标与 banner 会各说各话）。
 *
 * ⛔ 不注入 prompt、不注册 model-facing 工具、不发额外请求 ⇒ 上下文税 0。
 * 数字全部来自官方 `contextPressure` 投影（`useProjection` 这个第五个标准钩子席），
 * 插件只是消费已算好的值。
 *
 * 阈值来源（**三层，优先级由低到高**，`runtimeConfig` 一处合并）：
 *   1. 内嵌策略的 `defaultConfig()`（出厂默认，两边同一份代码）；
 *   2. **宿主真源**：`fetch(STATE_ROUTE)` 读 `lib/index.js` 归一化后的 Config
 *      （`/api/context-guard/state`，同一台机器上的 webServer 路由，无 token、same-origin）
 *      —— 这就是原先「client 读不到宿主设置」那个未做完项的通路；
 *   3. **逃生阀** `window.__DSH_CONTEXT_GUARD__.config`（Console 里可实时改，优先级最高）。
 *
 * ⚠️ 第 2 层是 **fail-soft**，不是 fail-closed：读不到宿主设置时**退回第 1 层默认值继续工作**。
 *    这与 §10.3 第 5 条（缺分母就不判定）不是一回事 —— 那里是「没有事实就不许下结论」，
 *    这里是「拿不到偏好就用默认偏好」，一句提示的档位不值得因为一次 fetch 失败而消失。
 *
 * 语言（`config.locale`，2026-09-30 新增）：`auto` 时**本半边看 `navigator.language`**
 * （宿主半边看的是该会话首条输入是否含汉字 —— 两边能看到的线索本来就不同，见 `lib/i18n.mjs`）。
 * 文案全部查 `STRINGS` 表；表与策略一起被内联进同一个作用域，所以这里直接用 `makeT` / `pickLocale`。
 */

/**
 * 读宿主真源（第 2 层）。**一次**（页面加载时），失败就退回默认值；
 * 设置改完要刷新页面才生效 —— 与「client 半边要刷新浏览器才进图」是同一件事。
 * 不轮询：提示插件不该为了几个阈值一直占着网络。
 */
var hostSync = { status: 'idle', at: 0, error: null, route: STATE_ROUTE, keys: 0 };

/**
 * 逃生阀 + 宿主真源：**三层合并**（默认 < 宿主 < 逃生阀），一处收敛。
 *   - 页面脚本/用户任意时刻调 `window.__DSH_CONTEXT_GUARD__.override({ warnRatio: 0.3 })`
 *     就会重算配置并让 store 与两个槽位下一次渲染立刻用新档位（不用刷新页面）；
 *   - 如果页面上**已经有**这个对象（例如验证脚本用 addInitScript 先设好），
 *     就把它当初始覆盖读进来；
 *   - `host` 是 `fetch(STATE_ROUTE)` 读回来的宿主 Config（见上）。
 *
 * ⚠️ 配置在 **store 创建时**读、之后只在 override / 宿主同步时重算 —— 不在模块顶层读：
 * client bundle 的整个主体就是一个 `factory()`，内联进来的策略代码被包在 `try {}` 里，
 * 在那里 `var` 声明却在块外读取会踩提升顺序的坑（首轮实测就是这个：`CONFIG is not defined`）。
 */
function overrideFromWindow() {
  var w = typeof window !== "undefined" ? window.__DSH_CONTEXT_GUARD__ : undefined;
  return (w && w.config) || {};
}

/** 只认策略认识的那些键：宿主多塞字段（或恶意页面塞东西）不该改变档位语义。 */
function pickKnown(source) {
  var out = {};
  var known = defaultConfig();
  for (var k in known) {
    if (!Object.prototype.hasOwnProperty.call(known, k)) continue;
    if (source && Object.prototype.hasOwnProperty.call(source, k)) out[k] = source[k];
  }
  return out;
}

function runtimeConfig(hostConfig, overrideConfig) {
  var cfg = defaultConfig(pickKnown(hostConfig));
  cfg = defaultConfig(Object.assign({}, cfg, pickKnown(overrideConfig)));
  if (!(cfg.hardRatio > cfg.warnRatio)) cfg.hardRatio = Math.min(1, cfg.warnRatio + 0.05);
  return cfg;
}

/**
 * 每会话一台状态机 + 一个趋势表。**两个槽位共用同一个实例**。
 *
 * 两条防自激的设计（都是踩过 React 外部 store 的经典坑）：
 *   - `offer` 记住上一次收到的 pressure **引用**，同一个引用直接返回 —— 投影值本身是
 *     reference-stable 的（每帧/基线才换一次），所以「effect → offer → notify → 重渲染 →
 *     effect」这条环在这里被切断，不会自旋。
 *   - 观测走**串行队列**：microtask 里一次排空，保证状态机推进顺序 == 事件顺序
 *     （同步合并会把两个连续观测压成一个，边沿就丢了）。
 */
function createGuardStore() {
  var hostCfg = {};
  var overrideCfg = overrideFromWindow();
  var cfg = runtimeConfig(hostCfg, overrideCfg);
  var sessions = new Map();
  var trend = new TrendTracker(cfg);
  var listeners = new Set();
  var queue = [];
  var draining = false;

  /**
   * 本半边的语言解析：显式 `zh`/`en` 最高，其次 `navigator.language`，都没有 ⇒ `zh` 兜底。
   * 每次配置变化（宿主同步 / 逃生阀 override）都重算 —— 改语言不必刷新页面。
   */
  function resolveLocale() {
    return pickLocale(cfg.locale, {
      navigatorLanguage: typeof navigator !== "undefined" ? navigator.language : undefined,
    });
  }
  var locale = resolveLocale();
  var t = makeT(locale);
  function retranslate() {
    var next = resolveLocale();
    if (next === locale) return;
    locale = next;
    t = makeT(next);
  }

  function slotOf(id) {
    var s = sessions.get(id);
    if (s === undefined) {
      s = { state: initialState(), reading: null, signal: null, seq: 0, lastPressure: undefined };
      sessions.set(id, s);
    }
    return s;
  }

  function emit() {
    listeners.forEach(function (notify) {
      try {
        notify();
      } catch (error) {
        /* 一个订阅者炸了不能拖死别的槽位 */
      }
    });
  }

  function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        var item = queue.shift();
        consume(item[0], item[1]);
      }
    } finally {
      draining = false;
    }
  }

  function consume(sessionId, pressure) {
    var session = slotOf(sessionId);
    var reading = readOccupancy(pressure);
    var out = reduce(session.state, reading, { config: cfg, atTurnBoundary: true, justCompacted: false });
    var changed = session.reading === null || !sameReading(session.reading, reading);
    session.state = out.state;
    session.reading = reading;
    if (out.signal !== null && cfg.enabled) {
      var cooled = out.state.cooldown > 0 && out.signal.kind !== "enter";
      if (!cooled) {
        session.signal = out.signal;
        session.seq += 1;
        changed = true;
        if (cfg.crossSessionTrend) trend.note(sessionId, out.signal.level);
      }
    }
    if (changed) emit();
  }

  function sameReading(a, b) {
    return (
      a.known === b.known &&
      a.ratio === b.ratio &&
      a.projectedTokens === b.projectedTokens &&
      a.contextWindow === b.contextWindow &&
      a.clampMismatch === b.clampMismatch
    );
  }

  return {
    config: function () {
      return cfg;
    },
    /** 当前文案语言（`zh` / `en`）。给排障把手与验收脚本看，别在组件里自己算。 */
    locale: function () {
      return locale;
    },
    /** 查表函数：组件渲染统一走它，避免半句中文半句英文。 */
    t: function (key, vars) {
      return t(key, vars);
    },
    /** 实时改档位（顺序地套用 normalize 规则），供 `__DSH_CONTEXT_GUARD__.override()` 用。 */
    setConfig: function (next) {
      for (var j in next) if (Object.prototype.hasOwnProperty.call(next, j)) overrideCfg[j] = next[j];
      cfg = runtimeConfig(hostCfg, overrideCfg);
      trend.cfg = cfg;
      retranslate();
      emit();
      return cfg;
    },
    /**
     * 套用宿主真源（第 2 层）。**只影响档位与措辞，不碰任何会话状态** ——
     * 已经算出来的读数不会被一次配置同步抹掉，否则「改个阈值就把 banner 的判据洗掉」。
     */
    setHostConfig: function (next) {
      hostCfg = pickKnown(next);
      cfg = runtimeConfig(hostCfg, overrideCfg);
      trend.cfg = cfg;
      retranslate();
      emit();
      return cfg;
    },
    hostConfig: function () {
      return hostCfg;
    },
    trend: function () {
      return trend.summary();
    },
    sessionOf: function (id) {
      return sessions.get(id) || null;
    },
    /** 排障用只读快照：每会话的档位、读数、信号序号。 */
    dump: function () {
      var out = {};
      sessions.forEach(function (value, key) {
        out[key] = {
          level: value.state ? value.state.level : null,
          armed: value.state ? value.state.armed : null,
          cooldown: value.state ? value.state.cooldown : null,
          seq: value.seq,
          reading: value.reading,
          signal: value.signal,
        };
      });
      return out;
    },
    subscribe: function (notify) {
      listeners.add(notify);
      return function () {
        listeners.delete(notify);
      };
    },
    offer: function (sessionId, pressure) {
      var session = slotOf(sessionId);
      if (pressure === session.lastPressure) return; // 切断自激环（见上）
      session.lastPressure = pressure;
      queue.push([sessionId, pressure]);
      queueMicrotask(drain);
    },
    settleTurn: function (sessionId) {
      var session = slotOf(sessionId);
      session.state = nextTurn(session.state, cfg);
    },
  };
}

var store = createGuardStore();

/**
 * 从宿主真源同步一次设置（`GET STATE_ROUTE`）。
 *
 * 三条不许破的性质：
 *   - **不抛**：任何失败都收敛成 `hostSync.status = 'failed'` + 退回默认值（fail-soft，见文件头）；
 *   - **不刷屏**：只在 `apply()` 时读一次；Console 里可手动 `refreshFromHost()`；
 *   - **不影响渲染路径**：sync 只写配置与一个只读状态对象，槽位渲染不依赖它完成（先渲染、后到货）。
 *
 * @returns {Promise<{status: string, config?: object}>} 永不 reject
 */
function syncFromHost() {
  if (typeof fetch !== "function") {
    hostSync = { status: "unsupported", at: Date.now(), error: "no fetch", route: STATE_ROUTE, keys: 0 };
    return Promise.resolve({ status: hostSync.status });
  }
  hostSync = { status: "loading", at: Date.now(), error: null, route: STATE_ROUTE, keys: 0 };
  return fetch(STATE_ROUTE, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } })
    .then(function (response) {
      if (!response || response.ok !== true) throw new Error("HTTP " + (response ? response.status : "?"));
      return response.json();
    })
    .then(function (payload) {
      var host = (payload && payload.config) || {};
      var applied = store.setHostConfig(host);
      hostSync = {
        status: "ok",
        at: Date.now(),
        error: null,
        route: STATE_ROUTE,
        keys: Object.keys(host).length,
        pushChannel: applied.pushChannel,
        at_host: payload && payload.at,
      };
      return { status: "ok", config: applied };
    })
    .catch(function (error) {
      hostSync = {
        status: "failed",
        at: Date.now(),
        error: String((error && error.message) || error).slice(0, 200),
        route: STATE_ROUTE,
        keys: 0,
      };
      return { status: "failed", error: hostSync.error };
    });
}

/**
 * 槽位内的订阅钩子。`getSnapshot` 返回会话槽对象本身（引用稳定，只有真的变了才换），
 * 所以 React 拿到的是一个不会每次渲染都新建的值。
 */
function useGuard(sessionId) {
  return react.useSyncExternalStore(
    function (notify) {
      return store.subscribe(notify);
    },
    function () {
      return store.sessionOf(sessionId);
    },
    function () {
      return null;
    },
  );
}

/** 投影钩子席的防御性读取：席位缺席（旧 harness / 没有 token-meter）时返回 undefined，
 *  而不是把异常抛进整个会话头。 */
function safeProjection(props, key) {
  try {
    if (props && typeof props.useProjection === "function") return props.useProjection(key);
  } catch (error) {
    /* capability absent */
  }
  return undefined;
}

/** 两个槽位共用的「喂观测」效果。 */
function useOffer(sessionId, pressure) {
  react.useEffect(
    function () {
      if (sessionId !== null) store.offer(sessionId, pressure);
    },
    [sessionId, pressure],
  );
}

function sessionIdOf(props) {
  var id = props && (props.sessionId !== undefined ? props.sessionId : props.session && props.session.id);
  return id === undefined || id === null || id === "" ? null : String(id);
}

var COLORS = {
  none: { fg: "var(--dsh-text-secondary, #6b7280)", dot: "var(--dsh-text-tertiary, #9ca3af)" },
  warn: { fg: "var(--dsh-warning-text, #b45309)", dot: "var(--dsh-warning, #f59e0b)" },
  hard: { fg: "var(--dsh-danger-text, #b91c1c)", dot: "var(--dsh-danger, #dc2626)" },
};

function kTokens(n) {
  return typeof n === "number" && isFinite(n) ? Math.round(n / 1000) + "K" : "?";
}

/**
 * 徽标：`ctx 82%`。**无数据时显式显示「ctx —」**（§10.3 第 5 条 fail-closed：
 * 没有分母就绝不假装是 0%，UI 上必须是两句话）。
 */
function Badge(props) {
  var sessionId = sessionIdOf(props);
  var pressure = safeProjection(props, "contextPressure");
  useOffer(sessionId, pressure);

  var session = useGuard(sessionId);
  var cfg = store.config();
  var reading = session ? session.reading : null;
  var badge = badgeText(reading);
  var level = (session && session.state && session.state.level) || "none";
  var colors = COLORS[level] || COLORS.none;
  var ratio = reading && reading.known ? Math.max(0, Math.min(1, reading.ratio)) : 0;
  var hasData = badge.known;
  var percent = Math.round((reading && reading.ratio ? reading.ratio : 0) * 100);

  var tr = store.t;
  var title;
  if (hasData) {
    title =
      tr("badge.title.context", {
        projected: kTokens(reading.projectedTokens),
        window: kTokens(reading.contextWindow),
        percent: percent,
      }) +
      "\n" +
      tr("badge.title.thresholds", {
        warn: Math.round(cfg.warnRatio * 100),
        hard: Math.round(cfg.hardRatio * 100),
      }) +
      (cfg.pushChannel !== "none"
        ? "\n" + tr("badge.title.push", { level: cfg.pushMinLevel, minutes: cfg.pushCooldownMinutes })
        : "") +
      "\n" +
      tr("badge.title.source.label") +
      (hostSync.status === "ok"
        ? tr("badge.title.source.host")
        : tr("badge.title.source.builtin", { status: hostSync.status })) +
      (level === "hard"
        ? "\n" + tr("badge.action.hard")
        : level === "warn"
          ? "\n" + tr("badge.action.warn")
          : "");
  } else {
    title = tr("badge.title.nodata");
  }

  return react.createElement(
    "div",
    {
      title: title,
      "data-dsh-context-guard": "badge",
      "data-level": level,
      "data-percent": hasData ? String(percent) : "",
      style: {
        display: "inline-flex",
        flexDirection: "column",
        gap: "2px",
        padding: "2px 7px",
        borderRadius: "8px",
        border: "1px solid var(--dsh-border, rgba(128,128,128,.28))",
        background: "var(--dsh-surface-secondary, rgba(128,128,128,.06))",
        lineHeight: 1.1,
        cursor: "default",
        userSelect: "none",
      },
    },
    react.createElement(
      "span",
      {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          fontSize: "11px",
          fontWeight: 600,
          color: colors.fg,
          whiteSpace: "nowrap",
        },
      },
      react.createElement("span", {
        style: { width: "6px", height: "6px", borderRadius: "50%", background: colors.dot, flex: "0 0 auto" },
      }),
      badge.text,
    ),
    react.createElement(
      "span",
      {
        style: {
          display: "inline-flex",
          gap: "2px",
          height: "2px",
          width: "34px",
          opacity: hasData ? 1 : 0.3,
          background: "var(--dsh-border, rgba(128,128,128,.25))",
          borderRadius: "2px",
          overflow: "hidden",
        },
      },
      react.createElement("span", { style: { flex: String(Math.max(0.0001, ratio)), background: colors.dot } }),
      react.createElement("span", { style: { flex: String(Math.max(0.0001, 1 - ratio)) } }),
    ),
  );
}

/**
 * 一次性 banner（§10.4「当前回复结束后提示」+ §10.6 文案）。
 *
 * 「一次性」只由**两道真闸**保证，刻意**不做**「用户一动鼠标就算他看过了」那种聪明：
 *   ① 策略层 `signal` 只在**跨越那一刻**产生（边沿触发），同级重复不产生；
 *   ② 本 Map 记「本会话这一档位已经出过声」—— 点「知道了」或 × 才写一条。
 * 只有**回落之后重新爬升**（策略会再产生一个 enter）或**升级到下一档**时才会再来一次，
 * 那是想要的行为，不是复读。
 *
 * ⚠️ 首轮实测踩过的坑：一开始还加了「窗口级 mousedown/keydown 就标已读」，
 * 结果用户在 banner 出现**之前**的任何点击（例如点侧栏新建会话）都会把它标掉，
 * 于是「明明该响却不响」，而且原因极难查。提示插件的原则是**宁可留着让人点掉**，
 * 也不要替用户判定「他已经看过了」。
 */
var bannerSeen = new Map();

function Banner(props) {
  var sessionId = sessionIdOf(props);
  var pressure = safeProjection(props, "contextPressure");
  useOffer(sessionId, pressure);

  var session = useGuard(sessionId);
  var cfg = store.config();
  var bumpPair = react.useState(0);
  var bump = bumpPair[1];
  var level = session && session.state ? session.state.level : "none";
  var reading = session ? session.reading : null;
  var ratio = reading && reading.known ? reading.ratio : 0;
  var key = sessionId !== null ? sessionId + "|" + level : null;
  var seen = key !== null ? bannerSeen.get(key) : undefined;
  /** 只在「本会话这一档位还没出过声」时才显示。 */
  var visible = level !== "none" && cfg.enabled && key !== null && seen === undefined;

  if (!visible) return null;

  try {
    return renderBanner(props, { sessionId: sessionId, session: session, level: level, reading: reading, ratio: ratio, key: key, cfg: cfg, bump: bump });
  } catch (error) {
    // React 会吞掉渲染期异常（没有 error boundary 时只留下一条 console 错误），
    // 所以这里显式接住并打点：宁可看见一条噪音日志，也不要「明明该响却不响」。
    if (typeof window !== "undefined") {
      window.__DSH_CONTEXT_GUARD_ERR__ = (window.__DSH_CONTEXT_GUARD_ERR__ || []).concat([
        { where: "Banner", message: String((error && error.stack) || error).slice(0, 500), at: Date.now() },
      ]);
    }
    return null;
  }
}

/** Banner 的实际渲染体（单独一个函数，方便上面整块接住异常）。 */
function renderBanner(props, ctxBag) {
  var sessionId = ctxBag.sessionId;
  var session = ctxBag.session;
  var level = ctxBag.level;
  var reading = ctxBag.reading;
  var ratio = ctxBag.ratio;
  var key = ctxBag.key;
  var cfg = ctxBag.cfg;
  var bump = ctxBag.bump;

  var described = guardDescribe(
    {
      kind: "enter",
      level: level,
      ratio: ratio,
      projectedTokens: reading ? reading.projectedTokens : null,
      contextWindow: reading ? reading.contextWindow : null,
      compactionDrop: !!(session && session.state && session.state.compactionDrop),
    },
    { trend: cfg.crossSessionTrend ? store.trend() : undefined, lang: store.locale() },
  );
  var colors = COLORS[level] || COLORS.warn;
  var tr = store.t;

  var close = function (kind) {
    bannerSeen.set(key, { kind: kind, at: Date.now(), level: level, ratio: ratio });
    store.settleTurn(sessionId);
    bump(function (n) {
      return n + 1;
    });
  };

  var buttonStyle = {
    font: "inherit",
    padding: "3px 10px",
    borderRadius: "6px",
    cursor: "pointer",
    border: "1px solid var(--dsh-border, rgba(128,128,128,.4))",
    background: "transparent",
    color: "inherit",
  };

  return react.createElement(
    "div",
    {
      "data-dsh-context-guard": "banner",
      "data-level": level,
      style: {
        display: "flex",
        alignItems: "flex-start",
        gap: "10px",
        margin: "6px 10px",
        padding: "9px 12px",
        borderRadius: "10px",
        border: "1px solid " + colors.dot,
        background: "var(--dsh-surface-secondary, rgba(128,128,128,.07))",
        color: "var(--dsh-text-primary, inherit)",
        fontSize: "12px",
        lineHeight: 1.5,
      },
    },
    react.createElement(
      "div",
      { style: { flex: "1 1 auto", minWidth: 0 } },
      react.createElement(
        "div",
        { style: { fontWeight: 700, color: colors.fg, marginBottom: "2px" } },
        described.title,
      ),
      react.createElement("div", { style: { whiteSpace: "pre-wrap", opacity: 0.92 } }, described.body),
    ),
    react.createElement(
      "div",
      { style: { display: "flex", gap: "6px", flex: "0 0 auto" } },
      react.createElement(
        "button",
        {
          type: "button",
          onClick: function () {
            close("dismissed");
          },
          style: buttonStyle,
        },
        tr("banner.button.dismiss"),
      ),
      react.createElement(
        "button",
        {
          type: "button",
          title: tr("banner.button.hide.title"),
          onClick: function () {
            close("read");
          },
          style: {
            font: "inherit",
            padding: "3px 8px",
            borderRadius: "6px",
            cursor: "pointer",
            border: "none",
            background: "transparent",
            color: "var(--dsh-text-secondary, #6b7280)",
          },
        },
        "×",
      ),
    ),
  );
}

/**
 * 注册两个槽位。
 *
 * ⚠️ 槽位名照 `@deepseek-ai/dsh-client-ui-conversation` 的 `SlotMap` 声明取：
 *   - `conversation.session.header.utilities`（kind=list, scope=session，「右对齐的会话工具，升序」）
 *     ⇒ 拿得到标准席 `useProjection` / `sessionId`，正好做徽标；
 *   - `conversation.input.dock`（kind=list, scope=session，「composer 卡片上方的整宽条目」）
 *     ⇒ 同样拿得到 `useProjection`，正好放 banner。
 *   `shell.overlay` 虽是「一次性通知」的官方式席位，但它是 **root** scope ⇒ **没有 `useProjection`**，
 *   要用它就得自己搭一层跨半边 observable。本 MVP 不搭那层，改用会话内席位。
 *
 * `register({inject})` 是**返回业务面对象的工厂**，不是服务名数组 —— 本插件不需要注入面，
 * 所以整个 `inject` 键都不写。
 */
function apply(ctx) {
  var disposers = [];
  var calls = [];

  /** 宽松传递：手写 JS bundle 里组件签名是宽类型，用恒等函数把它交给 `register` 的泛型位（照 damage-pulse 的 `registerErased` 做法）。 */
  function erased(component) {
    return component;
  }

  function register(slotName, order, id, component) {
    calls.push({ slot: slotName, id: id, at: Date.now() });
    var handle = ctx.slots.inject(slotName, function () {
      calls.push({ slot: slotName, id: id, mounted: true, at: Date.now() });
      return ctx.slots.register(
        { name: slotName, id: "context-guard:" + id, order: order },
        erased(component),
      );
    });
    disposers.push(handle);
  }

  ctx.effect(function () {
    register("conversation.session.header.utilities", 30, "badge", Badge);
    register("conversation.input.dock", 25, "banner", Banner);
    ctx.logger && ctx.logger.info && ctx.logger.info(store.t("client.log.registered"));
    return function () {
      for (var i = 0; i < disposers.length; i += 1) {
        try {
          if (typeof disposers[i] === "function") disposers[i]();
        } catch (error) {
          /* 卸载路径不抛 */
        }
      }
      disposers.length = 0;
    };
  }, "context-guard: slots");

  // 宿主真源：**先渲染、后到货**（不 await —— 槽位注册不能被一次网络读挡住）。
  var hostSyncPromise = syncFromHost();
  hostSyncPromise.then(function (result) {
    if (ctx.logger && ctx.logger.info) {
      ctx.logger.info(
        result.status === "ok"
          ? store.t("client.log.host.adopted", {
              keys: hostSync.keys,
              warn: store.config().warnRatio,
              hard: store.config().hardRatio,
            })
          : store.t("client.log.host.failed", { status: result.status, error: hostSync.error || "" }),
      );
    }
  });

  // 排障/调档把手：验证脚本与操作者都能在 Console 里
  // 一眼看到「注册了几次、挂上几次、当前读数」，并实时改档位。
  // 只读快照 + 一个 override 入口，不参与任何隐式判定。
  try {
    if (typeof window !== "undefined") {
      var existing = window.__DSH_CONTEXT_GUARD__ || {};
      existing.plugin = "dsh-context-guard";
      existing.calls = calls;
      existing.store = store;
      existing.hasSlots = !!(ctx && ctx.slots);
      // ⚠️ 这两个只服务于**本机验收脚本**（在真机上就地试挂一个席位）。
      //    它们不提升任何权限 —— 这段代码本来就跑在 DSH Web 页面里，页面内任何脚本都已持有同等能力 ——
      //    但若你不需要那条验收链路，删掉下面两行即可（`tools/verify-client.mjs` 第 3c 项会随之失效）。
      existing.ctx = ctx;
      existing.react = react;
      existing.Badge = Badge;
      existing.Banner = Banner;
      // ⚠️ `config` 必须是**活的**：宿主设置是 `apply()` 之后才到货的，拍一张快照会骗人
      //    （第一版就是快照，于是「逃生阀 0.01 生效」与「宿主 0.33 生效」看起来一样，
      //     连验收脚本都被它骗过一轮）。用 getter，顺带让 Console 里看到的永远是当前档位。
      Object.defineProperty(existing, "config", {
        configurable: true,
        enumerable: true,
        get: function () {
          return store.config();
        },
      });
      existing.override = function (next) {
        return store.setConfig(next || {});
      };
      // 宿主真源的观测面：`hostSync()` 给当前状态，`hostConfig()` 给真源值，
      // `refreshFromHost()` 手动重读（设置改完之后不必刷新页面）。
      existing.hostSync = function () {
        return hostSync;
      };
      existing.hostConfig = function () {
        return store.hostConfig();
      };
      existing.syncFromHost = syncFromHost;
      existing.refreshFromHost = function () {
        return syncFromHost();
      };
      existing.hostSyncReady = hostSyncPromise;
      // 固定住这个全局：**可读、可调档，但不能被整体替换**（防止页面里别的脚本把把手换成假的）。
      // 逃生阀仍走 `override()`，或在加载前用 `addInitScript` 预置 —— 两条路都不受影响。
      Object.defineProperty(window, "__DSH_CONTEXT_GUARD__", {
        value: existing,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    }
  } catch (error) {
    /* 排障把手失败不影响功能 */
  }

  return { store: store, Badge: Badge, Banner: Banner, config: store.config(), calls: calls };
}
