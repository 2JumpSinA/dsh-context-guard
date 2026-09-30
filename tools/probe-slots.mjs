/**
 * 槽位探针：在**真机页面里**把插件自己的组件分别挂到几个候选席位，看哪个真的渲染出来。
 *
 * 为什么需要它：会话头 utilities 已被证明会渲染（徽标出现了），但单看静态代码无法确定
 * 「banner 该放哪个席位」—— 各席位的渲染条件（有没有活跃会话、composer 是否在可见视图里、
 * 门户层是否挂载）只有跑起来才知道。与其猜，不如就地试一遍。
 *
 * 依赖插件暴露的排障把手：`window.__DSH_CONTEXT_GUARD__`（含 store / Badge / Banner / ctx / react 垫片）。
 *
 * 跑法：`node tools/probe-slots.mjs <port> --log=<探针日志>`
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

const CANDIDATES = [
  'conversation.input.dock',
  'conversation.composer.dock',
  'conversation.input.overlay',
  'shell.overlay',
  'conversation.input.left',
  'conversation.input.right',
];

const main = async () => {
  const { chromium } = await import('file:///D:/dsh-home/profiles/web/node_modules/playwright-core/index.mjs');
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage();
  const pageLogs = [];
  page.on('console', (m) => {
    if (/context-guard|slot-probe/i.test(m.text()) || m.type() === 'error') pageLogs.push(`${m.type()}: ${String(m.text()).slice(0, 220)}`);
  });

  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token())}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForFunction(() => !/Loading plugins/i.test(document.body.innerText ?? ''), null, { timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, a, [role="button"]')].find((n) => /新建会话|new session/i.test(n.getAttribute('aria-label') ?? ''));
    if (el) el.click();
  });
  await page.waitForTimeout(3000);

  const setup = await page.evaluate((candidates) => {
    const g = window.__DSH_CONTEXT_GUARD__;
    if (!g || !g.ctx || !g.ctx.slots) return { error: 'no ctx handle / no slots' };
    if (!g.react && !g.createElement) return { error: 'no react shim on the debug handle' };
    const react = g.react;
    const out = {};
    for (const name of candidates) {
      try {
        const Mark = function () {
          return react.createElement('div', {
            'data-slot-probe': name,
            style: { padding: '2px 6px', border: '1px dashed #999', fontSize: '10px' },
          }, 'probe:' + name);
        };
        g.ctx.slots.inject(name, function () {
          return g.ctx.slots.register({ name: name, id: 'slot-probe:' + name, order: 999 }, Mark);
        });
        out[name] = 'registered';
      } catch (error) {
        out[name] = 'error: ' + String(error.message).slice(0, 140);
      }
    }
    return { out, sessions: 'n/a' };
  }, CANDIDATES);
  await page.waitForTimeout(2500);

  const hits = await page.evaluate((candidates) => {
    const found = {};
    for (const name of candidates) found[name] = document.querySelectorAll(`[data-slot-probe="${name}"]`).length;
    return found;
  }, CANDIDATES);

  await browser.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'slot-probe.json'), JSON.stringify({ setup, hits, pageLogs }, null, 1), 'utf8');

  console.log('候选席位的真实渲染结果（DOM 里出现次数 > 0 即可用）：');
  for (const name of CANDIDATES) console.log(`  ${name}: ${hits[name] ?? 0}   [${setup.out?.[name] ?? setup.error}]`);
  if (pageLogs.length) console.log(`pageLogs: ${JSON.stringify(pageLogs.slice(0, 4))}`);
};

main().catch((error) => {
  console.log(`FAIL: ${error.message}`);
  process.exit(1);
});
