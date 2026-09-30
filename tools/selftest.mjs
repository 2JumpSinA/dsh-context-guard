/**
 * 用**假 ctx** 真跑一遍 `apply()`。
 *
 * 这一步证明的是「契约与装配」：能 import（真机上 `@deepseek-ai/schemastery` 必须解析得到）、
 * `Config` 是 schemastery 且每个字段都 volatile、`inject` 不硬依赖任何服务、
 * 软 inject 在 `sessionProjections` 缺席与在场两种情况下都不炸、事件分派认 `turn/end`。
 *
 * 它**不**证明「被 profile 真装载」—— 那一步只能在真机里证（见 tools/probe-real-load.mjs）。
 *
 * 跑法：`node tools/selftest.mjs`（退出码即结论）
 */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beginMarker } from '../lib/handover.mjs';

const require = createRequire(import.meta.url);
let mod;
try {
  mod = await import('../lib/index.js');
} catch (error) {
  console.log(`FAIL: lib/index.js 载入失败 —— ${error.message}`);
  process.exit(1);
}

const fails = [];
const ok = [];
const check = (name, condition, detail = '') => {
  if (condition) ok.push(name);
  else fails.push(`${name}${detail ? ` —— ${detail}` : ''}`);
};

/** 最小假 ctx：只实现本插件真的会调的成员，多一个都不实现（避免测出幻觉 API）。 */
function fakeCtx({ withProjections = true, withWebServer = false, withWechat = false, wechatReplies = true } = {}) {
  const services = new Map();
  const handlers = new Map();
  const injected = [];
  const effects = [];
  const logs = [];
  const subscribed = [];
  /** 路由表：path → route（宿主状态路由的验收面）。 */
  const routes = new Map();
  /** 外推通道收到的每一条正文（推送的验收面）。 */
  const wechatCalls = [];
  const webServer = withWebServer
    ? {
        register(route) {
          if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      }
    : undefined;
  const wechatNotify = withWechat
    ? {
        send(message) {
          wechatCalls.push(String(message));
          // `wechatReplies: false` 用来模拟「通道在、但发送失败」（fail-soft 路径）。
          return Promise.resolve(wechatReplies ? { ok: true } : { ok: false, code: 'send-failed', detail: '假通道故障' });
        },
      }
    : undefined;
  const ctx = {
    logger: Object.assign((name) => ctx.logger, {
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]),
    }),
    provide(name, value) {
      services.set(name, value);
    },
    get(name) {
      if (name === 'sessionProjections') return withProjections ? services.get('sessionProjections') : undefined;
      if (name === 'webServer') return webServer;
      if (name === 'wechatNotify') return wechatNotify;
      return services.get(name);
    },
    on(name, listener) {
      const list = handlers.get(name) ?? [];
      list.push(listener);
      handlers.set(name, list);
      return () => {};
    },
    effect(fn, label) {
      // cordis 的 effect 语义：**立即执行** fn，收集它返回的 disposer。
      // 假 ctx 必须照做，否则「效果里的订阅」永远不会发生，测出来是假阴性。
      effects.push([label, fn]);
      const disposer = typeof fn === 'function' ? fn() : undefined;
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    inject(names, cb) {
      injected.push(names);
      // 注入后的子 ctx：`@deepseek-ai/dsh-session-projection` 的文档形态是
      // `ctx.inject(['sessionProjections'], (sctx) => …)` 里直接读 `sctx.sessionProjections`。
      // 这里就把服务挂在友元对象上，别去 spread 整个 ctx（会把 logger 这类成员搞坏）。
      const child = Object.create(ctx);
      child.sessionProjections = withProjections ? services.get('sessionProjections') : undefined;
      child.webServer = webServer;
      child.wechatNotify = wechatNotify;
      child.effect = ctx.effect;
      cb(child);
    },
  };
  return { ctx, services, handlers, injected, effects, logs, subscribed, routes, wechatCalls, webServer, wechatNotify };
}

const session = (id) => ({ id, header: { id } });

// —— 1. Config 契约
const { Config, name, inject, apply, normalizeConfig, createGuardEngine, STATE_ROUTE } = mod;
check('name 存在', typeof name === 'string' && name.length > 0);
check('inject 是数组且不硬依赖 sessionProjections', Array.isArray(inject) && !inject.includes('sessionProjections'), `inject=${JSON.stringify(inject)}`);
check('Config 是 schemastery 节点（有 toJSON）', Boolean(Config) && typeof Config.toJSON === 'function');
try {
  const json = Config.toJSON();
  // schemastery 的 toJSON 是 `{uid, refs}`：refs 里每个节点带 `meta`。
  const refs = json.refs ?? {};
  // refs 里每个节点带 `meta`；uid 55 是根 object（模板形态），字段节点是 boolean/number。
  const nodes = Object.values(refs).filter((node) => node?.type === 'boolean' || node?.type === 'number' || node?.type === 'string');
  check('Config 至少 10 个字段', nodes.length >= 10, `实际 ${nodes.length}`);
  const volatileCount = nodes.filter((node) => node?.meta?.volatile === true).length;
  check(
    '所有字段都标了 volatile（否则 dsh-settings 不生成设置页）',
    volatileCount === nodes.length,
    `volatile ${volatileCount} / 共 ${nodes.length}`,
  );
  const described = nodes.filter((node) => typeof node?.meta?.description === 'string' && node.meta.description.length > 0).length;
  check('每个字段都有人话 description', described === nodes.length, `${described} / ${nodes.length}`);
} catch (error) {
  check('Config.toJSON() 可读', false, error.message);
}

// —— 2. normalizeConfig 收敛
// 出厂默认值以 policy.mjs 为唯一真相源：这里**不写死数字**，避免「默认值改了、断言留在旧值」。
const FACTORY = normalizeConfig({});
const normalized = normalizeConfig({ warnRatio: 0.9, hardRatio: 0.8, hysteresisRatio: 5 });
check('normalizeConfig 保证 hard > warn', normalized.hardRatio > normalized.warnRatio, JSON.stringify(normalized));
check('normalizeConfig 夹取迟滞上限', normalized.hysteresisRatio <= 0.2);
check('normalizeConfig 兜住非数字', normalizeConfig({ warnRatio: 'x' }).warnRatio === FACTORY.warnRatio, JSON.stringify(FACTORY));

// —— 2b. **volatile 引用**：DSH 交给插件的是引用对象，不摊平就会静默用默认值（真事故）
{
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
  let warn = 0.33;
  const ref = (get) => Object.freeze({ get, [VOLATILE_WRITE]: () => {} });
  const raw = {
    warnRatio: ref(() => warn),
    hardRatio: ref(() => 0.44),
    pushChannel: ref(() => 'wechat'),
    pushCooldownMinutes: ref(() => 30),
    enabled: ref(() => false),
  };
  const resolved = normalizeConfig(raw);
  check(
    'volatile 引用被摊平（否则 apply 拿到的是默认值）',
    resolved.warnRatio === 0.33 && resolved.hardRatio === 0.44 && resolved.pushChannel === 'wechat' && resolved.enabled === false,
    JSON.stringify({ warn: resolved.warnRatio, hard: resolved.hardRatio, push: resolved.pushChannel, enabled: resolved.enabled }),
  );
  warn = 0.5;
  check('同一引用第二次读拿到新值（设置改完立即生效的前提）', normalizeConfig(raw).warnRatio === 0.5);
  check('不认识的通道仍然退回 none', normalizeConfig({ pushChannel: ref(() => 'telepathy') }).pushChannel === 'none');
}

// —— 3. 无 sessionProjections 时也能挂（软依赖）
{
  const { ctx, logs, services } = fakeCtx({ withProjections: false });
  try {
    apply(ctx, {});
    check('sessionProjections 缺席时 apply 不抛', true);
    check('缺席时留下「已挂载」日志', logs.some(([lvl, m]) => lvl === 'info' && m.includes('已挂载')), JSON.stringify(logs));
    check('provide 了 contextGuard 服务', services.has('contextGuard'));
  } catch (error) {
    check('sessionProjections 缺席时 apply 不抛', false, error.message);
  }
}

// —— 4. sessionProjections 在场：订阅、喂观测、事件分派
{
  let changeListener = null;
  const projections = {
    onChanged(listener) {
      changeListener = listener;
      return () => {
        changeListener = null;
      };
    },
    snapshot(_session, _keys) {
      return { asOfSeq: 0, values: { contextPressure: { projectedTokens: 170_000, contextWindow: 200_000 } } };
    },
  };
  const { ctx, services, handlers, logs } = fakeCtx();
  services.set('sessionProjections', projections);
  apply(ctx, { cooldownTurns: 0 });
  check('订阅了 onChanged', typeof changeListener === 'function');

  const engine = services.get('contextGuard');
  check('contextGuard 服务面齐全', ['observe', 'endTurn', 'onResume', 'snapshotOf', 'recent', 'resetArming'].every((k) => typeof engine[k] === 'function'));

  // 下面四条的占比**从出厂阈值推导**（改默认值不必改测试）
  const W = FACTORY.warnRatio;
  const HARD = FACTORY.hardRatio;
  const MID = (W + HARD) / 2;
  const px = (r) => ({ projectedTokens: Math.round(r * 200_000), contextWindow: 200_000 });

  // 阈值以下：不响
  changeListener(session('s1'), 'contextPressure', px(W / 2));
  check('低水位不产生判定', engine.recent().length === 0, JSON.stringify(engine.recent()));

  // 跨 warn：响一次（落在 warn 与 hard 之间）
  changeListener(session('s1'), 'contextPressure', px(MID));
  check('跨 warn 产生一条判定', engine.recent().length === 1, JSON.stringify(engine.recent()));
  check('判定落在 warn 档', engine.recent()[0]?.level === 'warn');
  check('判定写进了 warn 日志', logs.some(([lvl, m]) => lvl === 'warn' && m.includes('上下')));

  // 同级重复：不响（仍未到 hard）
  changeListener(session('s1'), 'contextPressure', px(MID + 0.02));
  check('同级重复不产生新判定', engine.recent().length === 1, JSON.stringify(engine.recent()));

  // 升 hard：再响
  changeListener(session('s1'), 'contextPressure', { projectedTokens: 170_000, contextWindow: 200_000 });
  check('升级到 hard 产生新判定', engine.recent().length === 2);
  check('最新判定是 hard', engine.recent()[0]?.level === 'hard');

  // 无数据不能响
  changeListener(session('s2'), 'contextPressure', {});
  check('无分母的会话不产生判定', engine.recent().length === 2, JSON.stringify(engine.recent().map((r) => r.sessionId)));

  // —— 事件分派：turn/end 走日志事件，不是 ctx.on 直挂
  check('不直接把 turn/end 挂到 ctx.on', !handlers.has('turn/end'), JSON.stringify([...handlers.keys()]));
  check('挂了 session/event', handlers.has('session/event'));
  check('挂了 session/created', handlers.has('session/created'));

  const before = engine.snapshotOf('s1').turn;
  for (const listener of handlers.get('session/event')) {
    listener(session('s1'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  }
  check('turn/end 推进轮计数', engine.snapshotOf('s1').turn === before + 1, `before=${before}`);

  // 未知事件类型不许炸
  try {
    for (const listener of handlers.get('session/event')) {
      listener(session('s1'), { type: '完全不认识的事件', data: {} });
      listener(session('s1'), undefined);
    }
    check('未知/畸形事件被忽略而不抛', true);
  } catch (error) {
    check('未知/畸形事件被忽略而不抛', false, error.message);
  }

  // compaction/end 记一笔
  for (const listener of handlers.get('session/event')) {
    listener(session('s1'), { type: 'compaction/end', data: { compactionId: 'c1', turn: 1 } });
  }
  check('compaction/end 记下「水位刚被压过」', engine.snapshotOf('s1').cooldown >= 0);

  // 路由变化解除武装
  engine.resetArming('s1');
  check('resetArming 后回到 none', engine.snapshotOf('s1').level === 'none' && engine.snapshotOf('s1').armed === false);

  // session/created 用 snapshot 做恢复判定。
  // ⚠️ 恢复提示**不进 `recent()`**（那是「跨越阈值」的流水），只写日志 —— 断言就看日志，
  // 且要确认它没有被误记成一条「跨越」。
  const beforeResume = engine.recent().length;
  const warnBefore = logs.filter(([lvl]) => lvl === 'warn').length;
  for (const listener of handlers.get('session/created')) {
    listener(session('s3'));
  }
  const warnAfter = logs.filter(([lvl]) => lvl === 'warn').length;
  check(
    '恢复一个高水位会话会立刻判定（写日志、不污染跨越流水）',
    warnAfter === warnBefore + 1 && engine.recent().length === beforeResume,
    `warn ${warnBefore}->${warnAfter}, recent ${beforeResume}->${engine.recent().length}`,
  );
  check(
    '恢复提示指向交接文档',
    logs.filter(([lvl]) => lvl === 'warn').at(-1)?.[1]?.includes('HANDOVER.md') === true,
    String(logs.filter(([lvl]) => lvl === 'warn').at(-1)?.[1]).slice(0, 120),
  );

  // 恢复判定在 onResume=false 时必须闭嘴
  {
    const { ctx: ctx2, services: services2 } = fakeCtx();
    services2.set('sessionProjections', projections);
    apply(ctx2, { cooldownTurns: 0, onResume: false });
    check('onResume=false 时不判定恢复', services2.get('contextGuard').recent().length === 0);
  }

  // 抛出也不许外溢（session/created 是同步 emit，抛了会回滚创建）
  try {
    const badCtx = fakeCtx().ctx;
    const badProjections = {
      onChanged: () => () => {},
      snapshot: () => {
        throw new Error('boom');
      },
    };
    badCtx.get = (n) => (n === 'sessionProjections' ? badProjections : undefined);
    const badMod = createGuardEngine(normalizeConfig({}));
    const handler = (s) => badMod.onResume(String(s.id), { projectedTokens: 1, contextWindow: 1 });
    try {
      handler(session('s9'));
      check('onResume 自己内部不抛（异常由 apply 层兜）', true);
    } catch (error) {
      check('onResume 自己内部不抛（异常由 apply 层兜）', false, error.message);
    }
  } catch (error) {
    check('onResume 自己内部不抛（异常由 apply 层兜）', false, error.message);
  }
}

// —— 5. enabled=false 时不出提示
{
  const { ctx, services } = fakeCtx();
  let listener = null;
  services.set('sessionProjections', {
    onChanged(l) {
      listener = l;
      return () => {};
    },
    snapshot: () => ({ asOfSeq: 0, values: {} }),
  });
  apply(ctx, { enabled: false });
  listener(session('x'), 'contextPressure', { projectedTokens: 190_000, contextWindow: 200_000 });
  check('enabled=false 时不产生判定', services.get('contextGuard').recent().length === 0);
}

// —— 6. 宿主状态路由 + 外推推送（§14.5 的两件事，逐条证伪）
{
  /** 假响应：只收集状态码/头/正文。 */
  const fakeRes = () => {
    const out = { status: 0, headers: null, body: '' };
    return {
      out,
      writeHead(status, headers) {
        out.status = status;
        out.headers = headers;
      },
      end(body) {
        out.body = String(body);
      },
    };
  };

  /** 取一次路由 JSON（走真的 handler，不 mock 我们的逻辑）。 */
  const stateOf = (routes) => {
    const route = routes.get(STATE_ROUTE);
    const res = fakeRes();
    route.handler({ url: STATE_ROUTE }, res);
    return { status: res.out.status, headers: res.out.headers, payload: JSON.parse(res.out.body) };
  };

  /**
   * ⚠️ **没有 `wire` 的键在真机上收不到任何 `onChanged`**（2026-09-30 修正，代价是一轮代码审查）。
   *
   * `dsh-session-projection` 的 `drive()` 是这么投递的：
   * `const wire = registration.def.wire; if (changed && wire !== void 0) { …listener(session, key, value, seq) }`
   * —— 只有声明了 `wire` 的单元才上线。实测 `titleInput`（dsh-session-title）的注册**没有 `wire`**
   * （同文件的 `title` 有：`wire: { viewSchema, view: state => state }`），所以它只能从
   * 注册表的宿主状态真源 `stateOf()` 读。
   *
   * 这个假 harness 一开始对**所有**键一视同仁地投递，于是「宿主按会话首条输入猜语言」在真机上
   * 根本不成立，而这里的断言照样全绿 —— **一条假绿**。镜像真实语义是这条测试有判别力的前提，
   * 别再把 `WIRELESS` 删掉或改回去。
   */
  const WIRELESS = new Set(['titleInput']);

  const projectionsFor = () => {
    let listener = null;
    /**
     * 宿主状态真源：真实注册表的 `stateOf(session, key)` 返回**单元状态**，
     * 比 onChanged 送来的 **wire 视图**更全（dsh-context 的 slim head 把 fileOps 砍掉了）。
     */
    const states = new Map();
    const projections = {
      onChanged(l) {
        listener = l;
        return () => {
          listener = null;
        };
      },
      snapshot: () => ({ asOfSeq: 0, values: {} }),
      stateOf: (_session, key) => states.get(key),
    };
    // 第 4 个参数是**宿主状态**（与 wire 视图不同时给）：不给就与 wire 同值。
    return {
      projections,
      fire: (s, p, key = 'contextPressure', state) => {
        if (state !== undefined) states.set(key, state);
        else if (!states.has(key)) states.set(key, p);
        // 镜像真机：无 wire 的键只进真源，**不投 onChanged**
        if (WIRELESS.has(key)) return;
        listener(s, key, p);
      },
    };
  };

  // 6a. 路由本体
  {
    const { projections } = projectionsFor();
    const { ctx, services, routes } = fakeCtx({ withWebServer: true });
    services.set('sessionProjections', projections);
    apply(ctx, { pushChannel: 'wechat', pushCooldownMinutes: 10 });
    check('注册了宿主状态路由（client 半边读真源的通路）', routes.has(STATE_ROUTE), JSON.stringify([...routes.keys()]));

    const state = stateOf(routes);
    check('状态路由返回 200 + JSON', state.status === 200 && /application\/json/.test(state.headers?.['Content-Type'] ?? ''), JSON.stringify(state.headers));
    check('状态路由禁止缓存', state.headers?.['Cache-Control'] === 'no-store');
    check('状态路由带归一化后的真源配置', state.payload?.config?.pushChannel === 'wechat' && state.payload?.config?.warnRatio === FACTORY.warnRatio, JSON.stringify(state.payload?.config));
    check('状态路由带趋势与最近判定', state.payload?.trend !== undefined && Array.isArray(state.payload?.recent), JSON.stringify(Object.keys(state.payload ?? {})));
    check('状态路由带推送状态面', state.payload?.push?.channel === 'wechat', JSON.stringify(state.payload?.push));

    // 路由不能因为宿主状态畸形就把响应挂死
    const res = fakeRes();
    let threw = false;
    try {
      routes.get(STATE_ROUTE).handler({ url: STATE_ROUTE }, res);
    } catch (error) {
      threw = true;
    }
    check('状态路由自己从不抛（抛了会把响应挂死）', threw === false && res.out.status === 200);
  }

  // 6b. 推送：开通道 + hard 跨档 ⇒ 真发一条，且正文含交接文档
  {
    const { projections, fire } = projectionsFor();
    const { ctx, services, routes, wechatCalls } = fakeCtx({ withWebServer: true, withWechat: true });
    services.set('sessionProjections', projections);
    apply(ctx, { pushChannel: 'wechat', pushCooldownMinutes: 0 });
    fire(session('p1'), { projectedTokens: 170_000, contextWindow: 200_000 });
    await new Promise((r) => setTimeout(r, 0));
    check('hard 跨档触发外推推送', wechatCalls.length === 1, JSON.stringify(wechatCalls));
    check('推送正文带交接文档与占比', /HANDOVER\.md/.test(wechatCalls[0] ?? '') && /85%/.test(wechatCalls[0] ?? ''), String(wechatCalls[0]).slice(0, 160));
    const state = stateOf(routes);
    check('推送结果记进状态路由（sent=1）', state.payload?.push?.sent === 1 && state.payload?.push?.lastResult?.ok === true, JSON.stringify(state.payload?.push));

    // warn 档（低于 pushMinLevel 的默认 hard）不许推
    fire(session('p1'), { projectedTokens: 130_000, contextWindow: 200_000 });
    await new Promise((r) => setTimeout(r, 0));
    check('低于 pushMinLevel 的档不外推', wechatCalls.length === 1, `calls=${wechatCalls.length}`);
  }

  // 6c. 推送：默认关（通道 none）⇒ 一条都不发
  {
    const { projections, fire } = projectionsFor();
    const { ctx, services, wechatCalls } = fakeCtx({ withWebServer: true, withWechat: true });
    services.set('sessionProjections', projections);
    apply(ctx, {});
    fire(session('p2'), { projectedTokens: 190_000, contextWindow: 200_000 });
    await new Promise((r) => setTimeout(r, 0));
    check('默认 pushChannel=none 时一条都不推', wechatCalls.length === 0, JSON.stringify(wechatCalls));
  }

  // 6d. 推送：分钟级冷却挡住同一时刻的第二个会话
  {
    const { projections, fire } = projectionsFor();
    const { ctx, services, wechatCalls } = fakeCtx({ withWebServer: true, withWechat: true });
    services.set('sessionProjections', projections);
    apply(ctx, { pushChannel: 'wechat', pushCooldownMinutes: 10 });
    fire(session('p3'), { projectedTokens: 170_000, contextWindow: 200_000 });
    fire(session('p4'), { projectedTokens: 180_000, contextWindow: 200_000 });
    await new Promise((r) => setTimeout(r, 0));
    check('冷却窗口内第二个会话不再推', wechatCalls.length === 1, `calls=${wechatCalls.length}`);
  }

  // 6e. 推送：通道缺席 / 发送失败都必须 fail-soft（不抛、只记状态）
  {
    const { projections, fire } = projectionsFor();
    const { ctx, services, routes } = fakeCtx({ withWebServer: true });
    services.set('sessionProjections', projections);
    apply(ctx, { pushChannel: 'wechat', pushCooldownMinutes: 0 });
    let threw = false;
    try {
      fire(session('p5'), { projectedTokens: 170_000, contextWindow: 200_000 });
      await new Promise((r) => setTimeout(r, 0));
    } catch (error) {
      threw = true;
    }
    const state = stateOf(routes);
    check('通道缺席时不抛（fail-soft）', threw === false);
    check('通道缺席记成 channel-absent 并计入 failed', state.payload?.push?.lastResult?.code === 'channel-absent' && state.payload?.push?.failed === 1, JSON.stringify(state.payload?.push));
  }

  // 6f. 自动交接草稿：跨 warn 起草 → 步进刷新（幂等）→ 写失败 fail-soft
  {
    const dir = mkdtempSync(join(tmpdir(), 'guard-handover-'));
    const target = join(dir, 'HANDOVER.md');
    const { projections, fire } = projectionsFor();
    const { ctx, services, routes } = fakeCtx({ withWebServer: true });
    services.set('sessionProjections', projections);
    apply(ctx, { handoverOnWarn: true, handoverPath: 'HANDOVER.md', handoverRefreshPercent: 5, handoverTurns: 2, handoverFiles: 3 });

    // 会话自带工作目录（真实来源：session.header.cwd）
    const s = { id: 'h1', header: { id: 'h1', cwd: dir, createdAt: Date.now() } };
    // 素材由各自的投影送来（判定只认 contextPressure，这些只为草稿服务）
    fire(s, { calls: 42, cost: 1.234, lastActivity: Date.now() }, 'tokenCost');
    fire(s, { turns: 7, steps: 40 }, 'sessionStats');
    fire(s, { text: '阈值校准' }, 'title');
    // ⚠️ 真实形状（2026-09-30 第十一棒真机核实）：`contextTimeline` 的 **wire 视图**是
    // dsh-context 的 slim head —— 有 contextWindow / timing，**没有 fileOps**；含 fileOps 的
    // 重集合只在**宿主状态**里（只有注册表 `stateOf` 拿得到）。`turnOutline` 同理：wire 是数组，
    // 状态才是 `{turns, draft}`。夹具按真实形状造 ⇒ 只读 onChanged 的实现会在这里挂。
    const timelineHead = {
      contextWindow: 1_000_000,
      timing: { toolCalls: 12, tools: { pwsh: { calls: 9 }, edit: { calls: 3 } } },
      counts: { turns: 1, steps: 7 },
      detailRev: 9,
    };
    const timelineState = {
      ...timelineHead,
      fileOps: [{ kind: 'write', tool: 'edit', path: 'lib/policy.mjs', added: 6, removed: 2, time: Date.now() }],
    };
    fire(s, timelineHead, 'contextTimeline', timelineState);
    const lastTurn = { turn: 7, prompt: '把阈值改掉', response: '改完了' };
    fire(s, [lastTurn], 'turnOutline', { turns: [lastTurn], draft: '' });
    check('夹具忠实：wire 视图（slim head）里确实没有 fileOps', timelineHead.fileOps === undefined);

    // 40%：低于 warn ⇒ 不起草
    fire(s, { projectedTokens: 400_000, contextWindow: 1_000_000 });
    await new Promise((r) => setTimeout(r, 30));
    check('低于 warn 不起草交接', existsSync(target) === false);

    // 46%：跨过 warn ⇒ 起草
    fire(s, { projectedTokens: 460_000, contextWindow: 1_000_000 });
    await new Promise((r) => setTimeout(r, 60));
    const first = existsSync(target) ? readFileSync(target, 'utf8') : '';
    check('跨过 warn 自动起草交接', first.includes(beginMarker('h1')) && first.includes('46.0%'), first.slice(0, 140));
    check('草稿带「改过的文件」（只有走 stateOf 才拿得到 fileOps）', first.includes('lib/policy.mjs'));
    check('草稿带最近一轮诉求/回应（turnOutline 的 wire 是数组）', first.includes('把阈值改掉') && first.includes('改完了'));
    check('草稿带花费（来自 tokenCost）', first.includes('¥1.23'));

    // 48%：不足一个步进（5 点）⇒ 不重写
    fire(s, { projectedTokens: 480_000, contextWindow: 1_000_000 });
    await new Promise((r) => setTimeout(r, 40));
    check('不足一个步进不重写', (readFileSync(target, 'utf8').match(/dsh-context-guard:begin/g) ?? []).length === 1);

    // 52%：走出一个步进 ⇒ 刷新同一块（仍然只有一块）
    fire(s, { projectedTokens: 520_000, contextWindow: 1_000_000 });
    await new Promise((r) => setTimeout(r, 60));
    const refreshed = readFileSync(target, 'utf8');
    check(
      '走出一个步进后刷新同一块（幂等，不追加第二块）',
      (refreshed.match(/dsh-context-guard:begin/g) ?? []).length === 1 && refreshed.includes('52.0%'),
      refreshed.slice(0, 120),
    );
    const st = stateOf(routes);
    check('状态路由暴露交接状态', st.payload?.handover?.written >= 2 && st.payload?.handover?.failed === 0, JSON.stringify(st.payload?.handover));

    // 关掉开关 ⇒ 一条都不写
    const { projections: p2, fire: fire2 } = projectionsFor();
    const { ctx: ctx2, services: svc2 } = fakeCtx();
    svc2.set('sessionProjections', p2);
    apply(ctx2, { handoverOnWarn: false, handoverPath: join(dir, 'OFF.md') });
    fire2({ id: 'h2', header: { id: 'h2', cwd: dir } }, { projectedTokens: 600_000, contextWindow: 1_000_000 });
    await new Promise((r) => setTimeout(r, 40));
    check('handoverOnWarn=false 时不起草', existsSync(join(dir, 'OFF.md')) === false);

    // 写失败（把路径指到目录）⇒ 不抛、只记状态
    const { projections: p3, fire: fire3 } = projectionsFor();
    const { ctx: ctx3, services: svc3 } = fakeCtx();
    svc3.set('sessionProjections', p3);
    apply(ctx3, { handoverOnWarn: true, handoverPath: dir });
    let threw3 = false;
    try {
      fire3({ id: 'h3', header: { id: 'h3', cwd: dir } }, { projectedTokens: 500_000, contextWindow: 1_000_000 });
      await new Promise((r) => setTimeout(r, 60));
    } catch {
      threw3 = true;
    }
    check('交接写失败不抛（fail-soft）', threw3 === false);

    // 没有 cwd ⇒ 跳过（不往不知名的地方写文件）
    const { projections: p4, fire: fire4 } = projectionsFor();
    const { ctx: ctx4, services: svc4 } = fakeCtx();
    svc4.set('sessionProjections', p4);
    apply(ctx4, { handoverOnWarn: true, handoverPath: 'SHOULD-NOT-EXIST.md' });
    let threw4 = false;
    try {
      fire4({ id: 'h4', header: { id: 'h4' } }, { projectedTokens: 500_000, contextWindow: 1_000_000 });
      await new Promise((r) => setTimeout(r, 40));
    } catch {
      threw4 = true;
    }
    check('拿不到 cwd 时跳过而不是乱写（fail-soft）', threw4 === false && existsSync(join(process.cwd(), 'SHOULD-NOT-EXIST.md')) === false);
  }

  {
    const { projections, fire } = projectionsFor();
    const { ctx, services, routes } = fakeCtx({ withWebServer: true, withWechat: true, wechatReplies: false });
    services.set('sessionProjections', projections);
    apply(ctx, { pushChannel: 'wechat', pushCooldownMinutes: 0 });
    fire(session('p6'), { projectedTokens: 170_000, contextWindow: 200_000 });
    await new Promise((r) => setTimeout(r, 0));
    const state = stateOf(routes);
    check('发送失败只记状态、不外溢异常', state.payload?.push?.lastResult?.code === 'send-failed' && state.payload?.push?.failed === 1, JSON.stringify(state.payload?.push));
  }

  // 6f. 无 webServer 服务时不许炸（软依赖）
  {
    const { projections, fire } = projectionsFor();
    const { ctx, services, logs } = fakeCtx({ withWebServer: false });
    services.set('sessionProjections', projections);
    apply(ctx, {});
    fire(session('p7'), { projectedTokens: 170_000, contextWindow: 200_000 });
    check('没有 webServer 时 apply 不抛', true);
    check('没有 webServer 时留下降级日志', logs.some(([lvl, m]) => lvl === 'warn' && m.includes('默认值')), JSON.stringify(logs.filter(([l]) => l === 'warn')));
  }

  // 6g. 双语（§19.6）：宿主半边的语言按「该会话首条用户输入」推断，显式设置压过它
  {
    const dir = mkdtempSync(join(tmpdir(), 'guard-i18n-'));
    const target = join(dir, 'HANDOVER.md');
    const { projections, fire } = projectionsFor();
    const { ctx, services, routes } = fakeCtx({ withWebServer: true });
    services.set('sessionProjections', projections);
    apply(ctx, { handoverOnWarn: true, handoverPath: 'HANDOVER.md' });

    const s = { id: 'en1', header: { id: 'en1', cwd: dir, createdAt: Date.now() } };
    // ⚠️ 语言线索就是这条：`titleInput` 的**宿主状态**（`{ first: { seq, text } }`）。
    //    它**没有 `wire`** ⇒ 真机上只进 `stateOf`，`onChanged` 永远不投它 ——
    //    假 harness 已镜像该语义（见 `WIRELESS`），所以下面这条断言在真机才成立。
    fire(s, { first: { text: 'explain how the threshold was calibrated' } }, 'titleInput');
    fire(s, { text: 'threshold calibration' }, 'title');
    fire(s, { projectedTokens: 500_000, contextWindow: 1_000_000 });
    await new Promise((r) => setTimeout(r, 60));
    const block = existsSync(target) ? readFileSync(target, 'utf8') : '';
    check(
      '首条输入是英文的会话 ⇒ 草稿块整块英文（线索只能走 stateOf）',
      block.includes('Auto handoff draft') && !/[\u3400-\u4dbf\u4e00-\u9fff]/.test(block),
      block.slice(0, 140),
    );
    check(
      '英文草稿照样是「机器事实 + 待补空槽」',
      block.includes('| Item | Value |') && block.includes('**50.0%**') && block.includes('**To fill in (by the agent)**'),
      block.slice(0, 200),
    );

    const st = stateOf(routes);
    check('状态路由把 locale 交给 client 半边（默认 auto）', st.payload?.config?.locale === 'auto', JSON.stringify(st.payload?.config?.locale));

    // 显式 `locale: 'zh'` 必须压过「首条输入是英文」的推断
    const { projections: p2, fire: fire2 } = projectionsFor();
    const { ctx: ctx2, services: svc2 } = fakeCtx();
    svc2.set('sessionProjections', p2);
    apply(ctx2, { handoverOnWarn: true, handoverPath: join(dir, 'ZH.md'), locale: 'zh' });
    const s2 = { id: 'en2', header: { id: 'en2', cwd: dir, createdAt: Date.now() } };
    fire2(s2, { first: { text: 'english first message' } }, 'titleInput');
    fire2(s2, { projectedTokens: 500_000, contextWindow: 1_000_000 });
    await new Promise((r) => setTimeout(r, 60));
    const zhBlock = existsSync(join(dir, 'ZH.md')) ? readFileSync(join(dir, 'ZH.md'), 'utf8') : '';
    check('显式 locale=zh 压过会话语言推断', zhBlock.includes('自动交接草稿'), zhBlock.slice(0, 120));

    // 判别力检查：**拿掉语言线索**（不喂 `titleInput` 真源）⇒ 必须退回 zh。
    // 没有这一条，上面那句「英文草稿」可能只是碰巧（例如 harness 又偷偷投递了）。
    const { projections: p3, fire: fire3 } = projectionsFor();
    const { ctx: ctx3, services: svc3 } = fakeCtx();
    svc3.set('sessionProjections', p3);
    apply(ctx3, { handoverOnWarn: true, handoverPath: join(dir, 'NOLEAD.md') });
    fire3({ id: 'en3', header: { id: 'en3', cwd: dir, createdAt: Date.now() } }, { projectedTokens: 500_000, contextWindow: 1_000_000 });
    await new Promise((r) => setTimeout(r, 60));
    const noLead = existsSync(join(dir, 'NOLEAD.md')) ? readFileSync(join(dir, 'NOLEAD.md'), 'utf8') : '';
    check('拿不到语言线索 ⇒ 退回 zh（兜底不惊动现有用户）', noLead.includes('自动交接草稿'), noLead.slice(0, 120));
  }

  // 6h. 逃生阀：没有会话线索时（挂载日志 / 设置页）听 `DSH_CONTEXT_GUARD_LOCALE`
  {
    process.env.DSH_CONTEXT_GUARD_LOCALE = 'en';
    try {
      const { ctx, logs } = fakeCtx();
      apply(ctx, {});
      check(
        'DSH_CONTEXT_GUARD_LOCALE=en ⇒ 挂载日志是英文',
        logs.some(([lvl, m]) => lvl === 'info' && m.includes('mounted:')),
        JSON.stringify(logs.slice(0, 2)),
      );
    } finally {
      delete process.env.DSH_CONTEXT_GUARD_LOCALE;
    }
  }
}

console.log(`通过 ${ok.length} 项`);
if (fails.length > 0) {
  console.log(`失败 ${fails.length} 项：`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PASS: 假 ctx 契约测试全绿');
