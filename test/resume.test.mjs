/**
 * 恢复/打开旧会话的补判回归（v0.4.4，2026-10-19 真机故障）。
 *
 * 故障形状：会话 2142a67a 在浏览器里徽标 67%、投影却是 `none`、banner 不弹。
 * 根因两条：
 *   1. `onResume` 只返回信号、**从不更新 `states`** ⇒ 恢复的会话引擎状态停在 none；
 *   2. 镜像 `view` 读的是注册表那份折叠态，而恢复不产生新事件 ⇒ 那份 state 停在 init。
 * 所以这里直接钉「调用 onResume 之后，状态与镜像 view 都必须是真实档位」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createGuardEngine } from '../lib/engine.mjs';
import { defaultConfig } from '../lib/policy.mjs';

const at = (percent) => ({ projectedTokens: Math.round(percent * 1_000_000), contextWindow: 1_000_000 });

test('onResume：恢复一个 67% 的会话 ⇒ 状态与镜像都是 hard', () => {
  const engine = createGuardEngine(defaultConfig());
  const hit = engine.onResume('resume-hard', at(0.67), { locale: 'zh' });
  assert.equal(hit?.signal?.level, 'hard', '≥ hardRatio 时仍要发恢复提示');
  assert.equal(engine.snapshotOf('resume-hard').level, 'hard', '状态必须被折成 hard');
  const view = engine.mirrorView({ id: 'resume-hard' });
  assert.equal(view.level, 'hard', '镜像 view 必须反映真实档位');
  assert.equal(view.ratio, 0.67);
});

test('onResume：48% 不发恢复提示，但状态与镜像必须是 warn（徽标/降档都要看见）', () => {
  const engine = createGuardEngine(defaultConfig());
  const hit = engine.onResume('resume-warn', at(0.48), { locale: 'zh' });
  assert.equal(hit, null, '低于 hardRatio 不发恢复提示（避免点开旧会话就刷通知）');
  assert.equal(engine.snapshotOf('resume-warn').level, 'warn');
  assert.equal(engine.mirrorView({ id: 'resume-warn' }).level, 'warn');
});

test('onResume：读不到占用率时什么都不改（fail-closed，不假装 0%）', () => {
  const engine = createGuardEngine(defaultConfig());
  assert.equal(engine.onResume('resume-unknown', {}, {}), null);
  assert.equal(engine.mirrorView({ id: 'resume-unknown' }).level, 'none');
  assert.equal(engine.mirrorView({ id: 'resume-unknown' }).ratio, null);
});

test('mirrorView：同值返回同一引用（注册表据此不广播）', () => {
  const engine = createGuardEngine(defaultConfig());
  engine.onResume('stable', at(0.67), {});
  const a = engine.mirrorView({ id: 'stable' });
  const b = engine.mirrorView({ id: 'stable' });
  assert.equal(a, b, '值没变就必须是同一个引用');
});
