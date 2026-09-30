/**
 * 排障：页面挂起来 + 点新建会话之后，把**会话头与 composer 附近的 DOM**倒出来，
 * 并读插件的排障把手。用来回答「槽位到底有没有渲染」这类只能实测的问题。
 *
 * 跑法：`node tools/inspect-slots.mjs <port> --log=<探针日志>`
 * 输出落 `tools/out/slot-inspection.json`，stdout 只给结论行。
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error' || /context-guard/i.test(m.text())) errors.push(`${m.type()}: ${String(m.text()).slice(0, 300)}`);
  });
  await page.addInitScript(() => {
    window.__DSH_CONTEXT_GUARD__ = { config: { warnRatio: 0.01, hardRatio: 0.02, cooldownTurns: 0 } };
  });
  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token())}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => !/Loading plugins/i.test(document.body.innerText ?? ''), null, { timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, a, [role="button"]')].find((n) => /新建会话|new session/i.test(n.getAttribute('aria-label') ?? '') || /新建会话|new session/i.test(n.textContent ?? ''));
    if (el) el.click();
  });
  await page.waitForTimeout(3500);

  const info = await page.evaluate(() => {
    const g = window.__DSH_CONTEXT_GUARD__ || null;
    const guard = [...document.querySelectorAll('[data-dsh-context-guard]')].map((el) => ({
      kind: el.getAttribute('data-dsh-context-guard'),
      level: el.getAttribute('data-level'),
      text: (el.textContent ?? '').trim().slice(0, 80),
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
    }));
    // 会话头：从「上下文洞察/设置」这类头部控件往上找容器，看看里面有什么
    const headerish = [...document.querySelectorAll('header, [class*="header" i], [class*="Header"]')].slice(0, 6).map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className ?? '').toString().slice(0, 80),
      childCount: el.children.length,
      text: (el.textContent ?? '').trim().slice(0, 120),
      html: el.innerHTML.slice(0, 500),
    }));
    const anyContext = [...document.querySelectorAll('*')].filter((el) => /context-guard|ctx\s*\d|ctx\s*—/i.test(el.textContent ?? '') && el.children.length === 0).slice(0, 5).map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').trim().slice(0, 60), cls: (el.className ?? '').toString().slice(0, 60) }));
    return {
      guard,
      guardNodeCount: guard.length,
      pluginDebug: g ? { present: true, hasSlots: g.hasSlots, calls: g.calls, config: g.config } : { present: false },
      headerish,
      anyContext,
      editors: document.querySelectorAll('[contenteditable="true"], textarea').length,
    };
  });
  await browser.close();
  mkdirSync(OUT, { recursive: true });
  info.errors = errors.slice(0, 15);
  writeFileSync(join(OUT, 'slot-inspection.json'), JSON.stringify(info, null, 1), 'utf8');

  console.log(`guardNodes=${info.guardNodeCount} editors=${info.editors}`);
  console.log(`pluginDebug.hasSlots=${info.pluginDebug.hasSlots} calls=${JSON.stringify(info.pluginDebug.calls)}`);
  console.log(`anyContextMatches=${info.anyContext.length}`);
  console.log(`headerish=${info.headerish.length} 第一个子元素数=${info.headerish[0]?.childCount}`);
  if (info.errors.length) console.log(`errors=${JSON.stringify(info.errors.slice(0, 5))}`);
};

main().catch((error) => {
  console.log(`FAIL: ${error.message}`);
  process.exit(1);
});
