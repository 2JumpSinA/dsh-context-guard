/**
 * 「生产接线」测试（D1 / D2 回归）—— 用**真实的 `apply()`** 驱动，而不是纯引擎。
 *
 * 为什么必须是真 `apply()`：D1 与 D2 的根因都不在策略函数里，而在 `lib/index.js` 的接线：
 *   · D1：`respectCompaction` 的抑制条件里有个 `atTurnBoundary` 合取项，而**生产代码从不传它**
 *         ⇒ 开关恒不生效。`test/engine.test.mjs` 是自己显式传 `{atTurnBoundary: true, justCompacted: true}`
 *         才过的，所以从来抓不到。这里的断言只看 `onChanged → observe` 这条**真实实参**路径。
 *   · D2：`compaction/end` 的失败判定写反（0.2.0-rc.2 的失败载荷是 `error: <字符串>`，
 *         而代码写 `error !== true`）⇒ 失败压缩被当成成功。这里发**失败载荷**，断言不被抑制、不落盘。
 *
 * 依赖处理：`lib/index.js` 顶层 import 了宿主提供的 `@deepseek-ai/schemastery`，而 CI 不跑
 * `npm install`。所以先用 `module.registerHooks()` 把这个裸说明符重定向到
 * `test/fixtures/schemastery-stub.mjs`（`apply()` 完全不碰 Schema，桩只要支持链式调用）。
 * 老 Node 没有 `registerHooks` 且本机也没装依赖时，本文件整体 skip —— 绝不把 CI 拖红。
 *
 * 假 `sessionProjections`：只实现插件真的会用的三个方法（契约见复审报告 §3 的适配表）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { preBeginMarker } from '../lib/handover.mjs';

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
  hookRegistered = false; // 老 Node（< 22.15）没有 registerHooks，只能指望本机装了依赖
}

/** @type {Function|null} */
let apply = null;
let loadError = null;
try {
  ({ apply } = await import('../lib/index.js'));
} catch (error) {
  loadError = error;
}
// 桩注册成功却仍然 import 失败 ⇒ 那是**真的坏**，必须炸出来；只有当「没有 hook 且没有依赖」才 skip。
if (loadError !== null && hookRegistered) throw loadError;
const SKIP_REASON =
  loadError === null
    ? null
    : `宿主依赖 @deepseek-ai/schemastery 不可用（CI 不跑 npm install，本机也没装）⇒ 无法驱动真实 apply()：${loadError.message}`;

/** 每个用例都先确认拿到的是桩，而不是本机 node_modules 里的真包（否则「CI 无依赖」这条路没被真验证）。 */
const stubCheck = async () => {
  if (hookRegistered !== true) return;
  const mod = await import('@deepseek-ai/schemastery');
  assert.equal(mod.__STUB__, true, 'registerHooks 必须把裸说明符重定向到测试桩');
};

/** token-meter 投影形状（`readOccupancy` 只认 projectedTokens / contextWindow）。 */
const p = (ratio, window = 200_000) => ({ projectedTokens: Math.round(ratio * window), contextWindow: window });

/**
 * 用假 ctx + 假 sessionProjections 起一个真实的插件实例。
 * 假 ctx 只实现插件真的会用的那几个口子：`provide` / `get` / `on` / `inject` / `logger`。
 */
function boot(overrides = {}) {
  const handlers = new Map();
  const services = new Map();

  const projections = {
    listeners: [],
    /** 注册返回 disposer（cordis `effect` 的约定）。 */
    onChanged(listener) {
      projections.listeners.push(listener);
      return () => {};
    },
    stateOf() {
      return undefined;
    },
    snapshot() {
      return { values: {} };
    },
  };
  const sctx = {
    sessionProjections: projections,
    /** cordis 的 effect：工厂当场执行，返回值是 disposer。插件用它挂 `onChanged` 订阅。 */
    effect(factory) {
      return factory();
    },
  };

  const ctx = {
    logger: { info() {}, warn() {} },
    provide(serviceName, service) {
      services.set(serviceName, service);
    },
    get(serviceName) {
      return services.get(serviceName);
    },
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    inject(names, callback) {
      // 软依赖：本测试只让 `sessionProjections` 在场；wechatNotify / webServer 缺席时
      // 宿主根本不会调用回调 —— 这里照此办理（顺带避免真的注册 HTTP 路由）。
      if (names.includes('sessionProjections')) callback(sctx);
    },
  };

  apply(ctx, {
    enabled: true,
    respectCompaction: true,
    handoverOnWarn: false,
    ...overrides,
  });

  const engine = services.get('contextGuard');
  assert.ok(engine !== undefined, 'apply() 必须通过 ctx.provide 交出引擎');
  assert.equal(projections.listeners.length, 1, 'apply() 必须订阅一次 onChanged');

  return {
    engine,
    /** 推一次投影变化（模拟 token-meter 的 wire 更新）。 */
    project(session, value) {
      for (const fn of projections.listeners) fn(session, 'contextPressure', value);
    },
    /** 推一条日志事件（`compaction/end` 等只走 `ctx.on('session/event')`）。 */
    sessionEvent(session, event) {
      for (const fn of handlers.get('session/event') ?? []) fn(session, event);
    },
    /** 当前已播报的 banner 条数（引擎只把**真的出声**的判定记进 log）。 */
    shots() {
      return engine.recent().length;
    },
  };
}

const gate = (name, fn) =>
  test(name, async (t) => {
    if (SKIP_REASON !== null) {
      t.skip(SKIP_REASON);
      return;
    }
    await stubCheck();
    await fn(t);
  });

gate('D1 生产接线：compaction/end（成功）之后紧接的那次观测被 respectCompaction 抑制', () => {
  const h = boot({ respectCompaction: true });
  const session = { id: 'd1', cwd: tmpdir() };

  // 1) 高水位 ⇒ 出一次 banner
  h.project(session, p(0.7));
  assert.equal(h.shots(), 1, '首次跨线必须出声');

  // 2) 压缩把水位压下去 ⇒ 解除武装（这就是 compaction/summary 之后那次投影变化）
  h.project(session, p(0.2));
  assert.equal(h.engine.snapshotOf('d1').armed, false, '回落到迟滞线以下应当重新武装');

  // 3) 压缩结束 —— **成功载荷**：0.2.0-rc.2 里没有 `error` 键
  h.sessionEvent(session, { type: 'compaction/end', data: { compactionId: 'c1', turn: 3 } });

  // 4) 压缩刚结束、读数仍然偏高 ⇒ 这一次不该再喊（D1：这就是那个死开关的现场）
  h.project(session, p(0.7));
  assert.equal(h.shots(), 1, '紧跟成功压缩的那次观测必须被抑制');
  // 但状态照记：徽标要显示真数字，不能因为抑制而假装自己不高
  assert.equal(h.engine.snapshotOf('d1').level, 'hard');
  assert.equal(h.engine.snapshotOf('d1').armed, true);

  // 5) 抑制是**一次性**的：下一次观测照常出声
  h.project(session, p(0.2));
  h.project(session, p(0.7));
  assert.equal(h.shots(), 2, '抑制只能消费一次，不得变成永久静音');
});

gate('D1 对照：同一条序列但不发 compaction/end ⇒ 那次观测必须出声', () => {
  const h = boot({ respectCompaction: true });
  const session = { id: 'd1-control', cwd: tmpdir() };

  h.project(session, p(0.7));
  h.project(session, p(0.2));
  h.project(session, p(0.7));

  assert.equal(h.shots(), 2, '没有压缩这件事发生 ⇒ 抑制不成立（证明上面被抑制确实来自那次标记）');
});

gate('D2 回归：失败载荷（error 是字符串）之后那次观测不被抑制', () => {
  const h = boot({ respectCompaction: true });
  const session = { id: 'd2', cwd: tmpdir() };

  h.project(session, p(0.7)); // 出声一次
  h.project(session, p(0.2)); // 解除武装

  // 失败载荷：`errorChain(error)` 返回**字符串**（0.2.0-rc.2 实况），不是 `true`
  h.sessionEvent(session, {
    type: 'compaction/end',
    data: { compactionId: 'c2', turn: 4, error: 'summary llm failed: 429 rate limited' },
  });

  h.project(session, p(0.7));
  assert.equal(h.shots(), 2, '失败的压缩没有把水位压下来 ⇒ 该喊就喊（历史 bug：这里被静音）');
});

gate('D2 回归：失败压缩不写「压缩前快照」，成功的才写', async (t) => {
  const okDir = mkdtempSync(join(tmpdir(), 'cg-wiring-ok-'));
  const badDir = mkdtempSync(join(tmpdir(), 'cg-wiring-bad-'));
  const h = boot({ respectCompaction: true, handoverOnWarn: true, handoverPath: 'HANDOVER.md' });

  const ok = { id: 'snap-ok', cwd: okDir };
  const bad = { id: 'snap-bad', cwd: badDir };

  // 快照取的是**环形记录里的峰值**：没有先观测过就不会写
  h.project(ok, p(0.7));
  h.project(bad, p(0.7));

  h.sessionEvent(ok, { type: 'compaction/end', data: { compactionId: 'ok', turn: 5 } });
  h.sessionEvent(bad, { type: 'compaction/end', data: { compactionId: 'bad', turn: 6, error: 'commit failed' } });

  const okFile = join(okDir, 'HANDOVER.md');
  const badFile = join(badDir, 'HANDOVER.md');

  // 阳性对照：成功的压缩确实落了一份压缩前快照（证明这条接线本身是通的）
  await waitFor(() => existsSync(okFile) && readFileSync(okFile, 'utf8').includes(preBeginMarker('snap-ok')), 5_000);
  assert.ok(readFileSync(okFile, 'utf8').includes(preBeginMarker('snap-ok')), '成功压缩应写压缩前快照');

  // 阴性：失败的压缩**不该**落这个块（同一目录里可能有自动草稿块，那是另一组标记，不算数）
  await delay(300);
  const badText = existsSync(badFile) ? readFileSync(badFile, 'utf8') : '';
  assert.equal(badText.includes(preBeginMarker('snap-bad')), false, '失败压缩不该写压缩前快照');
  t.diagnostic(`bad 目录是否已有落盘文件（自动草稿块）：${existsSync(badFile)}`);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  return false;
}
