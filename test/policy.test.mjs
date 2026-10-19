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
  describe as describeSignal,
  badgeText,
  plainConfig,
  isVolatileRef,
  STATE_ROUTE,
  LEVEL_ORDER,
  displayLevel,
  shownBannerLevel,
} from '../lib/policy.mjs';
// 判定状态机 v0.4.3 搬到 engine.mjs（policy.mjs 会被逐字内联进浏览器 bundle，
// 状态机住在里面 ⇒ 客户端永远「有一套可用的判定逻辑」，那正是 P1-5 漂移的入口）。
import { initialState, reduce, nextTurn, inCooldown, fold } from '../lib/engine.mjs';

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

// P0-2 回归（2026-10-17 代码审查发现）：已武装时档位只能用 rank 比较、**绝不降级**。
// 旧代码写的是 `level > wasLevel ? level : wasLevel` —— 字符串字典序里 'warn' > 'hard' 为 true，
// 于是 hard 回落到 warn 带时会被降级成 warn，再回到 60% 就会**重复发一次 escalate**。
test('P0-2 回归：已武装时 hard 回落到 warn 带不得降级，再上 60% 不得重复 escalate', () => {
  const cfg = defaultConfig(); // warn 0.45 / hard 0.60 / hysteresis 0.05 ⇒ 回落线 0.40
  const at = (r) => read(Math.round(r * 200_000), 200_000);

  // 首次直接进 hard ⇒ 唯一的 enter
  let out = reduce(initialState(), at(0.7), { config: cfg });
  assert.equal(out.signal?.kind, 'enter');
  assert.equal(out.signal.level, 'hard');

  // 回落到 warn 带内（仍高于回落线 0.40，不解除武装）⇒ 档位必须保持 hard
  out = reduce(out.state, at(0.5), { config: cfg });
  assert.equal(out.state.armed, true, '0.50 > 回落线 0.40，仍是武装状态');
  assert.equal(out.state.level, 'hard', '已武装时档位只升不降 —— 不得被降级成 warn');
  assert.equal(out.signal, null, '同级重复不该出声');

  // 再回到 hard ⇒ 档位没变过 ⇒ **不得**再发 escalate（若上一步被降级，这里就会重复响）
  out = reduce(out.state, at(0.65), { config: cfg });
  assert.equal(out.signal, null, '同档重复不响；这里若发生过降级就会重复 escalate');

  // 反向对照：warn 起步再升 hard ⇒ 必须响一次 escalate（升级路径本身要正常）
  const w = reduce(initialState(), at(0.5), { config: cfg });
  assert.equal(w.signal?.kind, 'enter');
  assert.equal(w.signal.level, 'warn');
  const up = reduce(w.state, at(0.65), { config: cfg });
  assert.equal(up.signal?.kind, 'escalate', 'warn → hard 必须升级出声');
  assert.equal(up.signal.level, 'hard');
});

// P1-4 回归（2026-10-17 代码审查发现）：迟滞必须被压到 warn 的一半以内。
// 否则 warnRatio <= hysteresisRatio 时回落线被 max(0,…) 夹成 0 ⇒ 占用率永远 > 0 ⇒ 武装后永不解锁。
test('P1-4 回归：hysteresis ≥ warn 时回落线不得被夹到 0（否则武装后再也收不到 enter）', () => {
  const cfg = defaultConfig({ warnRatio: 0.45, hysteresisRatio: 0.9 }); // 极端：迟滞比 warn 还大
  const at = (r) => read(Math.round(r * 200_000), 200_000);

  const armed = reduce(initialState(), at(0.5), { config: cfg });
  assert.equal(armed.state.armed, true);
  assert.equal(armed.signal?.kind, 'enter');

  // 掉到回落线以下（压一半后回落线 = 0.45 − 0.225 = 0.225，0.20 < 0.225）⇒ 必须解除武装。
  // 若回落线被夹到 0，这里会永远 armed = true。
  const out = reduce(armed.state, at(0.2), { config: cfg });
  assert.equal(out.state.armed, false, '回落线必须落在 >0 的位置，否则永不解除武装');
  assert.equal(out.state.level, 'none');

  // 解除后重新爬上来 ⇒ 应当能再收到一次 enter
  const again = reduce(out.state, at(0.5), { config: cfg });
  assert.equal(again.signal?.kind, 'enter', '解除武装后必须能重新响');
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

test('warning 与 hard 是两档，不是同一档的两个阈值', () => {
  const cfg = defaultConfig();
  const mid = (cfg.warnRatio + cfg.hardRatio) / 2; // 两档正中间：换默认值也成立
  const out = reduce(initialState(), read(Math.round(mid * 200_000), 200_000), { config: cfg });
  assert.equal(out.signal.level, 'warn');
  assert.notEqual(out.state.level, 'hard');
});

// v0.5.0：外推推送与跨会话趋势已删除（行为 + i18n + 测试）。配置键保留为 no-op，
// 但刻意**不**在这里断言它们的语义 —— 那是「保留键只为兼容旧配置」，不是规格。

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

/**
 * v0.4.6：显示档位兜底（真机故障 §37.4）。
 * 场景：打开一个恢复出来的 67% 历史会话 —— 宿主没有新事件可驱动，档位停在 `none`，
 * 而官方 `contextPressure` 已经是 67%。banner 必须凭这条读数就弹。
 */
test('displayLevel：宿主有档位就听宿主的，不存在第二套判定', () => {
  const r = (ratio) => readOccupancy({ projectedTokens: Math.round(ratio * 200000), contextWindow: 200000 });
  const host = { level: 'hard', armed: true, turn: 3, cooldown: 2, ratio: 0.9, warnRatio: 0.45, hardRatio: 0.6, enabled: true };
  assert.equal(displayLevel(host, r(0.2)), 'hard', '宿主说 hard 就必须是 hard（哪怕官方读数只有 20%）');
  assert.equal(displayLevel({ ...host, level: 'warn' }, r(0.9)), 'warn', '宿主说 warn 就听 warning，不自行升级');
});

test('displayLevel：宿主停在 none + 官方读数已过线 ⇒ 兜底显示（恢复会话的启动基线）', () => {
  const view = { level: 'none', armed: false, turn: 0, cooldown: 0, ratio: null, warnRatio: 0.45, hardRatio: 0.6, enabled: true };
  const r = (ratio) => readOccupancy({ projectedTokens: Math.round(ratio * 200000), contextWindow: 200000 });
  assert.equal(displayLevel(view, r(0.67)), 'hard', '67% ≥ hardRatio 0.6 ⇒ 页面加载那一刻就该是 hard');
  assert.equal(displayLevel(view, r(0.5)), 'warn');
  assert.equal(displayLevel(view, r(0.2)), 'none', '没过线当然不提示');
  // 阈值缺席 ⇒ 退回出厂值（defaultConfig），两边仍是同一份
  assert.equal(displayLevel({ level: 'none' }, r(0.67)), 'hard');
  // 无读数 ⇒ fail-closed（不假装 0%，也不假装过线）
  assert.equal(displayLevel(view, readOccupancy(undefined)), 'none');
  // 宿主总开关关掉 ⇒ 客户端也不许自己喊
  assert.equal(displayLevel({ ...view, enabled: false }, r(0.99)), 'none');
});

/**
 * v0.4.7（真机反馈 2026-10-19 14:5x）：压缩把水位压到 20% 之后 banner 整个消失，
 * 而里面正摆着「①/② 可复制交接」—— 用户恰好在按提示写结论，面板被一次压缩带走。
 * 规矩：**出过声就不消失**，等用户自己点「知道了 / ×」。
 */
test('shownBannerLevel：出过声的 banner 不因压缩回落而消失', () => {
  assert.equal(shownBannerLevel('hard', 'none'), 'hard', '水位掉回 none 时沿用出过声的 hard');
  assert.equal(shownBannerLevel('none', 'warn'), 'warn');
  assert.equal(shownBannerLevel('hard', 'warn'), 'hard', '当前档位优先于旧档位');
  assert.equal(shownBannerLevel('none', 'none'), 'none', '没出过声就不显示');
  assert.equal(shownBannerLevel('none', undefined), 'none');
  assert.equal(shownBannerLevel('warn', 'hard'), 'warn', '已经回落成 warn 就按 warn 说');
});
