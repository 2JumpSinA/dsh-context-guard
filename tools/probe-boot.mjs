/**
 * 探针：从真实的 DSH Web 页面里读出 `window.__DSH_BOOT__` 的入口图，
 * 回答两个只能实测的问题：
 *   1. 一个手写 client bundle 允许 `require(...)` 哪些说明符（模块表 seed 里有什么）？
 *   2. 我这条新入口进图之后，`inject` 边有没有被 composition 接受？
 *
 * 只输出结论行；完整 dump 落盘到 _recon/ 之外（工作区内 probes/out/），不进上下文。
 *
 * 跑法（需要本机 3080 在跑 + playwright-core 在 D:\dsh-app）：
 *   D:\nodejs\node.exe tools/probe-boot.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

/**
 * 取当前 dsh web 的带 token URL。**token 只在进程内流转，绝不打印、绝不落盘** ——
 * 落盘就等于把登录凭据写进了工作区。复用本机 `Win+R -> dsh-url` 那条路：
 * 跑 `dsh-url.ps1` 读 daemon stdout 里那一行，截到第一个 `&token=` 之前。
 */
function currentUrl() {
  if (process.env.DSH_URL) return process.env.DSH_URL;
  const out = execFileSync(
    'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'D:\\dsh-app\\dsh-url.ps1'],
    { encoding: 'utf8' },
  );
  const url = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('http'));
  if (!url) throw new Error('dsh-url.ps1 没给出 URL（运行时没在跑？）');
  return url;
}
const BASE = currentUrl();

async function main() {
  const { chromium } = await import('file:///D:/dsh-home/profiles/web/node_modules/playwright-core/index.mjs');
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // 等 boot 图注入
  await page.waitForFunction('!!window.__DSH_BOOT__', null, { timeout: 30_000 }).catch(() => {});
  const boot = await page.evaluate(() => {
    const b = window.__DSH_BOOT__;
    if (!b) return null;
    return {
      rev: b.rev,
      entries: (b.entries ?? []).map((e) => ({ id: e.id, inject: e.inject ?? [], external: e.external ?? [], immediately: e.immediately ?? false })),
      batches: (b.batches ?? []).map((x) => ({ phase: x.phase, entries: x.entries })),
    };
  });
  // 模块表只能在 shell boot 之后才存在（`window.__ModuleLoader__` 由 shell 建，
  // 早期还是 queue 模式）。等 boot-ready 再问。
  await page.waitForFunction('!!(window.__ModuleLoader__ && window.__ModuleLoader__.mode === "live")', null, { timeout: 60_000 }).catch(() => {});
  // 模块表 seed 只能通过 require 试，从已注册的 bundle 里问：写一个探针脚本进页面
  const seedProbe = await page.evaluate(() => {
    const out = { hasLoader: !!window.__ModuleLoader__, mode: window.__ModuleLoader__?.mode ?? null };
    try {
      // require 只在 factory 内可见；这里用注册一个临时 factory 的方式问模块表
      const got = {};
      window.__ModuleLoader__.load({
        id: '__probe__',
        factory: (require) => {
          for (const spec of [
            'react',
            'react/jsx-runtime',
            'react-dom',
            '@deepseek-ai/dsh-client-ui-primitives',
            '@deepseek-ai/dsh-client-ui-slots',
            '@deepseek-ai/dsh-client-ui-conversation',
            '@deepseek-ai/dsh-client-connection',
            '@deepseek-ai/dsh-client-locale',
          ]) {
            try {
              const m = require(spec);
              got[spec] = m === undefined ? 'undefined' : Object.keys(m).slice(0, 8);
            } catch (error) {
              got[spec] = `ERR: ${String(error.message).slice(0, 90)}`;
            }
          }
          return {};
        },
      });
      out.requireProbe = got;
    } catch (error) {
      out.loadError = String(error.message).slice(0, 200);
    }
    return out;
  });
  await browser.close();

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'boot-graph.json'), JSON.stringify(boot, null, 1), 'utf8');
  writeFileSync(join(OUT_DIR, 'module-seed.json'), JSON.stringify(seedProbe, null, 1), 'utf8');

  if (!boot) {
    console.log('FAIL: 页面里没有 window.__DSH_BOOT__（是不是没带 token？）');
    process.exit(2);
  }
  console.log(`boot rev=${boot.rev} entries=${boot.entries.length} batches=${boot.batches.length}`);
  const mine = boot.entries.filter((e) => /context-guard|census/.test(e.id));
  console.log(`本插件相关入口：${mine.length ? JSON.stringify(mine) : '(未进图)'}`);
  console.log('模块表实测：');
  for (const [k, v] of Object.entries(seedProbe.requireProbe ?? {})) {
    console.log(`  ${k} -> ${Array.isArray(v) ? `OK keys=[${v.join(',')}]` : v}`);
  }
  console.log(`完整图 -> tools/out/boot-graph.json`);
}

main().catch((error) => {
  console.log(`FAIL: ${error.message}`);
  process.exit(1);
});
