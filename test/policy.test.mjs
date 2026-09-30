/**
 * dsh-context-guard · 策略单测（node:test，零依赖）
 *
 * 覆盖的是 §10.3 那五个坑，逐条一个用例：
 *   1. 挂的是占用率而不是缓存命中率         → ratio 来自 projectedTokens/contextWindow
 *   2. 一律比率                              → 换窗口（同 ratio 不同绝对值）判定相同
 *   3. 双档 + 迟滞 + 边沿 + 冷却             → 不重复响、回落才重新武装
 *   4. compaction 交互                       → 掉下来清旗，再上来到 hard 要重响
 *   5. 数据缺席 fail-closed                  → 无分母不判定、不谎报 0%
 *
 * 跑法：`node --test test/`（node 在工作区外 D:\nodejs，需提权）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultConfig,
  readOccupancy,
  initialState,
  reduce,
  nextTurn,
  inCooldown,
  TrendTracker,
  describe as describeSignal,
  badgeText,
  shouldPush,
  pushText,
  plainConfig,
  isVolatileRef,
  STATE_ROUTE,
  LEVEL_ORDER,
} from '../lib/policy.mjs';

const read = (projected, window_) => readOccupancy({ projectedTokens: projected, contextWindow: window_ });
const step = (state, reading, options = {}) => reduce(state, reading, { config: defaultConfig(), ...options });

test('坑 5：无分母 / 无分子一律 fail-closed，且不谎报 0%', () => {
  for (const p of [undefined, null, {}, { projectedTokens: 1000 }, { contextWindow: 200000 }, { projectedTokens: 1, contextWindow: 0 }, { projectedTokens: NaN, contextWindow: 1e5 }]) {
    const r = readOccupancy(p);
    assert.equal(r.known, false, `应判为无数据：${JSON.stringify(p)}`);
    assert.equal(r.ratio, null);
    // 关键：absent 不能被当成 0 —— badge 要说「无数据」，不是「ctx 0%」
    assert.deepEqual(badgeText(r), { text: 'ctx —', known: false });
  }
  // 非有限数也不能通过
  assert.equal(readOccupancy({ projectedTokens: Infinity, contextWindow: 100 }).known, false);
});

test('分子分母错配（新窗口配旧压力）夹到 100%，不产生 >100% 的荒谬提示', () => {
  const r = read(300_000, 200_000);
  assert.equal(r.known, true);
  assert.equal(r.ratio, 1);
  assert.equal(r.ratioRaw, 1.5);
  assert.equal(r.clampMismatch, true);
});

test('坑 2：一律比率 —— 同样占用率、不同绝对窗口给出同档判定', () => {
  const a = step(initialState(), read(100_000, 200_000)); // 50%（warn 档）
  const b = step(initialState(), read(50_000, 100_000)); // 50%
  assert.equal(a.state.level, 'warn');
  assert.equal(b.state.level, 'warn');
  assert.equal(a.signal.level, b.signal.level);
});

test('坑 3：warn 边沿只响一次，同级重复不响', () => {
  let s = initialState();
  let out = step(s, read(100_000, 200_000)); // 50%
  assert.equal(out.signal?.kind, 'enter');
  assert.equal(out.signal.level, 'warn');
  s = out.state;
  for (const p of [104_000, 108_000, 112_000]) { // 52% / 54% / 56%，都仍在 warn 档
    out = step(s, read(p, 200_000));
    assert.equal(out.signal, null, `同级不该再响：${p}`);
    s = out.state;
  }
});

test('坑 3：warn → hard 升级要响一次 escalate，然后 hard 内不再重复', () => {
  let s = step(initialState(), read(100_000, 200_000)).state; // 50% → warn
  let out = step(s, read(130_000, 200_000)); // 65% → 升 hard
  assert.equal(out.signal?.kind, 'escalate');
  assert.equal(out.signal.level, 'hard');
  s = out.state;
  out = step(s, read(180_000, 200_000));
  assert.equal(out.signal, null);
  assert.equal(out.state.level, 'hard');
});

test('坑 3：迟滞 —— 只在回落到 warn−hysteresis 以下才重新武装', () => {
  const cfg = defaultConfig();
  const { warnRatio: W, hysteresisRatio: H } = cfg; // 默认 0.45 / 0.05 ⇒ 回落线 0.40
  const at = (r) => read(Math.round(r * 200_000), 200_000);
  let s = reduce(initialState(), at(W + 0.05), { config: cfg }).state; // 过 warn ⇒ 武装
  // 掉到 warn 与回落线之间 ⇒ 仍算武装，重新爬上去不出声
  let out = reduce(s, at(W - H / 2), { config: cfg });
  assert.equal(out.state.armed, true);
  assert.equal(out.state.level, 'warn');
  s = out.state;
  out = reduce(s, at(W + 0.05), { config: cfg });
  assert.equal(out.signal, null, '未真正回落，不该重新响');
  // 真正掉到回落线以下 ⇒ 解除武装
  out = reduce(out.state, at(W - H - 0.03), { config: cfg });
  assert.equal(out.state.armed, false);
  assert.equal(out.state.level, 'none');
  // 再爬上来 ⇒ 重新响一次
  out = reduce(out.state, at(W + 0.05), { config: cfg });
  assert.equal(out.signal?.kind, 'enter');
});

test('坑 4：compaction 让水位掉下来 ⇒ 清旗；再上来到 hard 必须重响', () => {
  const cfg = defaultConfig();
  let s = reduce(initialState(), read(170_000, 200_000), { config: cfg }).state; // hard
  assert.equal(s.level, 'hard');
  const dropped = reduce(s, read(40_000, 200_000), { config: cfg }); // 压缩遮蔽
  assert.equal(dropped.state.level, 'none');
  assert.equal(dropped.state.armed, false);
  assert.equal(dropped.state.compactionDrop, true, '要记住「掉下来过」，供 UI 说明');
  const back = reduce(dropped.state, read(170_000, 200_000), { config: cfg });
  assert.equal(back.signal?.kind, 'enter', '压缩后重新到 hard 必须再响');
  assert.equal(back.signal.level, 'hard');
  // 且提示里要带上「压缩掉过又上来了」
  assert.match(describeSignal(back.signal).body, /压缩/);
});

test('坑 4：respectCompaction 在「紧跟压缩的这轮」抑制出声，但不改状态', () => {
  const cfg = defaultConfig();
  const out = reduce(initialState(), read(170_000, 200_000), { config: cfg, atTurnBoundary: true, justCompacted: true });
  assert.equal(out.signal, null, '压缩正在压水位时不必提示换会话');
  assert.equal(out.state.level, 'hard', '但状态照记，徽标显示真数字');
});

test('冷却：跨档后 cooldownTurns 轮内不再出声', () => {
  const cfg = defaultConfig({ cooldownTurns: 5 });
  let out = reduce(initialState(), read(170_000, 200_000), { config: cfg });
  assert.equal(out.signal.kind, 'enter');
  assert.equal(inCooldown(out.state), true);
  let s = out.state;
  for (let i = 0; i < 5; i++) s = nextTurn(s, cfg);
  assert.equal(inCooldown(s), false);
});

test('turn/end 推进：turn 自增，压缩标记被清', () => {
  let s = reduce(initialState(), read(170_000, 200_000)).state;
  s = reduce(s, read(40_000, 200_000)).state;
  assert.equal(s.compactionDrop, true);
  s = nextTurn(s);
  assert.equal(s.turn, 1);
  assert.equal(s.compactionDrop, false);
});

test('enabled=false 时不该被调用方走到这里；describe 仍要给出正确档位措辞', () => {
  const hard = describeSignal({ kind: 'enter', level: 'hard', ratio: 0.82, projectedTokens: 164_000, contextWindow: 200_000 });
  assert.equal(hard.ratioPercent, 82);
  assert.match(hard.title, /新会话/);
  assert.match(hard.body, /164K/);
  assert.match(hard.body, /HANDOVER\.md/);
  const warn = describeSignal({ kind: 'enter', level: 'warn', ratio: 0.63, projectedTokens: 126_000, contextWindow: 200_000 });
  assert.match(warn.title, /收尾/);
  const en = describeSignal({ kind: 'enter', level: 'hard', ratio: 0.82, projectedTokens: 164_000, contextWindow: 200_000 }, { lang: 'en' });
  assert.match(en.body, /HANDOVER\.md/);
  // 双语（§19.6）：en 是独立一整套措辞，不是「中文 + 英文混排」
  assert.match(en.title, /start a new session/);
  assert.match(en.body, /164K/);
  assert.equal(en.lang, 'en', 'describe 要把语言带回去，pushText 才能说同一句话');
  assert.doesNotMatch(en.body, /[\u3400-\u4dbf\u4e00-\u9fff]/, 'en 文案里不许混汉字');
});

test('跨会话趋势：同一会话同一档位只记一次；到阈值措辞升级', () => {
  const t = new TrendTracker(defaultConfig({ trendEscalateAt: 3 }));
  t.note('s1', 'hard', 1_000_000);
  t.note('s1', 'hard', 1_000_001); // 重复
  t.note('s2', 'hard', 1_000_002);
  let sum = t.summary(1_000_003);
  assert.equal(sum.hardSessions, 2);
  assert.equal(sum.escalated, false, `escalateAt=3，2 个会话还不够`);
  t.note('s3', 'hard', 1_000_004);
  sum = t.summary(1_000_005);
  assert.equal(sum.hardSessions, 3);
  assert.equal(sum.escalated, true);
  const text = describeSignal({ kind: 'enter', level: 'hard', ratio: 0.85, projectedTokens: 1, contextWindow: 1 }, { trend: sum });
  assert.match(text.body, /换工作方式/);
  // 窗口之外要被丢掉
  assert.equal(t.summary(1_000_004 + 25 * 3600_000).hardSessions, 0);
});

test('warning 与 hard 是两档，不是同一档的两个阈值', () => {
  const cfg = defaultConfig();
  const mid = (cfg.warnRatio + cfg.hardRatio) / 2; // 两档正中间：换默认值也成立
  const out = reduce(initialState(), read(Math.round(mid * 200_000), 200_000), { config: cfg });
  assert.equal(out.signal.level, 'warn');
  assert.notEqual(out.state.level, 'hard');
});

// ————————————————————————————————————————————————————————————————
// 外推推送（§14.5 那条线）：推送是唯一会跑到用户手机上的副作用，
// 所以「关着不推 / 不到档不推 / 冷却内不推」必须在真机之外逐条证伪。
// ————————————————————————————————————————————————————————————————

test('外推：默认全关 —— 用户没开就绝不出声', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.pushChannel, 'none');
  const v = shouldPush('hard', cfg, { now: 1_000_000, lastPushAt: 0 });
  assert.equal(v.push, false);
  assert.equal(v.reason, 'channel-off');
});

test('外推：开通道后只推「不低于 pushMinLevel」的档，默认 hard 起', () => {
  const cfg = defaultConfig({ pushChannel: 'wechat' });
  assert.equal(shouldPush('none', cfg, { now: 1_000_000 }).push, false);
  assert.equal(shouldPush('none', cfg, { now: 1_000_000 }).reason, 'level-none');
  assert.equal(shouldPush('warn', cfg, { now: 1_000_000 }).reason, 'below-min-level');
  assert.equal(shouldPush('hard', cfg, { now: 1_000_000 }).push, true);
  // 显式降到 warn 起，就开始推 warn
  const loose = defaultConfig({ pushChannel: 'wechat', pushMinLevel: 'warn' });
  assert.equal(shouldPush('warn', loose, { now: 1_000_000 }).push, true);
  // 没有档位（畸形信号）不许推
  assert.equal(shouldPush(undefined, cfg, { now: 1_000_000 }).reason, 'no-level');
  assert.equal(shouldPush(null, cfg, { now: 1_000_000 }).reason, 'no-level');
});

test('外推：跨会话分钟级冷却 —— 同时开着多个会话时不连环打扰', () => {
  const cfg = defaultConfig({ pushChannel: 'wechat', pushCooldownMinutes: 10 });
  const at = 1_700_000_000_000;
  assert.equal(shouldPush('hard', cfg, { now: at, lastPushAt: at - 60_000 }).reason, 'cooldown');
  assert.equal(shouldPush('hard', cfg, { now: at, lastPushAt: at - 10 * 60_000 }).push, true, '刚好到间隔应放行');
  assert.equal(shouldPush('hard', cfg, { now: at, lastPushAt: 0 }).push, true, '从没推过就直接放行');
  // 0 = 不限间隔
  const noCool = defaultConfig({ pushChannel: 'wechat', pushCooldownMinutes: 0 });
  assert.equal(shouldPush('hard', noCool, { now: at, lastPushAt: at - 1 }).push, true);
});

test('外推：正文与 UI 说同一句话，且指向交接文档', () => {
  const described = describeSignal({ kind: 'enter', level: 'hard', ratio: 0.85, projectedTokens: 170_000, contextWindow: 200_000 });
  const text = pushText(described);
  assert.match(text, /^\[DSH 上下文守卫\]/);
  assert.match(text, /HANDOVER\.md/);
  assert.match(text, /85%/);
  // 缺字段也不许抛（通道永远不该因为措辞模块出问题而炸）
  assert.match(pushText({}), /DSH 上下文守卫/);
  assert.match(pushText(undefined), /DSH 上下文守卫/);
  // 双语：语言跟着 `described.lang` 走（title/body 就是那一刻按那个语言生成的）
  const enText = pushText(describeSignal({ kind: 'enter', level: 'hard', ratio: 0.85 }, { lang: 'en' }));
  assert.match(enText, /^\[DSH context-guard\]/);
  assert.match(enText, /start a new session/);
  assert.doesNotMatch(enText, /[\u3400-\u4dbf\u4e00-\u9fff]/, 'en 推送正文里不许混汉字');
  // 手工构造的 described（没有 lang）才看 opts.lang
  assert.match(pushText({ title: 'T', body: 'B' }, { lang: 'en' }), /^\[DSH context-guard\] T\nB$/);
  assert.match(pushText({ title: 'T' }), /^\[DSH 上下文守卫\] T$/);
});

test('宿主状态路由是两半边的共享契约，且档位序单调', () => {
  assert.equal(STATE_ROUTE, '/api/context-guard/state');
  assert.ok(LEVEL_ORDER.none < LEVEL_ORDER.warn && LEVEL_ORDER.warn < LEVEL_ORDER.hard);
});

// ————————————————————————————————————————————————————————————————
// volatile 配置引用（本插件踩过的**最贵**的一个坑，必须有回归护栏）
// DSH 把 `.volatile()` 字段以「引用对象」交给插件：读 `ref.warnRatio` 恒为 undefined ⇒
// 静默用默认值。判定照 @deepseek-ai/cosmokit 的 isVolatile：Symbol.for 那把钥匙。
// ————————————————————————————————————————————————————————————————
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 造一个与 cosmokit `createVolatile` 同形的引用（冻结对象 + get + 写入 symbol）。 */
const volatileRef = (value) => Object.freeze({ get: () => value, [VOLATILE_WRITE]: () => {} });

test('volatile 引用：认得出来，并摊平成值（否则插件静默用默认值）', () => {
  assert.equal(isVolatileRef(volatileRef(0.33)), true);
  assert.equal(isVolatileRef({ get: () => 1 }), false, '没有那把 symbol 的普通对象不算引用');
  assert.equal(isVolatileRef(null), false);
  assert.equal(isVolatileRef(0.33), false);

  const mixed = { warnRatio: volatileRef(0.33), hardRatio: 0.44, enabled: volatileRef(false) };
  assert.deepEqual(plainConfig(mixed), { warnRatio: 0.33, hardRatio: 0.44, enabled: false });
  // 普通对象是恒等变换（单测与 client 收到的 JSON 都走这条路）
  assert.deepEqual(plainConfig({ a: 1 }), { a: 1 });
  assert.deepEqual(plainConfig(undefined), {});
  assert.deepEqual(plainConfig(null), {});
});

test('volatile 引用：设置改了就能读到新值（同一引用的第二次 get）', () => {
  let current = 0.33;
  const ref = Object.freeze({ get: () => current, [VOLATILE_WRITE]: () => {} });
  assert.equal(plainConfig({ warnRatio: ref }).warnRatio, 0.33);
  current = 0.7; // 模拟设置页写入
  assert.equal(plainConfig({ warnRatio: ref }).warnRatio, 0.7, '引用是活的，值必须跟着变');
});
