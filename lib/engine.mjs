/**
 * 判定引擎（2026-10-17 从 `index.js` 抽出）。
 *
 * 为什么抽出来：`index.js` 顶层 `import Schema from '@deepseek-ai/schemastery'` —— 那是**宿主提供的依赖**，
 * 而 CI 的 `ci.yml` 刻意**不跑 npm install**（「测试本身也不需要任何依赖」）。
 * 引擎只依赖 `policy.mjs`，单独成模块后 `test/engine.test.mjs` 在无依赖的 CI 里也能 import。
 *
 * ⚠️ 本模块**不得** import 任何 `@deepseek-ai/*`（否则 CI 会再次红）。
 */
import {
  describe as describeSignal,
  defaultConfig,
  readOccupancy,
} from './policy.mjs';

/**
 * ————————————————————————————————————————————————————————————————————————————
 * wire 投影（v0.4.3，复审报告 §2 建议 #1）
 * ————————————————————————————————————————————————————————————————————————————
 *
 * 为什么要有它：此前浏览器半边**自带一套状态机**（阈值、迟滞、冷却、`settleTurn` 全在客户端），
 * 与宿主那套只靠「一次 `fetch(STATE_ROUTE)` 抄一份阈值」对齐 ⇒ P1-5 那一整类漂移
 * （两边各算一套冷却、点按钮还能在客户端推进轮次）。
 *
 * 现在宿主把**已经算好的判定结果**注册成一个 `wire` 投影：客户端 `useProjection('contextGuard')`
 * 直接读 `level / armed / turn / cooldown / ratio`，不再自己判定。通道事实（已核实，见复审报告 §3）：
 *   · `sessionProjections.register({key, stateVersion, stateSchema, init, apply, wire:{viewSchema, view}})`
 *     接受**任意 key**（`<DSH>/dsh-session-projection/lib/index.js:68-103`）；
 *   · `snapshot(session)` 不带 `keys` 时返回**所有**带 `wire` 的单元（同文件 `142-156`）；
 *   · 会话控制器无白名单地全量广播（`<DSH>/dsh-api-session-controller/lib/index.js:1175-1184`）；
 *   · 客户端是**键寻址表**，`useProjection(key)` 直接解析（`…/dsh-api-session-controller/lib/types/
 *     client/sessions/projection-store.js:29-40`，缺席读 `undefined`）。
 *
 * 这个单元**不是第二套判定**：状态只有一个真源（就是下面 `states` 那个 Map），
 * `mirrorApply` 只把宿主当前判定**镜像**成扁平 JSON，`mirrorView` 再从中裁出 wire 字段。
 * 于是不会出现「两边各算一套」——这正是不漂移的机制，而不是靠约定。
 *
 * 「值变才变」怎么保证（这是注册表广播的唯一判据）：
 *   · `apply` 在镜像值没变时**返回同一个 state 引用**（注册表 `drive()` 用 `Object.is` 判定，
 *     同引用 ⇒ 根本不会调 `view`，更不会广播，见 `<DSH>/dsh-session-projection/lib/index.js:410-426`）；
 *   · `view` 用 WeakMap 按 state 引用缓存，同一 state ⇒ 同一 view 引用。
 * ⚠️ 因此 `viewSchema.parse` 必须是**恒等**的（合法时原样返回入参）—— zod 的 `parse` 会重建对象，
 * 那会把引用稳定性毁掉。这里是自己写的极小校验器（不引新依赖），合法时返回原对象。
 */
export const MIRROR_KEY = 'contextGuard';
/** 状态版本从 0 起：本单元是 v0.4.3 才出现的，没有历史形状要兼容。 */
export const MIRROR_STATE_VERSION = 0;
const MIRROR_LEVELS = ['none', 'warn', 'hard'];
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** 会话头 → 会话 id（`init` **只**允许依赖会话头，见 §2 #1）。 */
function idOfHeader(header) {
  const raw = header?.id ?? header?.sessionId;
  if (raw === undefined || raw === null) return '';
  return String(raw);
}

/**
 * 镜像状态的极小校验器：合法就**原样返回**（保引用），不合法就重建成规范对象并夹取。
 * 契约里只有 `.parse()` 被宿主用到（`restore` / `viewCheckpoint` / `drive`）。
 */
export function mirrorStateSchema() {
  return {
    parse(value) {
      const v = value !== null && typeof value === 'object' ? value : {};
      const out = {
        id: typeof v.id === 'string' ? v.id : '',
        level: MIRROR_LEVELS.includes(v.level) ? v.level : 'none',
        armed: v.armed === true,
        turn: isFiniteNumber(v.turn) ? Math.max(0, Math.trunc(v.turn)) : 0,
        cooldown: isFiniteNumber(v.cooldown) ? Math.max(0, Math.trunc(v.cooldown)) : 0,
        ratio: isFiniteNumber(v.ratio) ? Math.min(1, Math.max(0, v.ratio)) : null,
      };
      return sameMirror(v, out) && v.id === out.id ? value : out;
    },
  };
}

/** wire 视图的极小校验器：同样**合法即原样返回**（见上面对引用稳定性的说明）。 */
export function mirrorViewSchema() {
  return {
    parse(value) {
      const v = value !== null && typeof value === 'object' ? value : {};
      const out = {
        level: MIRROR_LEVELS.includes(v.level) ? v.level : 'none',
        armed: v.armed === true,
        turn: isFiniteNumber(v.turn) ? Math.max(0, Math.trunc(v.turn)) : 0,
        cooldown: isFiniteNumber(v.cooldown) ? Math.max(0, Math.trunc(v.cooldown)) : 0,
        ratio: isFiniteNumber(v.ratio) ? Math.min(1, Math.max(0, v.ratio)) : null,
        warnRatio: isFiniteNumber(v.warnRatio) ? Math.min(1, Math.max(0, v.warnRatio)) : null,
        hardRatio: isFiniteNumber(v.hardRatio) ? Math.min(1, Math.max(0, v.hardRatio)) : null,
        enabled: v.enabled !== false,
        receiptPercent: isFiniteNumber(v.receiptPercent) ? Math.min(100, Math.max(0, v.receiptPercent)) : null,
        receiptRow: isFiniteNumber(v.receiptRow) ? Math.max(0, Math.trunc(v.receiptRow)) : null,
        receiptAt: isFiniteNumber(v.receiptAt) ? Math.max(0, Math.trunc(v.receiptAt)) : null,
        compactPercent: isFiniteNumber(v.compactPercent) ? Math.min(100, Math.max(0, v.compactPercent)) : null,
        compactBasis: ['config', 'default', 'off', 'none'].includes(v.compactBasis) ? v.compactBasis : 'none',
        modelTag: typeof v.modelTag === 'string' && v.modelTag !== '' ? v.modelTag.slice(0, 120) : null,
        presetTag: typeof v.presetTag === 'string' && v.presetTag !== '' ? v.presetTag.slice(0, 120) : null,
      };
      return sameView(v, out) ? value : out;
    },
  };
}

/** 镜像字段的逐一比较（**不看 `id`**：它是常量，不参与「值变才变」的判定）。 */
function sameMirror(a, b) {
  return (
    a.level === b.level &&
    a.armed === b.armed &&
    a.turn === b.turn &&
    a.cooldown === b.cooldown &&
    a.ratio === b.ratio
  );
}

/**
 * wire 视图的比较：镜像五字段 + **随投影下发的阈值三字段**（v0.4.6）。
 * 阈值变了也是「值变了」：下一次 `drive` 会广播，客户端的显示档位随之重算。
 */
function sameView(a, b) {
  return (
    sameMirror(a, b) &&
    a.warnRatio === b.warnRatio &&
    a.hardRatio === b.hardRatio &&
    a.enabled === b.enabled &&
    a.receiptPercent === b.receiptPercent &&
    a.receiptRow === b.receiptRow &&
    a.receiptAt === b.receiptAt &&
    a.compactPercent === b.compactPercent &&
    a.compactBasis === b.compactBasis &&
    a.modelTag === b.modelTag &&
    a.presetTag === b.presetTag
  );
}

/**
 * ————————————————————————————————————————————————————————————————————————————
 * 判定状态机：对**判定事件**的纯折叠（v0.4.3 从 `policy.mjs` 搬来）
 * ————————————————————————————————————————————————————————————————————————————
 *
 * 为什么搬到这里（复审报告 §2 建议 #6 的直接后果）：`policy.mjs` 是**两半边共用**、
 * 会被 `scripts/build-client.mjs` 逐字内联进浏览器 bundle 的那份代码。状态机住在里面，
 * 浏览器半边就永远「有一套可用的判定逻辑」——即便没人调用它，也迟早有人再调一次
 * （P1-5 那类漂移的入口）。搬到 `engine.mjs`（只被宿主引用，**不进** client bundle）之后，
 * 「客户端没有判定逻辑」变成**结构性事实**，不再靠自觉。
 *
 * 形状对齐投影单元的 `init + apply(state, event)`：一条事件进、一个新状态出，
 * 不改任何外部 Map、不打日志、不读时钟。于是同一串事件重放得到同一个状态 ——
 * 出了问题可以把事件日志抄下来离线复现。
 */

/** 初始状态：一档都没武装（armed=false 表示还没进过 warn）。 */
export function initialState() {
  return {
    level: 'none',
    armed: false,
    turn: 0,
    cooldown: 0,
    compactionDrop: false,
    occupancy: null,
    /**
     * 「刚压过一次」的一次性标记。v0.4.3 起它**住在状态里**（原先在 `lib/index.js` 的一个
     * `Map` 里）：这样它就是事件日志的产物（`compaction/end` 置位、下一次观测消费），
     * 而不是宿主半边另一份需要同步的簿记。
     */
    pendingCompaction: false,
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
 */
export function reduce(state, reading, options = {}) {
  const next = { ...state };
  if (!reading || reading.known !== true || reading.ratio === null) {
    // fail-closed：无分母不动状态机，也不清除既有档位（清除要靠 nextTurn 或回落观测）。
    return { state: next, signal: null };
  }

  const cfg = options.config ?? defaultConfig();
  const ratio = reading.ratio;
  /**
   * P1-4：迟滞的上限必须压到 `warnRatio` 的一半。
   *
   * 若不压：`warnRatio <= hysteresisRatio` 时 `rearmBelow` 会被 `max(0, …)` 夹成 **0**，
   * 而占用率永远 > 0 ⇒ 一旦武装就**永不解除**（`armed` 恒 true，再也收不到下一次 `enter`，
   * 徽标也永远停在那个档位）。`warnRatio` 的 schema 下限是 0.1，所以压一半后回落线
   * 至少是 `0.05 > 0`，一定回得去。
   */
  const hysteresis = Math.min(Math.max(0, cfg.hysteresisRatio ?? 0), cfg.warnRatio / 2);
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
    /**
     * compaction 之后仍在高水位：只有当调用方声明「这轮紧跟一次压缩」时才抑制。
     *
     * ⚠️ **只认 `justCompacted`，不再要求 `atTurnBoundary`（D1，2026-10-17 复审）**：
     *    「紧跟一次压缩」这件事本身由 `compaction/end` 打的一次性标记精确表达。
     *    `atTurnBoundary` 仍保留在 `options` 里（调用方可以传），只是不再当闸门。
     */
    const suppressed = cfg.respectCompaction === true && options.justCompacted === true;
    if (suppressed) return { state: next, signal: null };
    return { state: next, signal: signalOf('enter', level, next) };
  }

  // 已武装：只在档位**升级**的那一次再响（warn → hard），同级重复不响。
  const rank = { none: 0, warn: 1, hard: 2 };
  // ⚠️ **必须用 rank 比较，不能直接比字符串**（P0-2）：字典序里 `'warn' > 'hard'` 为 true。
  const rankOf = (value) => rank[value] ?? 0;
  if (rankOf(level) > rankOf(wasLevel)) {
    next.level = level;
    return { state: next, signal: signalOf('escalate', level, next) };
  }
  // 走到这里必有 rankOf(level) <= rankOf(wasLevel)，保持原档位不变（绝不降级）。
  next.level = wasLevel;
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
 * 一轮结束：只推进轮计数、衰减冷却。**判定不在这里** —— 判定发生在投影变化时。
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
 * 判定事件的折叠 = 状态机对外的**唯一入口**（`init + apply(state, event)` 里的 `apply`）。
 *
 * 能进来的一共五种事件，全部来自宿主真实的事件流：
 *   · `observation`     ← `contextPressure` 投影变化（读数由调用方先归一化成 `reading`）
 *   · `turn/end`        ← 会话事件，推进轮计数、衰减冷却
 *   · `compaction/end`  ← 会话事件，置/清那次性的「刚压过」标记（**这就是「压缩标记从
 *                          compaction/* 事件推导」**的落点；原先在 `index.js` 的 Map 里）
 *   · `compaction/start|summary|prune` ← 会话事件，只记「压缩正在进行」，不参与判定
 *   · `disarm`          ← 切模型/路由（`request/header` / `model/selection`）
 *
 * 纯函数：不改 Map、不写日志、不读时钟。
 *
 * @param {object} state 上一次的状态
 * @param {{type: string, reading?: object, justCompacted?: boolean, failed?: boolean}} event
 * @param {object} [cfg] 当前生效配置
 * @returns {{state: object, signal: object|null}}
 */
export function fold(state, event, cfg = defaultConfig()) {
  const type = event?.type;
  if (type === 'observation') {
    const out = reduce(state, event.reading, {
      config: cfg,
      justCompacted: event.justCompacted === true || state.pendingCompaction === true,
    });
    // 一次性标记：紧随其后的那次观测消费它，之后必须清掉（否则抑制会变成永久静音）。
    const nextState = out.state.pendingCompaction === true ? { ...out.state, pendingCompaction: false } : out.state;
    return { state: nextState, signal: out.signal };
  }
  if (type === 'turn/end') return { state: nextTurn(state, cfg), signal: null };
  if (type === 'compaction/end') {
    /**
     * 压缩失败判据**只在这一处解析**（D2，2026-10-17 复审）：载荷实况是
     * 成功 `{compactionId, turn}`（根本没有 `error` 键），失败才追加 `error: <字符串>`。
     * 所以判据是「键在不在」，不是布尔化（`error: ''` 这种空消息会被布尔化误判成成功）。
     */
    const failed = event.failed === true;
    return {
      state: failed
        ? { ...state, pendingCompaction: false }
        : // 成功：置一次性「刚压过」标记 + 记下「水位掉下来过」（banner 用来解释那个回落）。
          { ...state, pendingCompaction: true, compactionDrop: true },
      signal: null,
    };
  }
  if (type === 'compaction/start' || type === 'compaction/summary' || type === 'compaction/prune') {
    // 压缩进行中/中间阶段：水位还没真的落下来，**不**置「刚压过」标记（否则会把该喊的提示静音）。
    return { state, signal: null };
  }
  if (type === 'disarm') {
    /**
     * 解除武装：切模型/换路由之后调用。
     * 理由：官方三个字段是 **last-wins、不是一个原子观测**，切模型后会出现
     * 「新窗口配旧压力」⇒ 宁可晚一轮提示，也不要拿错配的数字喊「该换会话了」。
     */
    return { state: { ...state, armed: false, level: 'none', cooldown: 0 }, signal: null };
  }
  return { state, signal: null };
}

export function createGuardEngine(config = defaultConfig(), deps = {}) {
  /** @type {Map<string, object>} */
  const states = new Map();
  /**
   * 压缩回执（v0.5.0，P1）：每个会话最近一次压缩的「压缩前峰值 / 账本行号 / 时刻」。
   * 只由宿主写（`noteReceipt`），随 wire 视图下发给 banner 的降级态；**不参与判定**。
   * @type {Map<string, {peakPercent:number, row:number, at:number}>}
   */
  const receipts = new Map();
  /**
   * 每个会话的**输出预留**（v0.6.1）：来自 `request/header` 的 `config.maxTokens`。
   * 只用来按 DSH 的公式推算「自动压缩点」，**不参与判定**。
   * @type {Map<string, number>}
   */
  const reserveTokens = new Map();
  /**
   * 每个会话的**路由**与**智能体预设**（v0.6.2）：来自 `request/header.config` 的
   * `provider/model` 与 `agent-preset/selected` 事件。只用于「这台机器、这个模型」的
   * 环境指纹与压缩点推算，**不参与判定**。
   * @type {Map<string, {provider: string, model: string}>}
   */
  const routes = new Map();
  /** @type {Map<string, string>} */
  const presets = new Map();

  /** DSH `dsh-compaction-basic` 的出厂默认值（读不到解析后配置时兜底）。 */
  const DEFAULT_THRESHOLD_RATIO = 0.8;
  const DEFAULT_HEADROOM_TOKENS = 65536;

  /**
   * 解析「本路由生效的压缩参数」（v0.6.2）。三层来源，可信度递减：
   *   · `config` —— `ctx.get('compaction').config`（**DSH 自己解析并冻结**的真值，含 modelPolicies），精确；
   *   · `default` —— 读不到配置/形状不认，用出厂常量，文案必须写「推算」；
   *   · `off` —— `auto: false`，确定地「不会自动压缩」，此时没有压缩点可给。
   */
  function resolveCompactPolicy(cfg, route) {
    if (cfg === null || typeof cfg !== 'object') {
      return { basis: 'default', ratio: DEFAULT_THRESHOLD_RATIO, headroom: DEFAULT_HEADROOM_TOKENS, auto: true };
    }
    if (cfg.auto === false) return { basis: 'off', ratio: null, headroom: null, auto: false };
    const policies = Array.isArray(cfg.modelPolicies) ? cfg.modelPolicies : null;
    const override =
      route === undefined || policies === null
        ? undefined
        : policies.find(
            (p) => p !== null && typeof p === 'object' && p.provider === route.provider && p.model === route.model,
          );
    const ratio = Number.isFinite(override?.thresholdRatio) ? override.thresholdRatio : cfg.thresholdRatio;
    const headroom = Number.isFinite(override?.headroomTokens) ? override.headroomTokens : cfg.headroomTokens;
    if (!Number.isFinite(ratio) || !Number.isFinite(headroom)) {
      return { basis: 'default', ratio: DEFAULT_THRESHOLD_RATIO, headroom: DEFAULT_HEADROOM_TOKENS, auto: true };
    }
    return { basis: 'config', ratio, headroom, auto: true };
  }


  /**
   * 按 DSH `dsh-compaction-basic` 的同一公式推算自动压缩点（百分比，1 位小数）。
   *
   *   threshold = floor(min(window × 0.8, window − reservedOutput − 65536))
   *
   * 为什么要算而不是写死 80%：`headroomTokens` 与输出预留是**从窗口里先扣掉的**，
   * 所以小窗口模型的压缩点远低于 80%（本机 GLM 200K + 131072 预留 ⇒ 3,392 token ≈ 1.7%）。
   * 本机 deepseek-flash（1,000,000 / 256,000）⇒ 678,464 ≈ **67.8%**，与真机观察一致。
   *
   * ⚠️ 这两个常量是 `dsh-compaction-basic` 的**默认值**：如果用户在 profile 里覆盖了
   * `thresholdRatio` / `headroomTokens`，这里推算的会是默认值而不是他们的实际值
   * （插件读不到那个服务的配置）。所以文案只说「推算」。
   */
  function autoCompactPercent(state, reserve, policy) {
    const window = Number.isFinite(state?.occupancy?.contextWindow) ? state.occupancy.contextWindow : null;
    if (window === null || window <= 0) return null;
    if (!Number.isFinite(reserve) || reserve < 0) return null;
    if (policy === null || policy.auto === false) return null;
    if (!Number.isFinite(policy.ratio) || !Number.isFinite(policy.headroom)) return null;
    const threshold = Math.floor(Math.min(window * policy.ratio, window - reserve - policy.headroom));
    if (!Number.isFinite(threshold) || threshold <= 0) return null;
    return Math.round((threshold / window) * 1000) / 10;
  }

  /** @type {object[]} */
  const log = [];
  /**
   * 镜像 state → wire view 的缓存。
   *
   * ⚠️ **v0.4.4 修正**：以前按注册表传进来的 `state` 做 WeakMap 键；但那份 state 只在
   * `drive()` 时被折叠，而**恢复/打开一个已存在的会话不会再产生事件** ⇒ 它停在 `init`（none），
   * 于是「恢复一个 67% 的会话」在浏览器里显示 none、banner 不弹（真实故障，2026-10-19）。
   * 宿主的真实判定在 `states`（`onResume` 现在会把它补上）⇒ view 必须**读引擎当前值**。
   * 仍然保证「值没变就返回同一引用」：按五元组做键缓存。
   * @type {Map<string, object>}
   */
  const mirrorViews = new Map();
  const MIRROR_VIEW_CACHE_MAX = 512;

  /**
   * 由引擎状态生成（并缓存）wire view；同值返回同一引用。
   *
   * v0.4.6：**把宿主当前的阈值随投影一起下发**（`warnRatio` / `hardRatio` / `enabled`）。
   * 为什么：`page load` 那一刻宿主可能还没为这个会话产生过任何事件 ⇒ 档位停在 `none`，
   * 而官方 `contextPressure` 已经是 67%（真机故障 §37.4）。客户端要能**只读地**把这条读数
   * 翻译成「该提示了」，就必须知道宿主此刻的阈值；阈值住在这里 = 仍然只有宿主一份真源，
   * 客户端不做迟滞/冷却/武装（那些状态一个都不下发）。
   */
  function viewOfState(s, cfg, receipt, reserve, route, preset, sessionId) {
    const level = MIRROR_LEVELS.includes(s?.level) ? s.level : 'none';
    const armed = s?.armed === true;
    const turn = Number.isFinite(s?.turn) ? s.turn : 0;
    const cooldown = Number.isFinite(s?.cooldown) ? s.cooldown : 0;
    const ratio = Number.isFinite(s?.occupancy?.ratio) ? s.occupancy.ratio : null;
    const enabled = cfg?.enabled !== false;
    const warnRatio = Number.isFinite(cfg?.warnRatio) ? cfg.warnRatio : null;
    const hardRatio = Number.isFinite(cfg?.hardRatio) ? cfg.hardRatio : null;
    /**
     * v0.6.2：压缩点从「默认常量」升级为「**优先读 DSH 解析后的配置**」。
     * v0.6.8：按**会话**取（有的机器上服务在 agent 的 scoped ctx 里，只有拿到 sessionId 才够得着）。
     */
    let compactionCfg = null;
    try {
      if (typeof deps.compactionConfig === 'function') compactionCfg = deps.compactionConfig(sessionId) ?? null;
    } catch {
      compactionCfg = null;
    }
    const policy = resolveCompactPolicy(compactionCfg, route);
    const compactPercent = autoCompactPercent(s, reserve, policy);
    // basis 描述的是「这个数字凭什么」：off = 确定不压；none = 算不出来（缺窗口/缺预留）。
    const compactBasis =
      policy.auto === false ? 'off' : compactPercent === null ? 'none' : policy.basis;
    const modelTag =
      route !== undefined && typeof route?.provider === 'string' && typeof route?.model === 'string'
        ? `${route.provider}/${route.model}`
        : null;
    const presetTag = typeof preset === 'string' && preset !== '' ? preset : null;
    // v0.5.0：压缩回执（P1）。只在「确实写过账本行」时才有值 ⇒ 没有回执就是三个 null。
    const receiptPercent = Number.isFinite(receipt?.peakPercent) ? receipt.peakPercent : null;
    const receiptRow = Number.isFinite(receipt?.row) ? receipt.row : null;
    const receiptAt = Number.isFinite(receipt?.at) ? receipt.at : null;
    const key = `${level}|${armed}|${turn}|${cooldown}|${ratio}|${enabled}|${warnRatio}|${hardRatio}|${receiptPercent}|${receiptRow}|${receiptAt}|${compactPercent}|${compactBasis}|${modelTag}|${presetTag}`;
    let view = mirrorViews.get(key);
    if (view === undefined) {
      view = {
        level,
        armed,
        turn,
        cooldown,
        ratio,
        warnRatio,
        hardRatio,
        enabled,
        receiptPercent,
        receiptRow,
        receiptAt,
        compactPercent,
        compactBasis,
        modelTag,
        presetTag,
      };
      if (mirrorViews.size > MIRROR_VIEW_CACHE_MAX) mirrorViews.clear();
      mirrorViews.set(key, view);
    }
    return view;
  }

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
    /**
     * 换一份生效配置（**运行期**，不重挂）。设置页写完之后下一轮就要按新阈值判断，
     * 所以 `apply` 每次入口都调它一次；`config` 一律从 `engine.config` 读，不缓存进闭包。
     */
    setConfig(next) {
      engine.config = next;
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
     * —— wire 投影单元的 `init` ——
     *
     * ⚠️ **只依赖会话头**（契约要求：`init(header, inheritedEventCount)` 是恢复/重建时唯一被允许的
     * 环境输入）。阈值不在这里、也不在 state 里：`level` 是宿主按**当前生效配置**算好的，
     * 因此设置页改完阈值，下一次镜像就跟上，不需要把阈值塞进 wire 载荷。
     */
    mirrorInit(header) {
      return { id: idOfHeader(header), level: 'none', armed: false, turn: 0, cooldown: 0, ratio: null };
    },
    /**
     * —— wire 投影单元的 `apply` ——
     *
     * 语义上是**镜像**：宿主判定（`states`）是唯一真源，这里只把「当前判定」抄成扁平 JSON。
     * 值没变就返回**同一个引用** ⇒ 注册表不调 `view`、不广播（这就是「值变才变」的落点）。
     *
     * 为什么 `event` 用不上：本单元的每一格都来自 `states`，而 `states` 由
     * `observe` / `endTurn` / `noteCompaction` / `resetArming` 更新（它们全部由**同一个**事件循环里的
     * `onChanged` / `session/event` 驱动）。注册表在 `drive()` 里按注册顺序推进各单元，
     * 本插件在 profile 里是**最后插入**的一条 ⇒ 同一事件里本单元排在 token-meter 的三个单元之后，
     * 读到的必然是刚更新过的判定（顺序依据：`cordis.patch.yml` 的 insert 落在用户 patch 层末尾）。
     * 即使被别的方式排在前面，最坏也只是**落后一个事件**（下一事件自动追平），不会长期不一致。
     */
    mirrorApply(state) {
      const s = states.get(state.id);
      const next = {
        level: s?.level ?? 'none',
        armed: s?.armed === true,
        turn: s?.turn ?? 0,
        cooldown: s?.cooldown ?? 0,
        ratio: s?.occupancy?.ratio ?? null,
      };
      return sameMirror(state, next) ? state : { id: state.id, ...next };
    },
    /**
     * —— wire 投影单元的 `view` ——
     *
     * v0.4.4 起**读引擎当前判定**（`states`），不再读注册表那份可能停在 `init` 的折叠态：
     * 恢复/打开旧会话不产生事件 ⇒ 那份 state 永远是 none，正是「67% 的会话不弹 banner」的根因。
     * 只放小、扁平、纯 JSON 的五个字段：**不要**把 `recent` / `history` / `trend` 塞进来。
     */
    mirrorView(state) {
      const id = state?.id;
      return viewOfState(
        states.get(id) ?? initialState(),
        engine.config,
        receipts.get(id),
        reserveTokens.get(id),
        routes.get(id),
        presets.get(id),
        id,
      );
    },
    /** v0.6.2：记下本会话的路由（provider/model），来自 `request/header.config`。 */
    setRoute(sessionId, route) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if (route === null || typeof route !== 'object') return;
      const provider = typeof route.provider === 'string' ? route.provider : '';
      const model = typeof route.model === 'string' ? route.model : '';
      if (provider === '' || model === '') return;
      routes.set(sessionId, { provider, model });
    },
    /** v0.6.2：记下本会话的智能体预设，来自 `agent-preset/selected` 事件。 */
    setPreset(sessionId, preset) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if (typeof preset !== 'string' || preset === '') return;
      presets.set(sessionId, preset);
    },
    /**
     * 记一条输出预留（v0.6.1）：来自 `request/header` 的 `config.maxTokens`。
     * 只影响 wire 视图里的「自动压缩点」推算，不参与判定。
     */
    setReserve(sessionId, tokens) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if (!Number.isFinite(tokens) || tokens < 0) return;
      reserveTokens.set(sessionId, tokens);
    },
    /**
     * v0.6.5：排障用的「按会话压缩点快照」——只读，进 `/state.compact`。
     *
     * 为什么需要：真机上「压缩点不显示」只能从浏览器 tooltip 看到结果，看不到**输入**。
     * 这里把决定数字的四个输入（窗口 / 预留 / 路由 / 配置态）原样吐出来，
     * 让排障不必靠猜「是没读到配置，还是没读到预留」。
     */
    debugCompact(limit = 5) {
      const rows = [];
      for (const [id, s] of states) {
        let cfg = null;
        try {
          if (typeof deps.compactionConfig === 'function') cfg = deps.compactionConfig(id) ?? null;
        } catch {
          cfg = null;
        }
        const route = routes.get(id);
        const policy = resolveCompactPolicy(cfg, route);
        const reserve = reserveTokens.get(id);
        const percent = autoCompactPercent(s, reserve, policy);
        rows.push({
          id,
          level: s?.level ?? 'none',
          window: Number.isFinite(s?.occupancy?.contextWindow) ? s.occupancy.contextWindow : null,
          reserve: Number.isFinite(reserve) ? reserve : null,
          model: route === undefined ? null : `${route.provider}/${route.model}`,
          preset: presets.get(id) ?? null,
          basis: policy.auto === false ? 'off' : percent === null ? 'none' : policy.basis,
          percent,
          // v0.6.9：判定读到的占用率（排障：`level` 与 `ratio` 对不上时先怀疑事件流）
          ratio: Number.isFinite(s?.occupancy?.ratio) ? s.occupancy.ratio : null,
          // v0.6.6：配置到底有没有读到（排障时不用再猜）
          cfg: cfg === null ? null : { keys: Object.keys(cfg).slice(0, 10), auto: cfg.auto !== false },
        });
      }
      return rows.slice(-limit);
    },
    /**
     * 记一条压缩回执（v0.5.0，P1）：只在压缩账**真的写了行**之后调用。
     * 只影响 wire 视图（banner 的降级态读它），不参与任何判定。
     */
    noteReceipt(sessionId, receipt) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if (!receipt || !Number.isFinite(receipt.peakPercent) || !Number.isFinite(receipt.row)) return;
      receipts.set(sessionId, { peakPercent: receipt.peakPercent, row: receipt.row, at: Number.isFinite(receipt.at) ? receipt.at : Date.now() });
    },
    /** v0.6.0：会话销毁时清掉它的状态与回执（daemon 常驻时这是唯一真实的内存增长来源之一）。 */
    forget(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      states.delete(sessionId);
      receipts.delete(sessionId);
      reserveTokens.delete(sessionId);
      routes.delete(sessionId);
      presets.delete(sessionId);
    },
    /**
     * 吸收一次投影变化。返回提示信号（无提示时 null）。
     * @param {string} sessionId
     * @param {unknown} pressure
     * @param {{atTurnBoundary?: boolean, justCompacted?: boolean, locale?: 'zh'|'en'}} [options]
     *        `locale` 由宿主半边按会话解析（见 `localeOf`）；不给 ⇒ `zh`（与加双语之前一致）。
     */
    observe(sessionId, pressure, options = {}) {
      const reading = readOccupancy(pressure);
      const stateBefore = stateOf(sessionId);
      // 判定本身是一次**纯折叠**：`justCompacted` 现在是状态里的 `pendingCompaction`，
      // 由 `compaction/end` 置位、由这次观测消费（见 `fold`）。
      const out = fold(
        stateBefore,
        { type: 'observation', reading, justCompacted: options.justCompacted === true },
        engine.config,
      );
      states.set(sessionId, out.state);
      if (out.signal === null) return null;
      if (!engine.config.enabled) return null;
      /**
       * 冷却闸门（P0-1 修）：**绝不能吞掉 `escalate`。**
       *
       * 历史 bug：`cooldownTurns` 默认 5。45% 首次 `enter` 后冷却 5 轮，而 45%→60% 只需 15pp
       * （实测常常 3–8 轮就到了）。此时 `reduce` 已经给出 `escalate/hard`，但这里一律丢弃
       * 非 `enter` 信号 —— 而 `states` 在上面那行**已经是 `level: 'hard'`**。于是此后同档
       * 不再 escalate ⇒ 宿主**永久漏报**「该换会话了」：不记日志、不外推、trend 不计数；
       * 而客户端徽标照常显示 hard ⇒ 宿主说没发生、界面上已经在喊，两边不一致。
       *
       * 现在的规矩：`enter` / `escalate` 都是**边沿信号**（每个武装周期各最多一次），一律放行；
       * 只有将来新增的其它信号类型才受冷却约束，且**丢弃时必须回滚 `level`**，
       * 否则状态会声称一个从未播报过的档位（正是上面那个 bug 的形状）。
       */
      const kind = out.signal.kind;
      const isEdgeSignal = kind === 'enter' || kind === 'escalate';
      if (!isEdgeSignal && (out.state.cooldown ?? 0) > 0) {
        states.set(sessionId, { ...out.state, level: stateBefore.level });
        return null;
      }
      const described = describeSignal(out.signal, {
        lang: options.locale === 'en' ? 'en' : 'zh',
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
      return { signal: out.signal, described };
    },
    /**
     * 把一条判定事件折进某会话的状态（`init + apply(state,event)` 里那个 `apply` 的薄壳：
     * 只多了一层「按会话取/存状态」，折叠本身仍是 `fold` 那个纯函数）。
     *
     * 公开它有两个用处：① 下面的 `endTurn` / `noteCompaction` / `resetArming` 都是它的薄封装，
     * 事件类型**只有一套**；② 排障时可以把真实事件日志抄下来重放（同一串事件 ⇒ 同一状态）。
     *
     * @param {string} sessionId
     * @param {{type: string, reading?: object, justCompacted?: boolean, failed?: boolean}} event
     * @returns {{state: object, signal: object|null}}
     */
    apply(sessionId, event) {
      const out = fold(stateOf(sessionId), event, engine.config);
      states.set(sessionId, out.state);
      return out;
    },
    /** 一轮结束：推进轮计数、清压缩标记、消耗冷却。 */
    endTurn(sessionId) {
      const next = engine.apply(sessionId, { type: 'turn/end' }).state;
      return {
        turn: next.turn,
        level: next.level,
        cooldown: next.cooldown,
        occupancy: next.occupancy,
      };
    },
    /**
     * 压缩结束 ⇒ 记一笔「水位刚被压过」，供 respectCompaction 与 UI 说明用。
     * v0.4.3：标记**折进状态**（`pendingCompaction`），不再由宿主另存一个 Map。
     */
    noteCompaction(sessionId, hadError) {
      engine.apply(sessionId, { type: 'compaction/end', failed: hadError === true });
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
      const was = stateOf(sessionId).armed === true || stateOf(sessionId).level !== 'none';
      engine.apply(sessionId, { type: 'disarm' });
      return was;
    },
    /**
     * 只把读数折进状态、**不发任何信号**（v0.4.5 启动补判用）。
     *
     * 为什么需要它：插件启动时，`session/created` 拿到的快照可能还没回放出
     * `contextPressure`（异步恢复），于是那个会话在宿主状态里停在 `none`；而浏览器
     * 页面加载时的基线正是读这个状态 ⇒ 一个 67% 的历史会话在你不发新消息之前**不弹**。
     * 启动后枚举一次现有会话、把已知读数折进来即可（silent：不记日志、不外推）。
     * @returns {boolean} 是否真的折进去了（读数未知时 false）
     */
    seed(sessionId, pressure) {
      const reading = readOccupancy(pressure);
      if (reading.known !== true) return false;
      const out = fold(stateOf(sessionId), { type: 'observation', reading }, engine.config);
      states.set(sessionId, out.state);
      return true;
    },
    /**
     * 会话打开/恢复：§10.4 说这才是「跨会话」的实质 ——
     * 点进一个已经 85% 的历史会话，进去之前没人告诉你。
     * @param {string} sessionId
     * @param {unknown} pressure
     * @param {{locale?: 'zh'|'en'}} [options]
     */
    onResume(sessionId, pressure, options = {}) {
      if (!engine.config.onResume) return null;
      const reading = readOccupancy(pressure);
      if (reading.known !== true) return null;
      /**
       * ⚠️ **v0.4.4 修正（2026-10-19 真机故障）**：以前这里只 `return` 一个信号、
       * **从不更新 `states`**。后果：恢复/打开一个已存在的会话**不产生新事件** ⇒
       * `fold` 不会被调用 ⇒ 引擎状态停在 `none` ⇒ 镜像投影也是 `none` ⇒
       * 浏览器里 67% 的会话**不弹 banner**（徽标仍显示 67%，因为它读的是官方 `contextPressure`）。
       *
       * 现在先把读数折进状态（这样镜像立刻反映真实档位），**再**决定要不要发「恢复提示」信号。
       * 仍保留原语义：只有 ≥ `hardRatio` 才发 resume 信号（避免点开一堆旧会话时刷 warn 通知）。
       */
      const out = fold(stateOf(sessionId), { type: 'observation', reading }, engine.config);
      states.set(sessionId, out.state);
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
        {
          lang: options.locale === 'en' ? 'en' : 'zh',
        },
      );
      return { signal: { kind: 'resume', level: 'hard', ratio: reading.ratio }, described };
    },
  };
  return engine;
}
