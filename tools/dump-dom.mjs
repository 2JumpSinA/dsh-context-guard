/**
 * 排障用：把 DSH Web 页面挂起来之后的**可见文本与可点元素**倒出来。
 * 只在「槽位为什么不渲染」这类问题上用；输出落 `tools/out/dom-dump.json`，stdout 只给结论。
 *
 * 跑法：`node tools/dump-dom.mjs <port> --log=<探针日志> [--click=<正则>]`
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const PORT = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : '3099';
const CLICK = (process.argv.find((a) => a.startsWith('--click=')) ?? '').slice('--click='.length);

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
  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token())}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => !/Loading plugins/i.test(document.body.innerText ?? ''), null, { timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  if (CLICK) {
    await page.evaluate((pattern) => {
      const re = new RegExp(pattern, 'i');
      const el = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')].find((n) => re.test(n.textContent ?? '') || re.test(n.getAttribute('aria-label') ?? '') || re.test(n.getAttribute('title') ?? ''));
      if (el) el.click();
    }, CLICK);
    await page.waitForTimeout(2500);
  }
  UNSET=1
  const dump = await page.evaluate(() => {
    const clickable = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], input, textarea')].map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').trim().slice(0, 60),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      role: el.getAttribute('role'),
      cls: (el.className ?? '').toString().slice(0, 60),
    }));
    // 探槽位系统：DSH 的 shell 会不会把 slots 服务暴露在全局？
    const probe = {};
    try {
      probe.globals = Object.keys(window).filter((k) => /dsh|slot|module/i.test(k)).slice(0, 30);
      probe.moduleRecords = window.__ModuleLoader__?.create === undefined ? 'no create' : 'has create';
    } catch (error) {
      probe.error = String(error.message);
    }
    // 会话是否真的开了：找 composer（contenteditable / textarea）与会话头
    probe.editors = document.querySelectorAll('[contenteditable="true"], textarea').length;
    probe.headings = [...document.querySelectorAll('h1,h2,[role="heading"]')].map((h) => (h.textContent ?? '').trim().slice(0, 40)).slice(0, 6);
    return {
      // ⛔ 刻意**不**落 body 文本 / HTML：在真实页面上那就是会话正文（安全审计 P0-2）。
      //    要看结构请用 clickable / probe；要看文本自己在浏览器里看，别落进文件。
      clickable: clickable.slice(0, 60),
      guardNodes: document.querySelectorAll('[data-dsh-context-guard]').length,
      probe,
    };
  });
  await browser.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'dom-dump.json'), JSON.stringify(dump, null, 1), 'utf8');
  console.log(`guardNodes=${dump.guardNodes} clickable=${dump.clickable.length}`);
  console.log('clickable:');
  for (const c of dump.clickable.slice(0, 20)) console.log(`  <${c.tag}> ${JSON.stringify(c.text)} aria=${c.aria} title=${c.title}`);
};

main().catch((error) => {
  console.log(`FAIL: ${error.message}`);
  process.exit(1);
});
