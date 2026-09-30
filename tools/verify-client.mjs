/**
 * 浏览器半边真机验证（对着一个**隔离的** web profile 跑，别对着 3080）。
 *
 * 它证明的是一条只能实测的链路：
 *   package.json 的 `dsh.client` 声明 → 客户端模块图里有这一行（bundle 真的被服务了）
 *   → bundle 在浏览器里 materialize 成功（没有 require 落空、没有语法错误）
 *   → `ctx.slots` 真的把徽标 / banner 渲染进了会话头与 composer 上方。
 *
 * 顺带做一次**可控的压力注入**：`window.__DSH_CONTEXT_GUARD__` 把 warn 压到 0.01，
 * 于是哪怕刚开页面、上下文几乎是空的，也应该出现 warn 徽标与一次性 banner ——
 * 这同时验证了「逃生阀真的能改档」和「banner 真能出现」。
 *
 * 跑法：`node tools/verify-client.mjs <port> --log=<探针 stdout 日志> [--screenshot]`
 * 退出码即结论；完整证据落 `tools/out/client-verify.json`（不含 token）。
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// 宿主状态路由是两半边的**共享契约**：验收脚本也从同一处取，避免「改了路径只有一边知道」。
import { STATE_ROUTE, defaultConfig } from '../lib/policy.mjs';

/** 出厂默认 warnRatio：断言「探针配的不是出厂默认」时**不写死数字**，默认值调整后不会静默失效。 */
const FACTORY_WARN = defaultConfig().warnRatio;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const PORT = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '3099';
const SCREENSHOT = process.argv.includes('--screenshot');
const PKG = 'dsh-context-guard';

/**
 * 取探针实例的 token。
 *
 * ⚠️ token 是**登录凭据**：只在进程内流转，既不打印也不落盘。
 * `dsh-url.ps1` 只认驱动 3080 那个 daemon 的 stdout，所以探针实例（别的端口、自己的日志文件）
 * 必须显式给日志路径，或者直接传 `DSH_PROBE_TOKEN`。
 */
function tokenFor(port) {
  const fromEnv = process.env.DSH_PROBE_TOKEN;
  if (fromEnv) return fromEnv;

  const logFlag = process.argv.find((a) => a.startsWith('--log='));
  if (logFlag) {
    // 探针的 stdout 被后台作业持有 ⇒ 普通读会被锁：用带 FileShare.ReadWrite 的读法。
    // 另外 PowerShell 的 `*>` 重定向写的是 **UTF-16LE**，所以先丢掉 NUL 字节再按 UTF-8 解
    // （跟本机 `dsh-url.ps1` 处理 web-daemon.log 的做法一致）。
    const path = logFlag.slice('--log='.length);
    const out = execFileSync(
      'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `$fs=[System.IO.File]::Open('${path.replace(/'/g, "''")}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite);$ms=New-Object System.IO.MemoryStream;$fs.CopyTo($ms);$fs.Dispose();$b=$ms.ToArray();$ms.Dispose();$c=New-Object 'System.Collections.Generic.List[byte]';foreach($x in $b){if($x -ne 0){$c.Add($x)}};[System.Text.Encoding]::UTF8.GetString($c.ToArray())`,
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    const line = out.split(/\r?\n/).find((l) => /dsh web: http/.test(l));
    const match = line && /[?&]token=([A-Za-z0-9._-]+)/.exec(line);
    if (match) return match[1];
    throw new Error(`日志里找不到 dsh web URL 行：${path}`);
  }

  const ps = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const out = execFileSync(ps, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:\\dsh-app\\dsh-url.ps1'], { encoding: 'utf8' });
  const url = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('http'));
  if (!url) throw new Error('dsh-url.ps1 没给出 URL');
  const token = new URL(url).searchParams.get('token');
  if (!token) throw new Error('URL 里没有 token');
  if (port !== '3080') {
    throw new Error(`探针端口 ${port} 需要 --log=<探针 stdout 日志> 或 DSH_PROBE_TOKEN（dsh-url.ps1 只认 3080）`);
  }
  return token;
}

const fails = [];
const notes = [];
const evidence = {};
const check = (name, condition, detail = '') => {
  evidence[name] = { pass: Boolean(condition), detail };
  if (!condition) fails.push(`${name}${detail ? ` —— ${detail}` : ''}`);
};

const main = async () => {
  const { chromium } = await import('file:///D:/dsh-home/profiles/web/node_modules/playwright-core/index.mjs');
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleAll = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 400)));
  page.on('console', (msg) => {
    const text = String(msg.text()).slice(0, 600);
    consoleAll.push(`${msg.type()}: ${text}`);
    if (msg.type() === 'error') pageErrors.push(`console: ${text}`);
  });

  // 逃生阀必须在 bundle materialize 之前设好：store 在 factory 里就固化了 CONFIG。
  await page.addInitScript(() => {
    window.__DSH_CONTEXT_GUARD__ = { config: { warnRatio: 0.01, hardRatio: 0.02, cooldownTurns: 0 } };
  });

  const url = `http://127.0.0.1:${PORT}/?token=${encodeURIComponent(tokenFor(PORT))}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForFunction('!!window.__DSH_BOOT__', null, { timeout: 45_000 }).catch(() => {});
  await page.waitForFunction('!!(window.__ModuleLoader__ && window.__ModuleLoader__.mode === "live")', null, { timeout: 60_000 }).catch(() => {});

  // 1. 客户端模块图里有我这一行
  const graph = await page.evaluate((pkg) => {
    const boot = window.__DSH_BOOT__;
    if (!boot) return null;
    const row = (boot.entries ?? []).find((e) => e.id === pkg);
    return {
      found: Boolean(row),
      row: row ? { id: row.id, url: row.url, rev: row.rev, inject: row.inject ?? [], external: row.external ?? [] } : null,
      entries: (boot.entries ?? []).length,
      batches: (boot.batches ?? []).length,
    };
  }, PKG);
  check('客户端模块图里有 dsh-context-guard 这一行', graph?.found === true, JSON.stringify(graph?.row ?? graph));
  evidence['boot'] = graph;

  // 2. bundle 能被服务（HTTP 200 + 是那个经典 script 包裹）
  let bundleStatus = null;
  if (graph?.row?.url) {
    bundleStatus = await page.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'same-origin' });
      const text = await res.text();
      return { status: res.status, bytes: text.length, hasRegistration: text.includes('__ModuleLoader__.load'), hasId: text.includes('dsh-context-guard') };
    }, graph.row.url);
  }
  check('client bundle 被服务且是合法注册包裹', bundleStatus?.status === 200 && bundleStatus?.hasRegistration === true && bundleStatus?.hasId === true, JSON.stringify(bundleStatus));

  // 2b. 在页面里**隔离地跑一次 factory**：把 fetch 到的 bundle 用一个假的 __ModuleLoader__ 接住，
  //     再真调一次 factory(require)。这样 factory 里的异常会在这里原样露出来，
  //     而不用等 boot 那句含糊的 "import failed (see console)"。
  //     这一步既是排障手段，也是回归护栏：bundle 抛异常就红在这里。
  const factoryProbe = await page.evaluate(async (u) => {
    if (!u) return { skipped: 'no url' };
    const text = await (await fetch(u, { credentials: 'same-origin' })).text();
    const captured = [];
    const realLoader = window.__ModuleLoader__;
    const fake = {
      mode: 'queue',
      pendingQueue: [],
      load(registration) {
        captured.push(registration);
      },
      create() {
        throw new Error('unused');
      },
    };
    window.__ModuleLoader__ = fake;
    try {
      // eslint-disable-next-line no-new-func
      new Function(text)();
    } catch (error) {
      return { evalError: String(error && error.stack ? error.stack : error).slice(0, 800) };
    } finally {
      window.__ModuleLoader__ = realLoader;
    }
    if (captured.length !== 1) return { registrations: captured.length };
    const reg = captured[0];
    try {
      const exported = reg.factory((spec) => {
        // 只替身基线的 react；别的一律按真实 loader 的规矩报错，才能暴露 externals 漂移
        if (spec === 'react') return { createElement: () => null, useEffect: () => {}, useState: (v) => [v, () => {}], useSyncExternalStore: () => null };
        if (spec === 'react/jsx-runtime') return { jsx: () => null };
        throw new Error(`factory require("${spec}") missed the module table`);
      });
      return { id: reg.id, exportKeys: Object.keys(exported ?? {}) };
    } catch (error) {
      return { factoryError: String(error && error.stack ? error.stack : error).slice(0, 1200) };
    }
  }, graph?.row?.url);
  evidence['factoryProbe'] = factoryProbe;
  check('bundle 在页面里能被解析并 materialize（无语法/require 错误）', !factoryProbe?.evalError && !factoryProbe?.factoryError, JSON.stringify(factoryProbe).slice(0, 600));
  check('factory 返回的是 cordis 插件对象', Array.isArray(factoryProbe?.exportKeys) && factoryProbe.exportKeys.includes('apply') && factoryProbe.exportKeys.includes('inject'), JSON.stringify(factoryProbe?.exportKeys));

  // 等 shell 真正把应用挂起来：启动画面 "Loading plugins…" 消失、出现 composer/空态。
  // 只等 __DSH_BOOT__ 是不够的 —— 那时还在 loading 画面，槽位根本没挂。
  await page
    .waitForFunction(() => !/Loading plugins/i.test(document.body.innerText ?? ''), null, { timeout: 90_000 })
    .catch(() => {});
  evidence['consoleEarly'] = consoleAll.slice(0, 40);
  // 3. 主动点一个「新建会话」——槽位只在 session 作用域里挂（会话头/ composer 都要先有会话）。
  //    按 aria-label 找，别按可见文字：首轮实测里那个按钮的文字是空的（只有 aria 有名字）。
  const clicked = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
    const byAria = candidates.find((el) => /新建会话|new session/i.test(el.getAttribute('aria-label') ?? ''));
    const byText = candidates.find((el) => /新建会话|new session/i.test(el.textContent ?? ''));
    const target = byAria ?? byText;
    if (target) target.click();
    return target ? (target.getAttribute('aria-label') ?? target.textContent ?? '').trim().slice(0, 40) : null;
  });
  evidence['clickedNewSession'] = clicked;
  await page.waitForTimeout(3000);

  // 3a. 空态 Hero 下会话头是 `headerBlank`（不渲染 utilities）—— 这是真实的 UI 行为，
  //     不是插件坏了。所以再去点一个**已有会话**，让会话头真正进入非空态。
  const clickedSession = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-session-id], [class*="sessionItem" i], [class*="sessionRow" i], li, [role="option"]')];
    const byId = document.querySelector('[data-session-id]');
    const target = byId ?? items.find((el) => el.textContent && el.textContent.trim().length > 1 && el.querySelector('button'));
    if (target) target.click();
    return target ? (target.getAttribute('data-session-id') ?? (target.textContent ?? '').trim().slice(0, 40)) : null;
  });
  evidence['clickedSession'] = clickedSession;
  await page.waitForTimeout(3000);

  const headerState = await page.evaluate(() => ({
    headerBlank: document.querySelectorAll('[class*="headerBlank"]').length,
    headerUtilities: document.querySelectorAll('[class*="headerUtilities"]').length,
    header: document.querySelectorAll('[class*="wSkVaW_header"]').length,
  }));
  evidence['headerState'] = headerState;

  // 3b. 插件的排障把手：注册了几次、槽位挂上几次、每会话读数与档位。
  const debug = await page.evaluate(() => {
    const g = window.__DSH_CONTEXT_GUARD__;
    if (!g) return { present: false };
    let sessions = null;
    try {
      sessions = typeof g.store?.dump === 'function' ? g.store.dump() : null;
    } catch (error) {
      sessions = { error: String(error.message) };
    }
    const bannerEl = document.querySelector('[data-dsh-context-guard="banner"]');
    return {
      present: true,
      hasSlots: g.hasSlots,
      config: g.config,
      calls: g.calls,
      sessions: sessions,
      bannerNode: Boolean(bannerEl),
      seenKeys: g.bannerSeenKeys ?? null,
    };
  });
  evidence['pluginDebug'] = debug;
  check('插件在页面里留下了排障把手', debug?.present === true, JSON.stringify(debug).slice(0, 300));
  const mountedCount = Array.isArray(debug?.calls) ? debug.calls.filter((c) => c.mounted).length : 0;
  check('两个槽位都真的挂上了（inject 回调跑过）', mountedCount === 2, JSON.stringify(debug?.calls));

  // 3b-2. 宿主真源链路：**client 半边真的从宿主状态路由读到了设置**（§14.5 的第一件未做完项）。
  //
  // 这条链路只能在真机上证：host 半边注册路由 → 浏览器 same-origin fetch → store 采纳宿主阈值。
  // 断言分两半：① 路由本身在这个实例上真的在答；② 页面里的插件状态说它采纳了宿主值。
  // 失败不许让整个脚本红：宿主路由缺席时插件应**退回内置默认值继续工作**（fail-soft），
  // 所以「读到」是验收项，「读不到」是要单独报出来的**降级**项。
  const hostState = await page.evaluate(async (route) => {
    const g = window.__DSH_CONTEXT_GUARD__;
    const sync = typeof g?.hostSync === 'function' ? g.hostSync() : null;
    let routeProbe = null;
    try {
      const res = await fetch(route, { cache: 'no-store' });
      const text = await res.text();
      routeProbe = { status: res.status, bytes: text.length };
      if (res.ok) {
        const payload = JSON.parse(text);
        routeProbe.plugin = payload.plugin;
        routeProbe.warnRatio = payload.config?.warnRatio;
        routeProbe.hardRatio = payload.config?.hardRatio;
      }
    } catch (error) {
      routeProbe = { error: String((error && error.message) || error) };
    }
    // 等一次已发起的同步落地（apply 里**先渲染后到货**，所以这里允许等）
    try {
      if (g?.hostSyncReady) await g.hostSyncReady;
    } catch (error) {
      /* 同步自己永不 reject，这里只是防御 */
    }
    const after = typeof g?.hostSync === 'function' ? g.hostSync() : null;
    return {
      route: routeProbe,
      syncBefore: sync,
      syncAfter: after,
      hostConfig: typeof g?.hostConfig === 'function' ? g.hostConfig() : null,
      effective: g?.config ?? null,
      hostSync: window.__DSH_CONTEXT_GUARD_HOSTSYNC__ ?? null,
    };
  }, STATE_ROUTE);
  evidence['hostConfigLink'] = hostState;

  const hostWarn = Number(hostState?.route?.warnRatio);
  check(
    '宿主状态路由在真机上真的应答（host 半边注册成功）',
    hostState?.route?.status === 200 && hostState?.route?.plugin === 'context-guard',
    JSON.stringify(hostState?.route).slice(0, 300),
  );
  // ⚠️ 前置条件而非凑数断言：探针 profile 若配的就是出厂默认，
  //    「采纳了宿主设置」与「退回内置默认值」在数值上无法区分 ⇒ 这条必须红。
  check(
    '探针 profile 配的是**非默认**阈值（否则「采纳宿主」不可证伪）',
    Number.isFinite(hostWarn) && Math.abs(hostWarn - FACTORY_WARN) > 1e-9,
    `host warnRatio=${hostState?.route?.warnRatio}（探针 profile 的 cordis.patch.yml 应配 0.33/0.44；出厂默认 ${FACTORY_WARN}）`,
  );
  check(
    'client 半边采纳了宿主真源阈值（hostConfig === 路由值）',
    hostState?.syncAfter?.status === 'ok' &&
      hostState?.hostConfig &&
      Math.abs(Number(hostState.hostConfig.warnRatio) - hostWarn) < 1e-9 &&
      Number(hostState?.syncAfter?.keys) >= 10,
    JSON.stringify({ sync: hostState?.syncAfter, hostConfig: hostState?.hostConfig }).slice(0, 400),
  );
  // ⚠️ 本脚本用 addInitScript 把 warn 压到 0.01（逃生阀），而逃生阀**优先级高于宿主真源**：
  //    所以「生效档位」在这里应等于逃生阀值、而不是宿主值。这条同时证明了分层的顺序没写反。
  check(
    '逃生阀优先级高于宿主真源（逃生阀 0.01 仍然生效）',
    Math.abs(Number(hostState?.effective?.warnRatio) - 0.01) < 1e-9,
    `effective.warnRatio=${hostState?.effective?.warnRatio}`,
  );

  // 3b-3. **决定性证据**：另开一个*没有逃生阀*的页面（Playwright 的 newPage 是独立 context），
  //       让宿主真源自己决定档位。宿主配的是 0.33，所以「生效档位 = 0.33」只可能来自宿主设置 ——
  //       这条才真正证伪了「其实一直在用内置默认值」。
  let freshLink = null;
  try {
    const fresh = await browser.newPage();
    await fresh.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await fresh
      .waitForFunction(() => Boolean(window.__DSH_CONTEXT_GUARD__) && typeof window.__DSH_CONTEXT_GUARD__.hostSync === 'function', null, { timeout: 45_000 })
      .catch(() => {});
    await fresh.evaluate(async () => {
      try {
        await window.__DSH_CONTEXT_GUARD__?.hostSyncReady;
      } catch (error) {
        /* 同步永不 reject，这里只是防御 */
      }
    });
    freshLink = await fresh.evaluate(() => {
      const g = window.__DSH_CONTEXT_GUARD__;
      return {
        sync: typeof g?.hostSync === 'function' ? g.hostSync() : null,
        effective: g?.config ?? null,
        hasInitValve: Boolean(window.__DSH_CONTEXT_GUARD_PRE_VALVE__),
      };
    });
    await fresh.close();
  } catch (error) {
    freshLink = { error: String((error && error.message) || error) };
  }
  evidence['freshPage'] = freshLink;
  check(
    `无反例页面：宿主真源自己决定档位（= 宿主 ${hostWarn}，而不是出厂 ${FACTORY_WARN}）`,
    Math.abs(Number(freshLink?.effective?.warnRatio) - hostWarn) < 1e-9 &&
      Math.abs(Number(freshLink?.effective?.warnRatio) - FACTORY_WARN) > 1e-9,
    JSON.stringify(freshLink).slice(0, 300),
  );

  // 3c. 就地在同一个席位（conversation.input.dock）再注册一个**零依赖**的标记组件。
  //     它渲染 ⇒ 席位本身的渲染条件与我们的 slot id 都没问题，问题只会出在 Banner 自己的判定；
  //     它不渲染 ⇒ 这个席位在当前视图下根本没铺开（那就不该把 banner 放这儿）。
  const dockProbe = await page.evaluate(() => {
    const g = window.__DSH_CONTEXT_GUARD__;
    if (!g || !g.ctx || !g.react) return { error: 'no handle' };
    try {
      g.ctx.slots.inject('conversation.input.dock', function () {
        return g.ctx.slots.register(
          { name: 'conversation.input.dock', id: 'context-guard:probe2', order: 999 },
          function (props) {
            const sid = props && props.sessionId !== undefined ? String(props.sessionId) : null;
            const dump = g.store && typeof g.store.dump === 'function' ? g.store.dump() : {};
            const slot = sid !== null ? dump[sid] : null;
            return g.react.createElement(
              'div',
              { 'data-dock-probe': '1' },
              `dock-probe sid=${sid} level=${slot ? slot.level : 'NO-SLOT'} keys=${Object.keys(dump).length}`,
            );
          },
        );
      });
      return { registered: true };
    } catch (error) {
      return { error: String(error.message).slice(0, 200) };
    }
  });
  await page.waitForTimeout(1500);
  evidence['dockProbe'] = {
    ...dockProbe,
    rendered: await page.evaluate(() => document.querySelectorAll('[data-dock-probe]').length),
    text: await page.evaluate(() => document.querySelector('[data-dock-probe]')?.textContent ?? null),
  };
  evidence['dockProbeSeenKeys'] = await page.evaluate(() => {
    const g = window.__DSH_CONTEXT_GUARD__;
    return g && g.store && typeof g.store.dump === 'function' ? Object.keys(g.store.dump()) : null;
  });
  evidence['renderErrors'] = await page.evaluate(() => window.__DSH_CONTEXT_GUARD_ERR__ ?? null);

  // 4. 徽标真的渲染了吗（DOM 上直接问，不靠截图猜）
  //
  // ⚠️ 这一条只在「页面真的有一个活跃会话、会话头进入非空态」时才可判定：
  //    空态 Hero 的会话头带 `headerBlank`，官方实现**根本不渲染 utilities 槽位**
  //    （`dsh-client-ui-conversation` 的 SessionHeader：`!hideChrome && …` 才铺 titleRow 右侧）。
  //    所以这里把「无法判定」与「判定失败」分开说 —— 前者是 note，后者才是 fail。
  //    要把 note 变成实判：给探针配一个可用的 API Key，让脚本真发一轮（会消耗额度）。
  const headerBlank = await page.evaluate(() => document.querySelectorAll('[class*="headerBlank"]').length > 0);
  evidence['headerBlank'] = headerBlank;

  const badge = await page.evaluate(() => {
    const el = document.querySelector('[data-dsh-context-guard="badge"]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      text: (el.textContent ?? '').trim(),
      level: el.getAttribute('data-level'),
      percent: el.getAttribute('data-percent'),
      title: el.getAttribute('title'),
      visible: cs.display !== 'none' && el.getBoundingClientRect().width > 0,
      width: Math.round(el.getBoundingClientRect().width),
      parent: el.parentElement?.className ?? null,
    };
  });
  if (badge !== null) {
    check('会话头出现了 context-guard 徽标', true, JSON.stringify(badge));
    check('徽标真的可见（display/尺寸都正常）', badge.visible === true, JSON.stringify(badge));
    check('徽标文字形如 ctx N%', /ctx\s+\d+%/.test(badge.text), badge.text);
    check('徽标 tooltip 带阈值与动作', /warn/.test(badge.title ?? '') && /hard/.test(badge.title ?? ''), String(badge.title).slice(0, 160));
  } else if (headerBlank) {
    notes.push('会话头处于空态 headerBlank（没有活跃会话），官方实现就不渲染 utilities 槽位 ⇒ 徽标这一条**未实判**');
  } else {
    check('会话头出现了 context-guard 徽标', false, '会话头已是非空态，但槽位里没有徽标节点');
  }

  // 5. banner（warn 压到 1% 后，任何非零占用都该跨档）
  const banner = await page.evaluate(() => {
    const el = document.querySelector('[data-dsh-context-guard="banner"]');
    if (!el) return null;
    return {
      text: (el.textContent ?? '').trim().slice(0, 200),
      level: el.getAttribute('data-level'),
      hasKnowIt: /知道了/.test(el.textContent ?? ''),
      mentionsHandoff: /HANDOVER\.md/.test(el.textContent ?? ''),
    };
  });
  evidence['banner'] = banner;
  evidence['bannerDiag'] = await page.evaluate(() => {
    const snapshot = (sel) => [...document.querySelectorAll(sel)].map((el) => ({
      id: el.getAttribute('id'),
      cls: (el.className ?? '').toString().slice(0, 80),
      html: el.innerHTML.slice(0, 220),
    }));
    return {
      probeDockSnapshots: snapshot('[class*="uV2eYG_dock"]'),
      composerStackSnapshots: snapshot('[class*="composerStack"]'),
      bannerByAnything: snapshot('[id*="context-guard"]'),
      bannerNode: Boolean(document.querySelector('[data-dsh-context-guard="banner"]')),
      allGuardNodes: [...document.querySelectorAll('[data-dsh-context-guard]')].map((el) => el.getAttribute('data-dsh-context-guard')),
      editors: document.querySelectorAll('[contenteditable="true"], textarea').length,
    };
  });
  if (banner !== null) {
    check('跨越档位后出现了 banner', true, JSON.stringify(banner));
    check('banner 指向交接文档', banner.mentionsHandoff === true, banner.text);
    check('banner 带「知道了」按钮', banner.hasKnowIt === true, banner.text);
  } else if (headerBlank) {
    notes.push('没有活跃会话 ⇒ 还没有 contextPressure 投影，banner 这一条**未实判**');
  } else {
    check('跨越档位后出现了 banner', false, '有会话但 banner 没出现 —— 检查警告档阈值与投影是否有值');
  }

  // 7. 页面上不该有来自本插件的未捕获错误
  const mine = pageErrors.filter((e) => /context-guard|__DSH_CONTEXT_GUARD__|ModuleLoader/i.test(e));
  check('页面无本插件相关的未捕获错误', mine.length === 0, JSON.stringify(mine.slice(0, 3)));
  evidence['pageErrors'] = pageErrors.slice(0, 10);
  evidence['console'] = consoleAll
    .filter((m) => /context-guard|ModuleLoader|require\(|slots|import|react/i.test(m))
    .slice(0, 25);
  evidence['consoleCount'] = consoleAll.length;

  if (SCREENSHOT) {
    mkdirSync(OUT, { recursive: true });
    const shot = join(OUT, 'client-verify.png');
    await page.screenshot({ path: shot, fullPage: false });
    evidence['screenshot'] = shot;
  }
  evidence['demoText'] = { badge: badge?.text ?? null, banner: banner?.text ?? null, badgeTitle: badge?.title ?? null };
  evidence['notes'] = notes;
  await browser.close();

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'client-verify.json'), JSON.stringify(evidence, null, 1), 'utf8');

  const checked = Object.keys(evidence).filter((k) => evidence[k]?.pass !== undefined).length;
  console.log(`检查 ${checked} 项，失败 ${fails.length} 项，未实判 ${notes.length} 项`);
  console.log(`  徽标：${badge ? `${badge.text} (level=${badge.level}, visible=${badge.visible})` : '未渲染（会话头空态）'}`);
  console.log(`  banner：${banner ? `${banner.level} · ${banner.text.split('\n')[0]}` : '未渲染（无活跃会话压力）'}`);
  for (const n of notes) console.log(`  ⚠️ 未实判：${n}`);
  if (fails.length > 0) {
    console.log('失败项：');
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('PASS: 浏览器半边真机验证全绿');
};

main().catch((error) => {
  console.log(`FAIL: ${error.message}`);
  process.exit(1);
});
