/**
 * wire 投影的**契约测试**（v0.4.3，复审报告 §2 建议 #1）。
 *
 * 这条测试钉的是「宿主把自己的判定注册成一个 `wire` 投影之后，客户端能读到什么」——
 * 也就是这次改造唯一的对外承诺。三件事必须成立：
 *   1. **注册进得去**：注册表里出现 `contextGuard`，`stateVersion` 是 0，`init/apply/stateSchema/wire` 齐全；
 *   2. **形状对得上**：`snapshot(session)` 里出现该键，view 只有
 *      `level / armed / turn / cooldown / ratio` 五个扁平字段（**没有** recent/history/trend）；
 *   3. **值变才变**：没有任何变化时，`snapshot` 拿到的**是同一个引用**（注册表就不该广播）。
 *
 * 为什么用一个「假注册表」而不是真包：CI 不跑 `npm install`，`@deepseek-ai/dsh-session-projection`
 * 不在插件的依赖里。假注册表照真实实现的关键语义逐条抄（行号见下），并且**只实现插件真的会用的
 * 口子**（`register` / `onChanged` / `stateOf` / `snapshot` / `drive`）：
 *   · `register` 校验 `stateVersion` 是非负安全整数，且同键版本必须一致
 *     （`<DSH>/dsh-session-projection/lib/index.js:81,91`）；
 *   · `snapshot(session[, keys])` 不带 keys 时返回**所有**带 wire 的单元（同文件 `142-156`）；
 *   · `drive` 用 `Object.is` 判定 state 是否变了，只有变了才取 view、再比一次 view 引用，
 *     两次都没变就**不通知任何人**（同文件 `410-426`）——「值变才变」就靠这条；
 *   · `onChanged` 的监听器实参是 `(session, key, value, seq)`（同文件 `423`）。
 *
 * 依赖处理与 `test/wiring.test.mjs` 完全一致：`lib/index.js` 顶层 import 了宿主提供的
 * `@deepseek-ai/schemastery`，而 CI 不装依赖 ⇒ 用 `module.registerHooks()` 把它重定向到
 * `test/fixtures/schemastery-stub.mjs`。老 Node 没有 `registerHooks` 且本机也没装依赖时整体 skip。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';

// —— 把宿主的裸说明符指到本地桩（必须在 import `lib/index.js` **之前**注册）——
const STUB_URL = new URL('./fixtures/schemastery-stub.mjs', import.meta.url).href;
let hookRegistered = false;
try {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@deepseek-ai/schemastery') return { url: STUB_URL, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  hookRegistered = true;
} catch {
  hookRegistered = false; // 老 Node（< 22.15）没有 registerHooks
}

/** @type {Function|null} */
let apply = null;
let loadError = null;
try {
  ({ apply } = await import('../lib/index.js'));
} catch (error) {
  loadError = error;
}
if (loadError !== null && hookRegistered) throw loadError;
const SKIP_REASON =
  loadError === null
    ? null
    : `宿主依赖 @deepseek-ai/schemastery 不可用（CI 不跑 npm install，本机也没装）⇒ 无法驱动真实 apply()：${loadError.message}`;

const stubCheck = async () => {
  if (hookRegistered !== true) return;
  const mod = await import('@deepseek-ai/schemastery');
  assert.equal(mod.__STUB__, true, 'registerHooks 必须把裸说明符重定向到测试桩');
};

/** token-meter 的 wire 形状（`readOccupancy` 只认 projectedTokens / contextWindow）。 */
const p = (ratio, window = 200_000) => ({ projectedTokens: Math.round(ratio * window), contextWindow: window });

/**
 * 假注册表：语义照真实实现（见文件头的行号），只实现插件真的会用的五个口子。
 */
function createRegistry() {
  const registrations = new Map();
  /** session → key → { state, view } */
  const cells = new Map();
  const listeners = new Set();
  let seq = 0;

  const cellFor = (def, session) => {
    let per = cells.get(session);
    if (per === undefined) {
      per = new Map();
      cells.set(session, per);
    }
    let cell = per.get(def.key);
    if (cell === undefined) {
      cell = { state: def.init(session.header, 0), view: undefined };
      per.set(def.key, cell);
    }
    return cell;
  };

  return {
    registrations,
    listeners,
    nextSeq() {
      return seq++;
    },
    register(def) {
      const { stateVersion } = def;
      if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) {
        throw new Error(`stateVersion must be a non-negative integer, got ${String(stateVersion)}`);
      }
      const existing = registrations.get(def.key);
      if (existing !== undefined && existing.stateVersion !== stateVersion) {
        throw new Error(`key ${def.key} already registered at version ${existing.stateVersion}`);
      }
      registrations.set(def.key, def);
      return () => void registrations.delete(def.key);
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stateOf(session, key) {
      const def = registrations.get(key);
      return def === undefined ? undefined : cellFor(def, session).state;
    },
    snapshot(session, keys) {
      const selected = keys === undefined ? undefined : new Set(keys);
      const values = {};
      for (const [key, def] of registrations) {
        if (def.wire === undefined) continue;
        if (selected !== undefined && !selected.has(key)) continue;
        values[key] = def.wire.viewSchema.parse(def.wire.view(cellFor(def, session).state));
      }
      return { asOfSeq: seq, values };
    },
    /** 把一个已提交事件推进每个单元（真实实现的 `drive()`）。 */
    drive(session, event) {
      const at = this.nextSeq();
      for (const [key, def] of registrations) {
        const cell = cellFor(def, session);
        const before = cell.state;
        const next = def.apply(before, event);
        cell.state = next;
        if (Object.is(next, before)) continue; // state 没变 ⇒ 不取 view、不广播
        const wire = def.wire;
        if (wire === undefined) continue;
        const previousView = cell.view;
        cell.view = wire.view(next);
        if (Object.is(previousView, cell.view)) continue; // view 引用没变 ⇒ 不广播
        const value = wire.viewSchema.parse(cell.view);
        for (const listener of listeners) listener(session, key, value, at);
      }
    },
  };
}

/**
 * 起一个真实插件实例 + 假注册表。
 *
 * `project()` 的顺序**刻意照真机**：token-meter 的单元先被推进 ⇒ `onChanged` 发出新压力值 ⇒
 * 我们订阅的回调更新引擎 ⇒ 再 drive 一次让 `contextGuard` 单元重新镜像。
 * （真机上两个单元由同一次 `drive()` 按注册顺序推进，本插件在 profile 里是最后插入的那条。）
 */
function boot(overrides = {}) {
  const handlers = new Map();
  const services = new Map();
  const registry = createRegistry();

  const sctx = {
    sessionProjections: registry,
    effect(factory) {
      return factory();
    },
  };

  const ctx = {
    logger: { info() {}, warn() {} },
    provide(name, value) {
      services.set(name, value);
    },
    get(name) {
      return services.get(name);
    },
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    inject(names, callback) {
      // 只让 `sessionProjections` 在场；webServer / wechatNotify 缺席 ⇒ 宿主不会回调（照真机）。
      if (names.includes('sessionProjections')) callback(sctx);
    },
  };

  apply(ctx, { enabled: true, handoverOnWarn: false, ...overrides });

  const engine = services.get('contextGuard');
  assert.ok(engine !== undefined, 'apply() 必须通过 ctx.provide 交出引擎');

  return {
    engine,
    registry,
    /** 推一次 contextPressure 变化（token-meter 的 wire 更新），然后驱动一次镜像。 */
    project(session, value) {
      for (const fn of registry.listeners) fn(session, 'contextPressure', value, registry.nextSeq());
      registry.drive(session, { type: 'assistant/attempt', seq: registry.nextSeq() });
    },
    /** 推一条日志事件：注册表先 drive（同真机的监听器顺序），再走插件自己的 `session/event`。 */
    sessionEvent(session, event) {
      registry.drive(session, event);
      for (const fn of handlers.get('session/event') ?? []) fn(session, event);
      // 事件处理完（例如 turn/end 推进了轮计数）之后，下一个事件才会让镜像跟上；
      // 这里显式再 drive 一次，模拟「下一事件」到达时的重现——断言只看稳定态。
      registry.drive(session, { type: 'session/idle', seq: registry.nextSeq() });
    },
    /** 只 drive、不动插件：用来验证「没有变化时不该广播」。 */
    driveOnly(session, event = { type: 'assistant/message' }) {
      registry.drive(session, { ...event, seq: registry.nextSeq() });
    },
  };
}

const session = (id) => ({ id, header: { id }, cwd: tmpdir() });

const gate = (name, fn) =>
  test(name, async (t) => {
    if (SKIP_REASON !== null) {
      t.skip(SKIP_REASON);
      return;
    }
    await stubCheck();
    await fn(t);
  });

// v0.4.6：wire 里多了**宿主阈值三字段**（`warnRatio` / `hardRatio` / `enabled`）——
// 客户端据此在「宿主档位还没被事件驱动」时做只读的显示兜底（§37.4）。
// v0.5.0：又多了**压缩回执三字段**（`receiptPercent` / `receiptRow` / `receiptAt`）。
// v0.6.1：多了**自动压缩点**（`compactPercent`，按 DSH 公式推算）。
// v0.6.10：又多了算这个数的**三个参数**（ratio / headroom / reserve），客户端用实时读数重算。
const VIEW_KEYS = [
  'armed',
  'compactBasis',
  'compactHeadroom',
  'compactPercent',
  'compactRatio',
  'compactReserve',
  'cooldown',
  'enabled',
  'hardRatio',
  'level',
  'modelTag',
  'presetTag',
  'ratio',
  'receiptAt',
  'receiptPercent',
  'receiptRow',
  'turn',
  'warnRatio',
];

gate('注册契约：key=contextGuard、stateVersion=0、四个回调与 wire 齐全，且只注册一次', () => {
  const h = boot();
  const keys = [...h.registry.registrations.keys()];
  assert.deepEqual(keys, ['contextGuard'], `注册表里应当只有这一个键，实际：${keys.join(',')}`);
  const def = h.registry.registrations.get('contextGuard');
  assert.equal(def.stateVersion, 0, 'stateVersion 必须从 0 起（本单元没有历史形状要兼容）');
  for (const fn of ['init', 'apply']) assert.equal(typeof def[fn], 'function', `${fn} 必须是函数`);
  assert.ok(def.stateSchema && typeof def.stateSchema.parse === 'function', 'stateSchema 必须提供 parse');
  assert.ok(def.wire, '必须带 wire（否则 snapshot 不会包含它，客户端永远读不到）');
  assert.equal(typeof def.wire.view, 'function', 'wire.view 必须是函数');
  assert.ok(def.wire.viewSchema && typeof def.wire.viewSchema.parse === 'function', 'wire.viewSchema 必须提供 parse');
});

gate('snapshot 契约：出现 contextGuard，view 形状正确且是扁平纯 JSON', async (t) => {
  const h = boot();
  const s = session('proj-shape');

  // 首帧：还没任何观测 ⇒ 初始档位
  const initial = h.registry.snapshot(s);
  assert.ok(Object.hasOwn(initial.values, 'contextGuard'), 'snapshot 不带 keys 时必须包含本插件注册的键');
  assert.deepEqual(initial.values.contextGuard, {
    level: 'none',
    armed: false,
    turn: 0,
    cooldown: 0,
    ratio: null,
    warnRatio: 0.45,
    hardRatio: 0.6,
    enabled: true,
    receiptPercent: null,
    receiptRow: null,
    receiptAt: null,
    compactPercent: null,
    // v0.7.0：basis 只描述参数来源（出厂默认），不再因为「算不出百分比」折叠成 none
    compactBasis: 'default',
    compactRatio: 0.8,
    compactHeadroom: 65536,
    compactReserve: null,
    modelTag: null,
    presetTag: null,
  });
  t.diagnostic(`初始 view：${JSON.stringify(initial.values.contextGuard)}`);

  // 70% ⇒ hard（超过默认 hardRatio 0.6）
  h.project(s, p(0.7));
  const after = h.registry.snapshot(s).values.contextGuard;
  assert.deepEqual([...Object.keys(after)].sort(), VIEW_KEYS, `view 只允许这八个字段，实际：${Object.keys(after)}`);
  assert.equal(after.level, 'hard');
  assert.equal(after.armed, true);
  assert.equal(after.turn, 0);
  assert.equal(after.cooldown > 0, true, '进入 warn/hard 后应当进入冷却');
  assert.equal(typeof after.ratio, 'number');
  assert.equal(Math.round(after.ratio * 100), 70);
  // 扁平、纯 JSON：value 里不许有函数、不许有嵌套对象/数组
  for (const [key, value] of Object.entries(after)) {
    assert.ok(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
      `字段 ${key} 必须是标量（wire 载荷要小、要能直接进 JSON）`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(after)), after, 'view 必须能无损过一遍 JSON');
  // 明确：排障面（recent/history/trend/交接素材）不许进 wire
  for (const banned of ['recent', 'history', 'trend', 'occupancy', 'compactionDrop']) {
    assert.equal(Object.hasOwn(after, banned), false, `wire 里不许出现 ${banned}（那是 /state 路由的排障面）`);
  }

  // 与引擎自身的判定一致（同一个真源，不是第二套状态机）
  const snap = h.engine.snapshotOf('proj-shape');
  assert.equal(after.level, snap.level, 'wire 档位必须等于引擎档位');
  assert.equal(after.armed, snap.armed);
  assert.equal(after.turn, snap.turn);
  assert.equal(after.cooldown, snap.cooldown);
  assert.equal(after.ratio, snap.occupancy.ratio);
});

gate('「值变才变」：无变化时 snapshot 给同一个引用，且不产生任何广播', async (t) => {
  const h = boot();
  const s = session('proj-stable');
  let broadcasts = 0;
  h.registry.listeners.add((_session, key) => {
    if (key === 'contextGuard') broadcasts += 1;
  });

  h.project(s, p(0.5));
  const first = h.registry.snapshot(s).values.contextGuard;
  assert.equal(broadcasts, 1, '首次跨线（none → warn）应当广播一次');
  const second = h.registry.snapshot(s).values.contextGuard;
  assert.equal(second, first, '没有任何变化时 snapshot 必须返回同一个引用（否则客户端每次轮询都重渲染）');

  // 推几条与本单元无关的事件：state 不变 ⇒ 不取 view ⇒ 不广播
  const before = broadcasts;
  h.driveOnly(s, { type: 'assistant/message' });
  h.driveOnly(s, { type: 'tool/start' });
  h.driveOnly(s, { type: 'tool/end' });
  assert.equal(broadcasts, before, '无关事件不该产生 broadcast');
  assert.equal(h.registry.snapshot(s).values.contextGuard, first, '无关事件之后引用仍然必须稳定');

  // 同一个读数再推一次（token-meter 可能重复发同一份值）：依旧是同一个引用
  h.project(s, p(0.5));
  assert.equal(h.registry.snapshot(s).values.contextGuard, first, '读数未变（同一档位、同一 ratio）时引用仍要稳定');
});

gate('值变即广播：turn/end 推进轮次后 view 换新引用，且只广播一次', async (t) => {
  const h = boot();
  const s = session('proj-turn');
  const seen = [];
  h.registry.listeners.add((_session, key, value) => {
    if (key === 'contextGuard') seen.push(value);
  });

  h.project(s, p(0.5));
  const first = h.registry.snapshot(s).values.contextGuard;
  assert.equal(first.turn, 0);

  h.sessionEvent(s, { type: 'turn/end', data: {} });
  const afterTurn = h.registry.snapshot(s).values.contextGuard;
  assert.notEqual(afterTurn, first, '轮次变了 ⇒ view 必须换引用');
  assert.equal(afterTurn.turn, 1, 'turn 必须由宿主推进（客户端不再自己算）');
  assert.equal(afterTurn.level, first.level, '档位不受轮次影响');
  assert.equal(afterTurn.cooldown, Math.max(0, first.cooldown - 1), '冷却由宿主按轮衰减');
  assert.ok(seen.length >= 2, '这次变化应当广播出去');
  assert.equal(seen[seen.length - 1].turn, 1);
});

gate('回落链路：占用率降回迟滞线以下 ⇒ level 回 none、armed 归 false，ratio 跟着降', () => {
  const h = boot();
  const s = session('proj-fall');
  h.project(s, p(0.7));
  assert.equal(h.registry.snapshot(s).values.contextGuard.level, 'hard');

  h.project(s, p(0.2));
  const view = h.registry.snapshot(s).values.contextGuard;
  assert.equal(view.level, 'none', '回落到迟滞线以下必须解除档位');
  assert.equal(view.armed, false, '解除武装（否则永远收不到下一次 enter）');
  assert.equal(Math.round(view.ratio * 100), 20);
});

gate('schema 不是摆设：parse 合法时**原样返回**（引用稳定），非法值才重建', () => {
  const h = boot();
  const def = h.registry.registrations.get('contextGuard');
  const good = {
    level: 'warn',
    armed: true,
    turn: 2,
    cooldown: 3,
    ratio: 0.5,
    warnRatio: 0.45,
    hardRatio: 0.6,
    enabled: true,
    receiptPercent: null,
    receiptRow: null,
    receiptAt: null,
    compactPercent: 67.8,
    compactBasis: 'config',
    compactRatio: 0.8,
    compactHeadroom: 65536,
    compactReserve: 256000,
    modelTag: 'deepseek-official/deepseek-flash',
    presetTag: null,
  };
  assert.equal(def.wire.viewSchema.parse(good), good, '合法 view 必须原样返回，否则引用稳定性被 parse 毁掉');

  const fixed = def.wire.viewSchema.parse({ level: 'nonsense', armed: 1, turn: -3, cooldown: 'x', ratio: 5 });
  assert.deepEqual(
    fixed,
    {
      level: 'none',
      armed: false,
      turn: 0,
      cooldown: 0,
      ratio: 1,
      warnRatio: null,
      hardRatio: null,
      enabled: true,
      receiptPercent: null,
      receiptRow: null,
      receiptAt: null,
      compactPercent: null,
      compactBasis: 'none',
      compactRatio: null,
      compactHeadroom: null,
      compactReserve: null,
      modelTag: null,
      presetTag: null,
    },
    '非法 view 必须被夹成合法形状',
  );

  const stateOk = { id: 'x', level: 'hard', armed: true, turn: 1, cooldown: 0, ratio: 0.9 };
  assert.equal(def.stateSchema.parse(stateOk), stateOk, '合法 state 必须原样返回');
  assert.deepEqual(def.stateSchema.parse({}), { id: '', level: 'none', armed: false, turn: 0, cooldown: 0, ratio: null });
});
