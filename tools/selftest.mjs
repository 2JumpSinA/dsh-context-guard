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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
      // v0.6.7：按注入名把服务挂上去（`ctx.inject(['compaction'], …)` 也要能读到）。
      for (const n of names) child[n] = services.get(n);
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
const { Config, name, inject, apply, normalizeConfig, createGuardEngine, STATE_ROUTE, COMPACT_ROUTE, DRAFT_ROUTE } = mod;
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
    apply(ctx, {});
    check('注册了宿主状态路由（client 半边读真源的通路）', routes.has(STATE_ROUTE), JSON.stringify([...routes.keys()]));

    const state = stateOf(routes);
    check('状态路由返回 200 + JSON', state.status === 200 && /application\/json/.test(state.headers?.['Content-Type'] ?? ''), JSON.stringify(state.headers));
    check('状态路由禁止缓存', state.headers?.['Cache-Control'] === 'no-store');
    check('状态路由带归一化后的真源配置', state.payload?.config?.warnRatio === FACTORY.warnRatio, JSON.stringify(state.payload?.config));
    check(
      '状态路由带最近判定 + 账本计数（push/trend 已删除）',
      Array.isArray(state.payload?.recent) &&
        state.payload?.ledger !== undefined &&
        state.payload?.push === undefined &&
        state.payload?.trend === undefined,
      JSON.stringify(Object.keys(state.payload ?? {})),
    );

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

  // 6a2. v0.6.2：压缩点来源 —— 服务在场就按 DSH 解析后的配置给「精确」态
  {
    const { projections, fire } = projectionsFor();
    const { ctx, services, handlers } = fakeCtx({});
    services.set('sessionProjections', projections);
    services.set('compaction', { config: { auto: true, thresholdRatio: 0.8, headroomTokens: 65536, modelPolicies: [] } });
    apply(ctx, {});
    const s = session('cfg1');
    fire(s, { projectedTokens: 400_000, contextWindow: 1_000_000 });
    for (const listener of handlers.get('session/event') ?? []) {
      listener(s, {
        type: 'request/header',
        data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 256_000 } } },
      });
    }
    const view = services.get('contextGuard').mirrorView({ id: 'cfg1' });
    check(
      '压缩点来源：读到 DSH 已解析配置 ⇒ config 且 67.8%',
      view.compactBasis === 'config' && view.compactPercent === 67.8,
      JSON.stringify(view),
    );
    check('环境指纹：modelTag 为 provider/model', view.modelTag === 'deepseek-official/deepseek-flash', String(view.modelTag));
  }

  // 6a3. v0.6.4（真机：硬档正文没有数字）：请求头缺 `maxTokens` 时必须回落到适配器默认值
  {
    const { projections, fire } = projectionsFor();
    const { ctx, services, handlers } = fakeCtx({});
    services.set('sessionProjections', projections);
    services.set('compaction', { config: { auto: true, thresholdRatio: 0.8, headroomTokens: 65536, modelPolicies: [] } });
    services.set('llm', { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 }, defaultMaxTokens: 256_000 }) });
    apply(ctx, {});
    const s = session('cfg2');
    fire(s, { projectedTokens: 400_000, contextWindow: 1_000_000 });
    for (const listener of handlers.get('session/event') ?? []) {
      listener(s, {
        type: 'request/header',
        data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
      });
    }
    await new Promise((r) => setTimeout(r, 30));
    const view = services.get('contextGuard').mirrorView({ id: 'cfg2' });
    check(
      '缺 maxTokens ⇒ 回落 defaultMaxTokens，压缩点仍然算得出（67.8%）',
      view.compactBasis === 'config' && view.compactPercent === 67.8,
      JSON.stringify(view),
    );
  }

  // 6b–6e（外推推送 / 跨会话趋势）已随 v0.5.0 删除：行为、i18n、状态面、测试一起下线。

  // 6a4. v0.7.0（审查 #22）：`/compact` 只读路由的**契约**——此前零测试，三条阻塞项都能在绿灯下存在
  {
    const { projections, fire } = projectionsFor();
    const { ctx, services, handlers, routes } = fakeCtx({ withWebServer: true });
    services.set('sessionProjections', projections);
    services.set('compaction', { config: { auto: true, thresholdRatio: 0.8, headroomTokens: 65536, modelPolicies: [] } });
    apply(ctx, {});
    const s = session('route1');
    fire(s, { projectedTokens: 400_000, contextWindow: 1_000_000 });
    for (const listener of handlers.get('session/event') ?? []) {
      listener(s, {
        type: 'request/header',
        data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 256_000 } } },
      });
    }
    const route = routes.get(COMPACT_ROUTE);
    const call = (method, url) => {
      const out = {};
      route.handler(
        { method, url, headers: {} },
        {
          writeHead(status) {
            out.status = status;
          },
          end(body) {
            out.body = body === undefined ? null : JSON.parse(String(body));
          },
        },
      );
      return out;
    };
    const ok = call('GET', `${COMPACT_ROUTE}?sessionId=route1`);
    check(
      '/compact：已知会话 ⇒ 200 + ok:true + 三参数 + percent',
      ok.status === 200 && ok.body?.ok === true && ok.body?.compact?.reserve === 256_000,
      JSON.stringify(ok.body),
    );
    check(
      '/compact：basis 只描述参数来源（缺窗口也不折叠成 none）',
      ok.body?.compact?.basis === 'config',
      String(ok.body?.compact?.basis),
    );
    const unknown = call('GET', `${COMPACT_ROUTE}?sessionId=nope`);
    check('/compact：未知会话 ⇒ ok:false + reason=unknown-session', unknown.body?.ok === false && unknown.body?.reason === 'unknown-session', JSON.stringify(unknown.body));
    const noId = call('GET', COMPACT_ROUTE);
    check('/compact：缺 sessionId ⇒ 400', noId.status === 400 && noId.body?.reason === 'missing-sessionId', JSON.stringify(noId.body));
    const post = call('POST', `${COMPACT_ROUTE}?sessionId=route1`);
    check('/compact：非 GET ⇒ 405', post.status === 405 && post.body?.reason === 'method-not-allowed', JSON.stringify(post.body));
  }

  // 6a5. v0.7.0（审查 #11/#8）：换路由后旧预留必须失效（不许「新窗口配旧预留」）
  {
    const { projections, fire } = projectionsFor();
    const { ctx, services, handlers } = fakeCtx({});
    services.set('sessionProjections', projections);
    apply(ctx, {});
    const s = session('route2');
    fire(s, { projectedTokens: 400_000, contextWindow: 1_000_000 });
    const engineOf = () => services.get('contextGuard');
    const send = (cfg) => {
      for (const listener of handlers.get('session/event') ?? []) {
        listener(s, { type: 'request/header', data: { header: { config: cfg } } });
      }
    };
    send({ provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 256_000 });
    check('换路由前：预留就是请求头那个值', engineOf().mirrorView({ id: 'route2' }).compactReserve === 256_000);
    send({ provider: 'zai-coding-cn', model: 'glm-5.2', maxTokens: 131_072 });
    const after = engineOf().mirrorView({ id: 'route2' });
    check('换路由后：预留跟着新请求走（不是旧模型的 256K）', after.compactReserve === 131_072, JSON.stringify(after));
    check('换路由后：modelTag 同步更新', after.modelTag === 'zai-coding-cn/glm-5.2', String(after.modelTag));
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

  // v0.5.0：外推推送已删除（含「发送失败只记状态」那条）。

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

  // 6h. 手动起草路由（v0.3.5）：banner 上「写好交接，我复制」按的就是它。
  //     这里走**真的 handler**，验证四件事：方法/参数校验、跳过水位闸门、真写文件、响应不含绝对路径。
  {
    const dir = mkdtempSync(join(tmpdir(), 'guard-manual-'));
    const { ctx, services, routes, handlers } = fakeCtx({ withWebServer: true });
    const { projections, fire } = projectionsFor();
    services.set('sessionProjections', projections);
    apply(ctx, { handoverOnWarn: true, handoverPath: join(dir, 'HANDOVER.md') });

    const route = routes.get(DRAFT_ROUTE);
    check('注册了手动起草路由', route !== undefined, JSON.stringify([...routes.keys()]));

    const call = async (req) => {
      const res = fakeRes();
      if (route === undefined) return { status: 0, payload: null };
      await route.handler(req, res);
      let payload = null;
      try {
        payload = JSON.parse(res.out.body);
      } catch {
        /* 非 JSON 就当 null */
      }
      return { status: res.out.status, payload };
    };

    check('起草路由只接受 POST（GET ⇒ 405）', (await call({ method: 'GET', url: DRAFT_ROUTE })).status === 405);
    check('缺 sessionId ⇒ 400', (await call({ method: 'POST', url: DRAFT_ROUTE })).status === 400);

    const unknown = await call({ method: 'POST', url: `${DRAFT_ROUTE}?sessionId=nope` });
    check(
      '未知会话 ⇒ ok:false / no-reading（而不是 500）',
      unknown.payload?.ok === false && unknown.payload?.reason === 'no-reading',
      JSON.stringify(unknown.payload),
    );

    // 对照：10% 水位远低于 warnRatio ⇒ 自动起草路径**不该**写文件
    const s = { id: 'manual1', header: { id: 'manual1', cwd: dir, createdAt: Date.now() } };
    fire(s, { projectedTokens: 100_000, contextWindow: 1_000_000 });
    await new Promise((r) => setTimeout(r, 50));
    const file = join(dir, 'HANDOVER.md');
    check('对照：10% 水位不会自动起草', !existsSync(file));

    // 手动按钮：跳过水位闸门，立刻写一次
    const written = await call({ method: 'POST', url: `${DRAFT_ROUTE}?sessionId=manual1` });
    await new Promise((r) => setTimeout(r, 80));
    check(
      '手动起草 ⇒ ok:true 且只回文件名（不回绝对路径）',
      written.payload?.ok === true && written.payload?.doc === 'HANDOVER.md',
      JSON.stringify(written.payload),
    );
    check(
      '手动起草真的写进了工作目录',
      existsSync(file) && readFileSync(file, 'utf8').includes(beginMarker('manual1')),
    );
    check(
      '响应体里没有任何绝对路径（P1-2）',
      !/[A-Za-z]:[\\/]|\/home\/|\/Users\//.test(JSON.stringify(written.payload)),
      JSON.stringify(written.payload),
    );
    // v0.4.0：刚写完是空模板 ⇒ todoFilled:false（banner 显示「待补：未补」）
    check('刚起草完 todoFilled=false（待补还是空槽）', written.payload?.todoFilled === false, JSON.stringify(written.payload));

    // 模拟 agent 把结论补进去，再强制起草一次：内容必须保留，且 todoFilled 变 true
    writeFileSync(file, readFileSync(file, 'utf8').replace('- [ ] 结论：', '- [ ] 结论：这一格是 agent 补的'));
    const second = await call({ method: 'POST', url: `${DRAFT_ROUTE}?sessionId=manual1` });
    await new Promise((r) => setTimeout(r, 80));
    const after = existsSync(file) ? readFileSync(file, 'utf8') : '';
    check('再起草一次后人工结论仍在（0.3.6 的保留逻辑）', after.includes('这一格是 agent 补的'), after.slice(-400));
    check('todoFilled 变为 true', second.payload?.ok === true && second.payload?.todoFilled === true, JSON.stringify(second.payload));

    /**
     * v0.4.6 回归（真机故障 §37.4 的连带症状）：**恢复出来的会话**。
     * 真机顺序：`session/created` 先到（此时投影还没回放 ⇒ 读到空）→ 稍后 `hydrate` 算好了快照，
     * 但它**不通知监听者** ⇒ `lastPressure` 一直是空的 ⇒ 徽标 67% 而按钮报 `no-reading`。
     * 修法：按钮被点的那一刻**当场补读一次**注册表快照（只读）。
     */
    {
      const restored = { id: 'restored1', header: { id: 'restored1', cwd: dir, createdAt: Date.now() } };
      // 1) 先按真机顺序：created 时快照为空 ⇒ 读数不可用、素材也不会被建立
      for (const listener of handlers.get('session/created') ?? []) listener(restored);
      // 2) 用户点按钮时，投影已经就绪（hydrate 过了，但没有 onChanged 事件）
      projections.snapshot = () => ({
        asOfSeq: 0,
        values: { contextPressure: { projectedTokens: 700_000, contextWindow: 1_000_000 } },
      });
      const restoredOut = await call({ method: 'POST', url: `${DRAFT_ROUTE}?sessionId=restored1` });
      await new Promise((r) => setTimeout(r, 80));
      check(
        '恢复的会话：created 时没读数，点按钮仍能起草（当场补读一次投影）',
        restoredOut.payload?.ok === true && restoredOut.payload?.doc === 'HANDOVER.md',
        JSON.stringify(restoredOut.payload),
      );
      check(
        '恢复的会话：素材没建立时 cwd 从会话本身补（不能报 no-path）',
        existsSync(file) && readFileSync(file, 'utf8').includes(beginMarker('restored1')),
      );
      projections.snapshot = () => ({ asOfSeq: 0, values: {} });
    }

    // 6i. 压缩账（v0.5.0）：压缩后投影已经是低水位 ⇒ 账行必须记**压缩前峰值**
    fire(s, { projectedTokens: 600_000, contextWindow: 1_000_000 });
    await new Promise((r) => setTimeout(r, 50));
    fire(s, { projectedTokens: 200_000, contextWindow: 1_000_000 }); // 模拟压缩后
    for (const listener of handlers.get('session/event') ?? []) {
      listener(s, { type: 'compaction/end', data: { compactionId: 'self-1', turn: 9 } });
    }
    await new Promise((r) => setTimeout(r, 150));
    const afterCompact = existsSync(file) ? readFileSync(file, 'utf8') : '';
    check('压缩后追加了一行压缩账', afterCompact.includes('dsh-context-guard:ledger:begin'), afterCompact.slice(-300));
    check('账行记的是压缩前峰值 60.0%（不是压缩后的 20%）', afterCompact.includes('60.0%'), afterCompact.slice(-500));
    check('账行带事件 id（幂等键）', afterCompact.includes('self-1'), afterCompact.slice(-300));
  }
}

// —— 7. wire 投影（v0.4.3，复审报告 §2 建议 #1）
//    真机契约：`sessionProjections.register({key, stateVersion, stateSchema, init, apply, wire})`。
//    这里只造一个**只有 register** 的假服务，验证三件事：注册了、键与版本对、view 形状对。
//    （`test/projection.test.mjs` 用更完整的假注册表覆盖「值变才变」与广播，这里守的是
//     「真机接线在 selftest 的假 ctx 里也成立」，两条路互相独立。）
{
  const h = fakeCtx({ withProjections: true });
  const regs = new Map();
  h.services.set('sessionProjections', {
    register(def) {
      if (!Number.isSafeInteger(def.stateVersion) || def.stateVersion < 0) throw new Error('bad stateVersion');
      regs.set(def.key, def);
      return () => regs.delete(def.key);
    },
    onChanged() {
      return () => {};
    },
    snapshot: () => ({ asOfSeq: 0, values: {} }),
  });
  let threw = null;
  try {
    apply(h.ctx, { enabled: true, handoverOnWarn: false });
  } catch (error) {
    threw = error;
  }
  check('有 register() 时 apply 不抛', threw === null, threw ? threw.message : '');

  const def = regs.get('contextGuard');
  check('注册了 contextGuard 投影', def !== undefined);
  check('stateVersion 从 0 起', def?.stateVersion === 0, String(def?.stateVersion));
  check(
    'init/apply/stateSchema/wire 齐全',
    Boolean(def) &&
      typeof def.init === 'function' &&
      typeof def.apply === 'function' &&
      typeof def.stateSchema?.parse === 'function' &&
      typeof def.wire?.view === 'function' &&
      typeof def.wire?.viewSchema?.parse === 'function',
  );
  if (def) {
    const state = def.stateSchema.parse(def.init({ id: 'proj-s1' }, 0));
    check('init 只依赖会话头（id 来自 header）', state.id === 'proj-s1' && state.level === 'none', JSON.stringify(state));
    const view = def.wire.viewSchema.parse(def.wire.view(state));
    check(
      'view 是 level/armed/turn/cooldown/ratio + 阈值三字段 + 压缩回执三字段 + 压缩点/来源/环境 + 压缩参数三字段',
      JSON.stringify(Object.keys(view).sort()) ===
        JSON.stringify([
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
        ]),
      JSON.stringify(view),
    );
    check(
      'view 带着宿主阈值（v0.4.6：客户端显示兜底要用，且阈值只有宿主这一份真源）',
      typeof view.warnRatio === 'number' && typeof view.hardRatio === 'number' && view.enabled === true,
      JSON.stringify({ warnRatio: view.warnRatio, hardRatio: view.hardRatio, enabled: view.enabled }),
    );
    check('view 里不掺排障面（recent/history/trend）', !('recent' in view) && !('history' in view) && !('trend' in view));
    check('同一个 state ⇒ 同一个 view 引用（注册表据此判定不广播）', def.wire.view(state) === def.wire.view(state));
    check('state 没变 ⇒ apply 返回同一个引用', def.apply(state, { type: 'assistant/message' }) === state);
  }
}

console.log(`通过 ${ok.length} 项`);
if (fails.length > 0) {
  console.log(`失败 ${fails.length} 项：`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PASS: 假 ctx 契约测试全绿');
