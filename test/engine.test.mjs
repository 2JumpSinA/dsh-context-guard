/**
 * 引擎级回归测试（`createGuardEngine`，即 host 半边真实的那个入口）。
 *
 * 为什么需要它：`policy.mjs` 的纯函数测试覆盖不到 `index.js` 里的**冷却闸门**与
 * **`justCompacted` 透传** —— 而 2026-10-17 代码审查发现的两条 P0/P1 恰恰都在这里：
 *   · P0-1：冷却闸门把 `escalate` 丢掉，而 `states` 已写成 hard ⇒ 宿主永久漏报；
 *   · P1-1：`justCompacted` 从来没人传 ⇒ `respectCompaction` 是死开关。
 * 这两条在纯函数层都是"看起来对"的，只有引擎层能钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createGuardEngine } from '../lib/engine.mjs';
import { defaultConfig } from '../lib/policy.mjs';

/** 构造一个 token-meter 投影形状（`readOccupancy` 只认 projectedTokens / contextWindow）。 */
const p = (ratio, window = 200_000) => ({
  projectedTokens: Math.round(ratio * window),
  contextWindow: window,
});

test('P0-1 回归：冷却期内 warn → hard 的 escalate 不得被吞掉', () => {
  const engine = createGuardEngine(defaultConfig({ cooldownTurns: 5 }));
  const S = 'p0-1';

  // 45% 起步 ⇒ enter(warn)，并进入冷却
  const first = engine.observe(S, p(0.5));
  assert.equal(first?.signal?.kind, 'enter');
  assert.equal(first?.signal?.level, 'warn');
  assert.ok(engine.snapshotOf(S).cooldown > 0, 'enter 之后应处于冷却中');

  // 冷却还没过就冲到 60%+ ⇒ **必须照样报 escalate/hard**
  // （历史 bug：闸门把它丢掉，但 states 已在 reduce 里写成 hard ⇒ 此后同档不再报，永久漏报）
  const up = engine.observe(S, p(0.65));
  assert.notEqual(up, null, '冷却期内也必须报 hard 升级，不能静默吞掉');
  assert.equal(up?.signal?.kind, 'escalate');
  assert.equal(up?.signal?.level, 'hard');
  assert.equal(engine.snapshotOf(S).level, 'hard');

  // 同档重复仍然不出声（边沿语义不能被这次修复破坏）
  assert.equal(engine.observe(S, p(0.7)), null, '同档重复不出声');
});

test('P0-2 回归（引擎视角）：hard 回落到 warn 带后再上 60% 不会重复 escalate', () => {
  const engine = createGuardEngine(defaultConfig());
  const S = 'p0-2';

  assert.equal(engine.observe(S, p(0.7))?.signal?.level, 'hard');
  assert.equal(engine.observe(S, p(0.5)), null, '回落不进 hard 档，不出声');
  assert.equal(engine.snapshotOf(S).level, 'hard', '已武装时档位不得被降级');
  assert.equal(engine.observe(S, p(0.7)), null, '档位没变过 ⇒ 不得重复 escalate');
});

test('P1-1 回归：respectCompaction 在紧跟压缩的那一轮真的会抑制出声', () => {
  const engine = createGuardEngine(defaultConfig({ respectCompaction: true }));
  const S = 'p1-1';

  const hit = engine.observe(S, p(0.7), { atTurnBoundary: true, justCompacted: true });
  assert.equal(hit, null, '压缩正在压水位时不必提示换会话');
  assert.equal(engine.snapshotOf(S).level, 'hard', '但状态照记，徽标显示真数字');

  // 关掉之后同一情形必须出声 —— 证明抑制确实来自这个开关，而不是别的原因
  const off = createGuardEngine(defaultConfig({ respectCompaction: false }));
  const loud = off.observe(S, p(0.7), { atTurnBoundary: true, justCompacted: true });
  assert.equal(loud?.signal?.level, 'hard', '关掉 respectCompaction 就该出声');
});

test('冷却按「轮」衰减：endTurn 递减 cooldown，且衰减到 0 后仍在同一档不出声', () => {
  const cfg = defaultConfig({ cooldownTurns: 5 });
  const engine = createGuardEngine(cfg);
  const S = 'cd';

  engine.observe(S, p(0.5)); // enter(warn) ⇒ cooldown = 5
  assert.equal(engine.snapshotOf(S).cooldown, cfg.cooldownTurns);
  for (let i = 0; i < cfg.cooldownTurns; i++) engine.endTurn(S);
  assert.equal(engine.snapshotOf(S).cooldown, 0, '冷却应按轮衰减到 0');
  // 同一档位仍不出声（边沿触发，与冷却无关）
  assert.equal(engine.observe(S, p(0.52)), null);
});
