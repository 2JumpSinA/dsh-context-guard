/**
 * 读插件在真机页面里的**实时状态**：每会话读数、档位、banner 是否已出过声。
 * 用来回答「徽标有数字了，为什么 banner 不出现」这类只能实测的问题。
 *
 * 跑法：`node tools/dump-state.mjs <port> --log=<探针日志>`
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const PORT = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '3099';

function token() {
  const path = (process.argv.find((a) => a.startsWith('--log=')) ?? '').slice('--log='.length);
  if (!path) throw new Error('需要 --log=<探针 stdout 日志>');
  const out = execFileSync(
    'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoLogo', '-NoProfile', '-Command',
      `$fs=[System.IO.File]::Open('${path.replace(/'/g, "''")}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite);$ms=New-Object System.IO.MemoryStream;$fs.CopyTo($ms);$fs.Dispose();$b=$ms.ToArray();$ms.Dispose();$c=New-Object 'System.Collections.Generic.List[byte]';foreach($x in $b){if($x -ne 0){$c.Add($x)}};[System.Text.Encoding]::UTF8.GetString($c.ToArray())`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const line = out.split(/\r?\n/).find((l) => /dsh web: http/.test(l));
  const m = line && /[?&]token=([A-Za-z0-9._-]+)/.exec(line);
  if (!m) throw new Error('日志里没有 URL 行');
  return m[1];
}

const main = async () => {
  const { chromium } = await import('file:///D:/dsh-home/profiles/web/node_modules/playwright-core/index.mjs');
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__DSH_CONTEXT_GUARD__ = { config: { warnRatio: 0.01, hardRatio: 0.02, cooldownTurns: 0 } };
  });
  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token())}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForFunction(() => !/Loading plugins/i.test(document.body.innerText ?? ''), null, { timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, a, [role="button"]')].find((n) => /新建会话|new session/i.test(n.getAttribute('aria-label') ?? ''));
    if (el) el.click();
  });
  await page.waitForTimeout(2500);
  // 再点一个**已有会话**（侧栏里带 data-session-id 的那类）—— 只有进了有历史的会话，
  // contextPressure 才有值；空会话的投影是缺席的（fail-closed，徽标会显示「ctx —」）。
  const clickedSession = await page.evaluate(() => {
    const first = document.querySelector('[data-session-id]');
    if (!first) return null;
    first.click();
    return first.getAttribute('data-session-id');
  });
  await page.waitForTimeout(4000);

  const state = await page.evaluate(() => {
    const g = window.__DSH_CONTEXT_GUARD__;
    if (!g) return { present: false };
    const badge = document.querySelector('[data-dsh-context-guard="badge"]');
    const banner = document.querySelector('[data-dsh-context-guard="banner"]');
    let sessions = null;
    try {
      sessions = typeof g.store?.dump === 'function' ? g.store.dump() : null;
    } catch (error) {
      sessions = { error: String(error.message) };
    }
    const dock = document.querySelector('[class*="dock" i]');
    return {
      present: true,
      config: g.config,
      hasSlots: g.hasSlots,
      calls: g.calls,
      sessions: sessions,
      badgeText: badge ? (badge.textContent ?? '').trim() : null,
      badgeTitle: badge ? badge.getAttribute('title') : null,
      bannerPresent: Boolean(banner),
      dockHtml: dock ? dock.innerHTML.slice(0, 300) : null,
      bannerSlots: document.querySelectorAll('[data-slot-probe]').length,
    };
  });
  await browser.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'plugin-state.json'), JSON.stringify(state, null, 1), 'utf8');
  console.log(`config.warn=${state.config?.warnRatio} hard=${state.config?.hardRatio} cooldown=${state.config?.cooldownTurns}`);
  console.log(`badge=${JSON.stringify(state.badgeText)}  bannerPresent=${state.bannerPresent}`);
  console.log(`sessions=${JSON.stringify(state.sessions)}`);
};

main().catch((error) => {
  console.log(`FAIL: ${error.message}`);
  process.exit(1);
});
