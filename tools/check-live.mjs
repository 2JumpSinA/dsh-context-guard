/**
 * 对着**运行中的** web profile（默认 3080）只读地检查三件事：
 *   1. 客户端模块图里有没有目标包那一行；
 *   2. 若有，bundle 是否被服务、能否就地 materialize；
 *   3. **宿主状态路由**（`STATE_ROUTE`）在真机上答不答，以及浏览器半边是否暴露了
 *      v0.4.3 的只读观测面（`store.dump()` / `viewOf(sessionId)`）——
 *      它读的是宿主注册的 `contextGuard` 投影，客户端自己不再有状态机（所以也**不该**再有
 *      `hostSync` / `hostConfig` 这类本地判定把守）。`STATE_ROUTE` 现在只是只读调试镜像。
 *
 * 只读、不改页面状态、不点任何按钮 —— 用来在**真实运行的会话**上做安装后确认。
 * token 从 `dsh-url.ps1` 取，只在进程内流转。
 *
 * ⚠️ 第 3 条只验「宿主半边活着 + 浏览器半边的观测面在」；它**不**替 §10.3 的数值判定负责
 *    （那是策略单测的事，判定现在只住在 `lib/engine.mjs`）。
 *
 * 跑法：`node tools/check-live.mjs [port] [packageName]`
 */
import { execFileSync } from 'node:child_process';
import { STATE_ROUTE } from '../lib/policy.mjs';

const PORT = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '3080';
const PKG = process.argv[3] ?? '@2jumpsina/dsh-context-guard';

const psUrl = execFileSync(
  'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:\\dsh-app\\dsh-url.ps1'],
  { encoding: 'utf8' },
);
const url = psUrl.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('http'));
if (!url) throw new Error('dsh-url.ps1 没给出 URL');
const token = new URL(url).searchParams.get('token');

const main = async () => {
  const { chromium } = await import('file:///D:/dsh-home/profiles/web/node_modules/playwright-core/index.mjs');
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForFunction('!!window.__DSH_BOOT__', null, { timeout: 45_000 }).catch(() => {});

  const graph = await page.evaluate((pkg) => {
    const boot = window.__DSH_BOOT__;
    if (!boot) return null;
    const row = (boot.entries ?? []).find((e) => e.id === pkg);
    const longest = (boot.batches ?? []).reduce((max, b) => Math.max(max, (b.entries ?? []).length), 0);
    return {
      found: Boolean(row),
      row: row ? { id: row.id, url: row.url, rev: row.rev, inject: row.inject ?? [], external: row.external ?? [] } : null,
      entries: (boot.entries ?? []).length,
      batches: (boot.batches ?? []).length,
      longestBatch: longest,
      hasLoader: Boolean(window.__ModuleLoader__),
    };
  }, PKG);

  let bundle = null;
  if (graph?.row?.url) {
    bundle = await page.evaluate(async ({ u, pkg }) => {
      const res = await fetch(u, { credentials: 'same-origin' });
      const text = await res.text();
      const captured = [];
      const real = window.__ModuleLoader__;
      window.__ModuleLoader__ = { mode: 'queue', pendingQueue: [], load: (r) => captured.push(r), create() { throw new Error('x'); } };
      let parseError = null;
      let exportKeys = null;
      let factoryError = null;
      try {
        // eslint-disable-next-line no-new-func
        new Function(text)();
        if (captured.length === 1) {
          try {
            exportKeys = Object.keys(
              captured[0].factory((spec) =>
                spec === 'react'
                  ? { createElement: () => null, useEffect: () => {}, useState: (v) => [v, () => {}], useSyncExternalStore: () => null }
                  : (() => { throw new Error(`require("${spec}") missed the module table`); })(),
              ) ?? {},
            );
          } catch (error) {
            factoryError = String(error.message).slice(0, 200);
          }
        }
      } catch (error) {
        parseError = String(error.message).slice(0, 200);
      } finally {
        window.__ModuleLoader__ = real;
      }
      return { status: res.status, bytes: text.length, registrations: captured.length, parseError, factoryError, exportKeys };
    }, { u: graph.row.url, pkg: PKG });
  }

  // —— 宿主状态路由（只读调试镜像）+ 浏览器半边的只读观测面（全程只读：一个 GET + 读一个全局对象）
  // ⚠️ 必须在 `browser.close()` **之前**跑：关掉浏览器再 evaluate 只会拿到
  //    「Target page, context or browser has been closed」（第一版就是这么写的）。
  await page
    .waitForFunction(
      () => {
        const g = window.__DSH_CONTEXT_GUARD__;
        return Boolean(g) && typeof g.store?.dump === 'function' && typeof g.viewOf === 'function';
      },
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  const link = await page.evaluate(async (route) => {
    const g = window.__DSH_CONTEXT_GUARD__;
    let routeProbe = null;
    try {
      const res = await fetch(route, { cache: 'no-store' });
      const text = await res.text();
      routeProbe = { status: res.status, bytes: text.length };
      if (res.ok) {
        const payload = JSON.parse(text);
        routeProbe.plugin = payload.plugin;
        routeProbe.warnRatio = payload.config?.warnRatio;
        routeProbe.push = payload.push?.channel;
        // 「自动交接草稿」的面：能读到它 ⇒ 宿主半边确实载入了**这一代**代码（含 handover.mjs）。
        routeProbe.handover = payload.handover
          ? {
              enabled: payload.handover.enabled,
              path: payload.handover.path,
              written: payload.handover.written,
              failed: payload.handover.failed,
              skipped: payload.handover.skipped,
              last: payload.handover.last?.status ?? null,
            }
          : null;
        routeProbe.handoverMissing = payload.handover === undefined;
      }
    } catch (error) {
      routeProbe = { error: String((error && error.message) || error) };
    }
    // v0.4.3 的观测面：`store.dump()` 记录宿主投影说了什么；`viewOf(sessionId)` 是同一个把手的单会话版。
    let dump = null;
    try {
      dump = typeof g?.store?.dump === 'function' ? g.store.dump() : null;
    } catch (error) {
      dump = { error: String((error && error.message) || error) };
    }
    const sessions = dump && typeof dump === 'object' ? Object.keys(dump) : [];
    return {
      route: routeProbe,
      surface: {
        hasDump: typeof g?.store?.dump === 'function',
        hasViewOf: typeof g?.viewOf === 'function',
        configSource: typeof g?.store?.config === 'function' ? g.store.config()?.source ?? null : null,
        locale: typeof g?.store?.locale === 'function' ? g.store.locale() : null,
        sessions: sessions.length,
        levels: sessions.slice(0, 4).map((sid) => dump[sid]?.level ?? null),
        viewOfFirst: sessions.length > 0 && typeof g?.viewOf === 'function' ? g.viewOf(sessions[0]) : null,
        // 旧一代的把守：存在 ⇒ 那个 profile 里跑的还是**带客户端状态机**的旧 bundle。
        legacy: ['hostSync', 'hostSyncReady', 'hostConfig', 'setConfig', 'settleTurn'].filter(
          (key) => typeof g?.[key] !== 'undefined',
        ),
      },
    };
  }, STATE_ROUTE);
  await browser.close();

  console.log(`graph.entries=${graph?.entries} batches=${graph?.batches} longestBatch=${graph?.longestBatch} loader=${graph?.hasLoader}`);
  console.log(`${PKG} 在客户端模块图里：${graph?.found ? 'YES' : 'NO'}`);
  if (graph?.row) console.log(`  row: inject=[${graph.row.inject.join(',')}] external=[${graph.row.external.join(',')}] rev=${graph.row.rev}`);
  if (bundle) console.log(`  bundle: HTTP ${bundle.status}, ${bundle.bytes} 字节, 注册 ${bundle.registrations} 个, exports=[${(bundle.exportKeys ?? []).join(',')}]`);
  if (bundle?.parseError) console.log(`  ⛔ 解析失败: ${bundle.parseError}`);
  if (bundle?.factoryError) console.log(`  ⛔ factory 失败: ${bundle.factoryError}`);
  if (errors.length) console.log(`页面错误: ${JSON.stringify(errors.slice(0, 4))}`);
  console.log(`宿主状态路由 ${STATE_ROUTE}（只读调试镜像）：HTTP ${link?.route?.status ?? 'ERR'}${link?.route?.error ? ` (${link.route.error})` : ''}${link?.route?.plugin ? ` plugin=${link.route.plugin} warn=${link.route.warnRatio} 外推=${link.route.push}` : ''}`);
  console.log(
    `浏览器半边观测面：dump=${link?.surface?.hasDump ? 'YES' : 'NO'} viewOf=${link?.surface?.hasViewOf ? 'YES' : 'NO'} 投影=config.${link?.surface?.configSource ?? '?'} locale=${link?.surface?.locale ?? '-'} 会话=${link?.surface?.sessions ?? '-'} 档位=[${(link?.surface?.levels ?? []).join(',')}]`,
  );
  if ((link?.surface?.legacy ?? []).length > 0) {
    console.log(`⛔ 这一页里还有旧一代把守：${link.surface.legacy.join(', ')} ⇒ 跑的不是 v0.4.3 的 bundle（客户端状态机还在）`);
  }
  if (link?.surface?.viewOfFirst) console.log(`  viewOf(首个会话): ${JSON.stringify(link.surface.viewOfFirst)}`);
  if (link?.route?.handover) {
    const h = link.route.handover;
    console.log(
      `自动交接草稿：enabled=${h.enabled} path=${h.path} 已写=${h.written} 失败=${h.failed} 跳过=${h.skipped} 最近=${h.last ?? '—'}`,
    );
  } else if (link?.route?.handoverMissing === true) {
    console.log('自动交接草稿：**宿主半边没有这个面** ⇒ 这一代代码没被载入（改源码不会自愈，要重启/重载那个 dsh 进程）');
  }

  const routeOk = link?.route?.status === 200 && link?.route?.plugin === 'context-guard';
  // 浏览器半边「活着」的定义（v0.4.3）：只读观测面在，且**没有**旧一代的本地判定把守。
  const surface = link?.surface ?? null;
  const surfaceOk =
    surface?.hasDump === true &&
    surface?.hasViewOf === true &&
    surface?.configSource === 'projection' &&
    (surface?.legacy ?? ['legacy-present']).length === 0;
  if (!routeOk) console.log('⛔ 宿主状态路由没在答：宿主半边多半还是**改代码之前**的那一代（存盘不会重载已装载的模块，需要重启 daemon 或触发一次 profile 重载）');
  if (routeOk && !surfaceOk) console.log('⛔ 路由在答，但浏览器半边没给出 v0.4.3 的只读观测面（见上：dump/viewOf/config.source/legacy）');

  const ok =
    graph?.found === true &&
    bundle?.status === 200 &&
    !bundle?.parseError &&
    !bundle?.factoryError &&
    routeOk &&
    surfaceOk;
  console.log(ok ? 'PASS: 实时运行时已装载并服务该插件的浏览器半边，且宿主投影观测面可用（/state 仅只读镜像）' : 'FAIL: 见上');
  process.exit(ok ? 0 : 1);
};

main().catch((error) => {
  console.log(`FAIL: ${error.message}`);
  process.exit(1);
});
