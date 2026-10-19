/**
 * dsh-context-guard · client 半边 UI（被 `scripts/build-client.mjs` 内联进 client.js）
 *
 * 这一半只做两件事（§10.2 第 4 条「宿主算数、UI 说话」的 UI 侧）：
 *   1. 会话头徽标：占用率 + 宿主判定的档位，**只显示、不出声**；
 *   2. 跨越档位时一次性 banner：占比 + 下一步动作 + 指向 `HANDOVER.md`（§10.6）。
 *
 * ⛔ 不注入 prompt、不注册 model-facing 工具、不发额外请求 ⇒ 上下文税 0。
 *
 * ⛔⛔ **本半边没有判定逻辑**（v0.4.3，复审报告 §2 建议 #1）：
 *   档位 / 武装 / 轮次 / 冷却 / 占用率一律来自宿主注册的 `wire` 投影
 *   （`useProjection("contextGuard")`，见 `lib/index.js` 与 `lib/engine.mjs`）。
 *   历史形状是「客户端自带一套状态机 + 一次 `fetch(/api/context-guard/state)` 抄宿主阈值」，
 *   于是有两套冷却、两套迟滞，`settleTurn` 还挂在 banner 按钮上（点一下就能在客户端推进轮次）。
 *   现在判定状态机**已搬出 `policy.mjs`**（它只住在 `lib/engine.mjs`，不进这个 bundle），
 *   所以「客户端没有判定逻辑」是结构性事实，而不是靠自觉。
 *
 * 语言：`pickLocale(逃生阀 locale, navigator.language)`，兜底 `zh`。
 * 文案仍来自 `lib/i18n.mjs`（与宿主同一份、逐字内联），措辞与判定分离 —— 这就是内联的
 * **必要最小集合**：文案表 + `readOccupancy`（把 contextPressure 归一成读数）+ `describe`。
 */
var guardLocale = pickLocale(
  (typeof window !== "undefined" && window.__DSH_CONTEXT_GUARD__ && window.__DSH_CONTEXT_GUARD__.config
    ? window.__DSH_CONTEXT_GUARD__.config.locale
    : undefined) ?? "auto",
  { navigatorLanguage: typeof navigator !== "undefined" ? navigator.language : undefined },
);

/** 查表函数：组件渲染统一走它，避免半句中文半句英文。 */
var guardT = makeT(guardLocale);

/**
 * 排障面（**只读**）：每个会话最近一次读到的宿主投影。给 `__DSH_CONTEXT_GUARD__.store.dump()`
 * 与验收脚本看 —— 它记录的是**宿主说了什么**，不是客户端算了什么（客户端不再算）。
 */
var lastViews = {};

/**
 * 保留这个名字（而不是干脆删掉）是为了让验收脚本的 `store.dump()/locale()/config()` 还能读出
 * 「浏览器现在看到什么」。⚠️ 它**没有** `setConfig` / `hostConfig` / `settleTurn` 了：
 * 客户端不再拥有任何判定状态，也就没有能改判定的入口（这正是要消灭的那类漂移）。
 */
var store = {
  locale: function () {
    return guardLocale;
  },
  t: function (key, vars) {
    return guardT(key, vars);
  },
  config: function () {
    return { source: "projection", locale: guardLocale };
  },
  dump: function () {
    return lastViews;
  },
};

/** 记一条排障记录（引用相同就跳过，避免每次渲染都写）。 */
function noteView(sessionId, view) {
  if (sessionId === null || !view) return;
  if (lastViews[sessionId] === view) return;
  lastViews[sessionId] = {
    level: view.level,
    armed: view.armed === true,
    turn: view.turn,
    cooldown: view.cooldown,
    ratio: view.ratio === undefined ? null : view.ratio,
  };
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

/**
 * 宿主判定（v0.4.3）：`useProjection("contextGuard")` —— 档位/武装/轮次/冷却/占用率的**唯一真源**。
 *
 * 为什么不再自算：复审报告 §2 #1。客户端那套状态机与宿主那套只靠「一次 fetch 抄一份阈值」
 * 对齐，于是两套冷却、两套迟滞，`settleTurn` 还挂在按钮上（点一下就能在客户端推进轮次）。
 * 现在宿主把判定注册成 `wire` 投影（`lib/index.js` 的 `sessionProjections.register`），
 * 这里只是**读**：`{ level, armed, turn, cooldown, ratio }`，小、扁平、纯 JSON。
 *
 * `undefined` ⇒ 通道缺席（旧宿主 / 未装 token-meter / 注册失败）。此时**没有档位**：
 * 徽标仍然显示 `contextPressure` 的占用率，但不出 banner。
 * ⚠️ 这里刻意**不**退回本地判定 —— 「缺席就自己算一份」正是 P1-5 那类漂移的出生地；
 * 宁可不提示，也不要两套判定各说各话（一句提示的档位不值得为此重新引入第二套状态机）。
 */
function guardView(props) {
  var view = safeProjection(props, "contextGuard");
  return view && typeof view === "object" ? view : null;
}

function sessionIdOf(props) {
  var id = props && (props.sessionId !== undefined ? props.sessionId : props.session && props.session.id);
  return id === undefined || id === null || id === "" ? null : String(id);
}

/**
 * v0.6.10：用**客户端自己那份实时读数**重算压缩点。
 *
 * 为什么：宿主缓存的窗口可能落后（真机：宿主 1,048,576 / 客户端 1,000,000，压缩点偏 ~1.5pp）。
 * 参数（ratio / headroom / 预留）仍由宿主下发 —— 客户端只做一次纯算术，不做任何判定。
 * 任何一项缺失就返回 null，调用方回落到宿主算好的 `compactPercent`。
 */
function liveCompactPercent(reading, view) {
  if (!reading || reading.known !== true) return null;
  if (!view) return null;
  var r = view.compactRatio;
  var headroom = view.compactHeadroom;
  var reserve = view.compactReserve;
  var w = reading.contextWindow;
  if (typeof r !== "number" || typeof headroom !== "number" || typeof reserve !== "number") return null;
  if (typeof w !== "number" || !isFinite(w) || w <= 0) return null;
  var threshold = Math.floor(Math.min(w * r, w - reserve - headroom));
  if (!isFinite(threshold) || threshold <= 0) return null;
  return Math.round((threshold / w) * 1000) / 10;
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
  var view = guardView(props);
  noteView(sessionId, view);

  // `readOccupancy` 只是把官方投影归一成「可信/不可信 + 比率」（纯函数，不碰状态机），
  // 用它显示 `≈120K / 200K` 这种人类可读的分母/分子。
  var reading = readOccupancy(pressure);
  var badge = badgeText(reading);
  // 显示档位：宿主给了就听宿主的；宿主还停在 `none` 而官方读数已过线时兜底
  // （v0.4.6：「恢复的会话在页面加载那一刻没有事件驱动」的显示侧修正，见 `displayLevel`）。
  var level = displayLevel(view, reading);
  var colors = COLORS[level] || COLORS.none;
  // 百分比优先用宿主的 ratio：否则会出现「档位说 hard、徽标说 44%」这种自相矛盾。
  var ratioValue = view && typeof view.ratio === "number" ? view.ratio : reading.known ? reading.ratio : null;
  var ratio = ratioValue === null ? 0 : Math.max(0, Math.min(1, ratioValue));
  var hasData = badge.known || ratioValue !== null;
  var percent = Math.round((ratioValue === null ? 0 : ratioValue) * 100);
  // 宿主投影有 ratio、而 contextPressure 那一半还没到货时，仍然要显示真数字（绝不假装 0%）。
  if (!badge.known && ratioValue !== null) badge = { text: "ctx " + percent + "%", known: true };

  var tr = store.t;
  // v0.6.2：压缩点三态 + 环境指纹（只进 tooltip；徽标正面只表示「当前占用」）
  // v0.6.10：优先用**实时读数**重算（宿主缓存的窗口可能落后），缺参数才回落宿主值。
  var livePercent = liveCompactPercent(reading, view);
  var compactPercent = livePercent !== null ? livePercent : view && typeof view.compactPercent === "number" ? view.compactPercent : null;
  var compactLine = "";
  var envLine = "";
  if (view) {
    if (view.compactBasis === "config" && typeof compactPercent === "number") {
      compactLine = tr("badge.title.compact.exact", { percent: compactPercent.toFixed(1) });
    } else if (view.compactBasis === "default" && typeof compactPercent === "number") {
      compactLine = tr("badge.title.compact.estimated", { percent: compactPercent.toFixed(1) });
    } else if (view.compactBasis === "off") {
      compactLine = tr("badge.title.compact.off");
    } else {
      var why = !reading.known
        ? "noWindow"
        : view.modelTag === null || view.modelTag === undefined
          ? "noRoute"
          : "noReserve";
      compactLine = tr("badge.title.compact.unknown", { reason: tr("badge.title.compact.reason." + why) });
    }
    if (typeof view.modelTag === "string") {
      envLine = tr("badge.title.env", { model: view.modelTag, preset: typeof view.presetTag === "string" ? view.presetTag : "" });
    }
  }
  var title;
  if (hasData) {
    title =
      tr("badge.title.context", {
        projected: kTokens(reading.projectedTokens),
        window: kTokens(reading.contextWindow),
        percent: percent,
      }) +
      (view ? "\n" + tr("badge.title.host", { turn: view.turn, cooldown: view.cooldown }) : "") +
      (compactLine === "" ? "" : "\n" + compactLine) +
      (envLine === "" ? "" : "\n" + envLine) +
      "\n" +
      tr("badge.title.source.label") +
      (view ? tr("badge.title.source.projection") : tr("badge.title.source.absent")) +
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

/**
 * 本会话**已经出过声的档位**（v0.4.7，真机反馈：压缩把水位压到 20% 之后 banner 整个消失，
 * 而上面那块「①/② 可复制交接」正在被用 —— 一次压缩把用户正在用的面板带走了）。
 *
 * 规矩：出过声就**留着**，只有「知道了 / ×」才关；档位掉回 `none` 时不消失，降级成
 * 「已回落到 X%（压缩救了一次）」那条说明（见 `renderBanner` 的 `compacted` 分支）。
 * 这里只记「显示过」，不参与任何判定 —— 档位仍然只由宿主投影/官方读数给。
 * @type {Map<string, {level: string, ratio: number}>}
 */
var bannerFired = new Map();
var BANNER_FIRED_MAX = 200;

/**
 * 手动「写好交接」的两块支撑：复制到剪贴板、把宿主返回的 reason 翻成人话。
 *
 * 复制优先 Clipboard API、失败退 `execCommand`：Web GUI 是 `http://127.0.0.1`（安全上下文），
 * 正常路径可用；但别只押一条 —— 某些内嵌环境会禁掉 `navigator.clipboard`。
 */
function fallbackCopy(text) {
  try {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok === true;
  } catch (error) {
    return false;
  }
}

function copyText(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return fallbackCopy(text);
        },
      );
    }
  } catch (error) {
    /* 落到兜底 */
  }
  return Promise.resolve(fallbackCopy(text));
}

/** reason 是机器词（disabled / no-path / …）；未知词兜到 exception，绝不把 key 甩给用户看。 */
function draftReason(t, reason) {
  var key = "banner.draft.reason." + (reason || "exception");
  var text = t(key);
  return text === key ? t("banner.draft.reason.exception") : text;
}

function Banner(props) {
  var sessionId = sessionIdOf(props);
  var pressure = safeProjection(props, "contextPressure");
  var view = guardView(props);
  noteView(sessionId, view);

  var bumpPair = react.useState(0);
  var bump = bumpPair[1];
  // 手动起草的状态机：idle → pending → done（可复制）/ error。
  // ⚠️ 必须在下面那个 `if (!visible) return null` **之前**调用 —— 否则 hook 顺序会随可见性变化。
  var draftPair = react.useState({ status: "idle", doc: "", message: "" });
  var draft = draftPair[0];
  var setDraft = draftPair[1];
  var copiedPair = react.useState("");
  var copied = copiedPair[0];
  var setCopied = copiedPair[1];
  // 档位与冷却一律来自宿主投影（客户端没有第二套判定，见 `guardView`）。
  // v0.4.6：宿主还停在 `none`、而官方 `contextPressure` 已过线时，按**宿主下发的阈值**兜底显示
  // —— 恢复出来的历史会话在页面加载那一刻没有事件驱动，这是「启动基线」缺口（§37.4/§37.5）。
  var reading = readOccupancy(pressure);
  var level = displayLevel(view, reading);
  var ratio = view && typeof view.ratio === "number" ? view.ratio : reading.known ? reading.ratio : 0;
  /**
   * v0.4.7：**出过声就不消失**。压缩会把水位压下阈值（`displayLevel` 回 `none`），
   * 而 banner 里正摆着「①/② 可复制交接」—— 面板不能因为一次压缩就跟着蒸发。
   * 所以显示档位取「当前档位，掉回 none 时沿用出过声的那一档」，并把它记进 `bannerFired`。
   */
  var fired = sessionId !== null ? bannerFired.get(sessionId) : undefined;
  // v0.6.3：只有 hard 会出声；45% 的 warn 只静默起草（见 lib/policy.mjs 的 shownBannerLevel）。
  var shownLevel = shownBannerLevel(level, fired ? fired.level : "none");
  var compacted = level === "none" && fired !== undefined;
  if (sessionId !== null && level === "hard" && (fired === undefined || fired.level !== "hard")) {
    if (bannerFired.size > BANNER_FIRED_MAX) bannerFired.clear();
    bannerFired.set(sessionId, { level: level, ratio: ratio });
  }
  var key = sessionId !== null ? sessionId + "|" + shownLevel : null;
  var seen = key !== null ? bannerSeen.get(key) : undefined;
  /**
   * 只在「本会话这一档位还没出过声」时才显示。
   * ⚠️ 不再有 `cfg.enabled` 这一项：总开关由**宿主**执行（关掉后宿主压根不会武装、不会给档位），
   * 客户端再判一次就是第二套语义。客户端只剩「同一档位只响一次」这条**纯 UI** 记忆。
   */
  var visible = shownLevel !== "none" && key !== null && seen === undefined;

  if (!visible) return null;

  try {
    return renderBanner(props, {
      sessionId: sessionId,
      level: shownLevel,
      compacted: compacted,
      // v0.5.0（P1）：压缩回执只在「宿主真的写了账本行」时才有值（三个 null 表示没有）。
      receipt:
        view && typeof view.receiptPercent === "number" && typeof view.receiptRow === "number"
          ? { percent: view.receiptPercent, row: view.receiptRow }
          : null,
      // v0.6.1：宿主按 DSH 公式推算的「自动压缩点」（百分比）；未知就是 null。
      // v0.6.10：先用客户端实时读数重算（宿主缓存的窗口可能落后），缺参数才回落到宿主值。
      compactPercent:
        liveCompactPercent(reading, view) !== null
          ? liveCompactPercent(reading, view)
          : view && typeof view.compactPercent === "number"
            ? view.compactPercent
            : null,
      // v0.6.2：这个数字凭什么 —— config（精确）/ default（推算）/ off（不压）/ none（算不出）
      compactBasis: view && typeof view.compactBasis === "string" ? view.compactBasis : "none",
      reading: reading,
      ratio: ratio,
      key: key,
      bump: bump,
      draft: draft,
      setDraft: setDraft,
      copied: copied,
      setCopied: setCopied,
    });
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
  var level = ctxBag.level;
  var reading = ctxBag.reading;
  var ratio = ctxBag.ratio;
  var key = ctxBag.key;
  var bump = ctxBag.bump;
  var draftView = ctxBag.draft || { status: "idle", doc: "", message: "" };
  var setDraft = ctxBag.setDraft;
  var copied = ctxBag.copied === true;
  var setCopied = ctxBag.setCopied;

  var tr = store.t;
  var described = ctxBag.compacted === true
    ? {
        title: tr("banner.title.compacted", { percent: Math.round(ratio * 100) }),
        body: tr("banner.body.compacted", {}),
      }
    : guardDescribe(
        {
          kind: "enter",
          level: level,
          ratio: ratio,
          projectedTokens: reading ? reading.projectedTokens : null,
          contextWindow: reading ? reading.contextWindow : null,
          // `compactionDrop` 与跨会话趋势都是**宿主**的面（不进 wire 载荷，见 lib/engine.mjs 的
          // 镜像注释）：正文里那两句解释性话现在只出现在宿主日志里。
          compactionDrop: false,
          // v0.6.1：自动压缩点（宿主按 DSH 公式推算；未知则不写数字）
          compactPercent: typeof ctxBag.compactPercent === "number" ? ctxBag.compactPercent : undefined,
          // v0.6.2：config ⇒ 精确措辞；default ⇒ 带「约/推算」；off ⇒ 换整段正文；none ⇒ 不写数字
          compactBasis: ctxBag.compactBasis,
        },
        { lang: store.locale() },
      );
  var colors = ctxBag.compacted === true ? COLORS.none : COLORS[level] || COLORS.warn;
  var receipt = ctxBag.receipt || null;

  var close = function (kind) {
    /**
     * ⚠️ v0.4.3：这里原来还有一句 `store.settleTurn(sessionId)` —— 那是「点按钮就在客户端推进一轮、
     * 衰减一次冷却」的入口（P1-5 的一半：UI 动作能改变判定状态）。现在轮次与冷却**只**由宿主的
     * `turn/end` 推进，客户端关掉 banner 就只是关掉它。
     */
    bannerSeen.set(key, { kind: kind, at: Date.now(), level: level, ratio: ratio });
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

  // —— 手动起草（第二个选择）：点下去让宿主**立刻**写一次，然后把可复制的开场文本摆出来。
  //    与「知道了」的分工：后者纯关闭、无附带动作；前者产生一个文件 + 一段文本。
  var draftText = tr("banner.draft.text", { doc: draftView.doc || "HANDOVER.md" });
  var draftBusy = draftView.status === "pending";

  var startDraft = function () {
    if (draftBusy || typeof setDraft !== "function") return;
    setDraft({ status: "pending", doc: "", message: "" });
    var url = DRAFT_ROUTE + "?sessionId=" + encodeURIComponent(String(sessionId));
    fetch(url, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (data && data.ok === true && data.doc) {
          setDraft({ status: "done", doc: String(data.doc), message: "", todoFilled: data.todoFilled === true });
        } else {
          setDraft({ status: "error", doc: "", message: draftReason(tr, data && data.reason) });
        }
      })
      .catch(function () {
        setDraft({ status: "error", doc: "", message: draftReason(tr, "network") });
      });
  };

  // v0.4.0：两段可复制文本 —— ① 贴**回本会话**让旧 agent 写结论（它有完整上下文）
  //         ② 贴到**新会话**开场。顺序固定：先补结论，再开新会话，保真最好。
  var step1Text = tr("banner.draft.step1.text", { doc: draftView.doc || "HANDOVER.md" });

  var doCopy = function (text, tag) {
    if (typeof setCopied !== "function") return;
    copyText(text).then(function (ok) {
      setCopied(ok === true ? tag : "");
    });
  };

  var codeStyle = {
    display: "block",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    background: "rgba(128,128,128,.12)",
    padding: "4px 6px",
    borderRadius: "5px",
    marginTop: "2px",
  };
  var stepTitleStyle = { opacity: 0.85, marginTop: "6px" };
  var smallButtonStyle = Object.assign({}, buttonStyle, { marginTop: "3px" });

  var draftPanel =
    draftView.status === "done"
      ? react.createElement(
          "div",
          {
            "data-dsh-context-guard": "draft",
            style: { marginTop: "6px", paddingTop: "6px", borderTop: "1px dashed " + colors.dot },
          },
          react.createElement(
            "div",
            { style: { opacity: 0.85, marginBottom: "2px" } },
            tr("banner.draft.done", { doc: draftView.doc }) +
              " · " +
              (draftView.todoFilled === true ? tr("banner.draft.todo.filled") : tr("banner.draft.todo.empty")),
          ),
          react.createElement("div", { style: stepTitleStyle }, tr("banner.draft.step1.title")),
          react.createElement("code", { style: codeStyle }, step1Text),
          react.createElement(
            "button",
            { type: "button", onClick: function () { doCopy(step1Text, "1"); }, style: smallButtonStyle },
            copied === "1" ? tr("banner.draft.copied") : tr("banner.draft.copy"),
          ),
          react.createElement("div", { style: stepTitleStyle }, tr("banner.draft.step2.title")),
          react.createElement("code", { style: codeStyle }, draftText),
          react.createElement(
            "button",
            { type: "button", onClick: function () { doCopy(draftText, "2"); }, style: smallButtonStyle },
            copied === "2" ? tr("banner.draft.copied") : tr("banner.draft.copy"),
          ),
        )
      : draftView.status === "error"
        ? react.createElement(
            "div",
            { "data-dsh-context-guard": "draft-error", style: { marginTop: "4px", opacity: 0.9 } },
            tr("banner.draft.failed", { reason: draftView.message }),
          )
        : null;

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
      // v0.5.0（P1）：压缩回执 —— 只对「刚刚压缩过」的降级态显示，数据来自宿主账本的最后一行。
      receipt && ctxBag.compacted === true
        ? react.createElement(
            "div",
            { "data-dsh-context-guard": "receipt", style: { marginTop: "3px", opacity: 0.85 } },
            tr("banner.receipt", {
              pre: receipt.percent.toFixed(1),
              n: receipt.row,
              post: Math.round(ratio * 100),
            }),
          )
        : null,
      draftPanel,
    ),
    react.createElement(
      "div",
      { style: { display: "flex", gap: "6px", flex: "0 0 auto" } },
      react.createElement(
        "button",
        {
          type: "button",
          onClick: startDraft,
          disabled: draftBusy,
          title: tr("banner.draft.tip"),
          "data-dsh-context-guard": "draft-button",
          style: draftBusy ? Object.assign({}, buttonStyle, { opacity: 0.6, cursor: "default" }) : buttonStyle,
        },
        draftBusy ? tr("banner.draft.pending") : tr("banner.button.draft"),
      ),
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

  // v0.4.3：这里原来有一次 `syncFromHost()`（`GET STATE_ROUTE` 抄宿主阈值）。
  // 现在浏览器半边不需要阈值了 —— 档位/冷却由宿主投影直接给（见 `guardView`），
  // 于是页面加载时**一个请求都不发**（上下文税/网络税都回到 0）。`/state` 路由仍在，
  // 但那是**只读调试镜像**（`curl` 用），不是这条 UI 的数据通路。

  // 排障把手：验证脚本与操作者都能在 Console 里一眼看到「注册了几次、挂上几次、
  // 宿主说了什么档位」。**只读**：v0.4.3 起没有 `override()` / `hostConfig()` / `syncFromHost()`
  // 了 —— 客户端不再拥有任何判定状态，也就没有能改判定的入口（那正是要消灭的漂移）。
  try {
    if (typeof window !== "undefined") {
      var existing = window.__DSH_CONTEXT_GUARD__ || {};
      existing.plugin = "dsh-context-guard";
      existing.calls = calls;
      existing.store = store;
      existing.hasSlots = !!(ctx && ctx.slots);
      // ⚠️ 这两个只服务于**本机验收脚本**（在真机上就地试挂一个席位）。
      //    它们不提升任何权限 —— 这段代码本来就跑在 DSH Web 页面里，页面内任何脚本都已持有同等能力。
      existing.ctx = ctx;
      existing.react = react;
      existing.Badge = Badge;
      existing.Banner = Banner;
      // `config` 是**活的** getter（Console 里看到的永远是当前值）：现在它只报
      // 「值从哪来 + 本半边的语言」，不再报阈值 —— 阈值只有宿主知道。
      Object.defineProperty(existing, "config", {
        configurable: true,
        enumerable: true,
        get: function () {
          return store.config();
        },
      });
      // 宿主判定的观测面：`viewOf(sessionId)` 给最近一次读到的投影值（排障用）。
      existing.viewOf = function (sessionId) {
        return sessionId === undefined ? store.dump() : store.dump()[String(sessionId)] ?? null;
      };
      // 固定住这个全局：可读，但不能被整体替换（防止页面里别的脚本把把手换成假的）。
      // 语言逃生阀仍可在加载前用 `addInitScript` 预置 `{ config: { locale: 'en' } }`。
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
