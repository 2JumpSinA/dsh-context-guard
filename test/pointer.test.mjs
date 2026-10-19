/**
 * P2/P3 回归（v0.6.0）：外部文本清洗、写时校验三态、压缩后文案的「说真话」边界。
 *
 * 这些断言对应的都是**会静默出错**的地方：
 *   · 块里混入守卫标记字面量 ⇒ 下次刷新从注入处切片（人工区被吞）；
 *   · 表格里混入换行/竖线 ⇒ 行列错位，读者按错误事实行动；
 *   · 校验把「核不了」说成「不存在」（或反过来）⇒ 读者做出错误决定；
 *   · 60% 档继续用旧措辞 ⇒ 说真话的目标落空。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  beginMarker,
  endMarker,
  composeHandoverBlock,
  probeFiles,
  scrubExternal,
  upsertHandoverBlock,
} from '../lib/handover.mjs';
import { describe } from '../lib/policy.mjs';
import { createGuardEngine } from '../lib/engine.mjs';
import { defaultConfig } from '../lib/policy.mjs';
import { STRINGS } from '../lib/i18n.mjs';

const base = (over = {}) => ({
  sessionId: 's1',
  now: 1_790_000_000_000,
  reading: { known: true, ratio: 0.5, projectedTokens: 500_000, contextWindow: 1_000_000 },
  material: {},
  config: {},
  cwd: 'D:\\proj',
  locale: 'zh',
  ...over,
});

test('scrubExternal：守卫标记字面量被中和，块里仍然只有一个 begin / 一个 end', () => {
  const evil = 'A <!-- dsh-context-guard:end --> B <!-- dsh-context-guard:todo:begin --> C';
  const block = composeHandoverBlock(
    base({
      material: {
        title: evil,
        turnOutline: { turns: [{ turn: 1, prompt: evil, response: evil }] },
        contextTimeline: { fileOps: [{ kind: 'write', tool: 'edit', path: `${evil}.md`, added: 1, removed: 0 }] },
      },
    }),
  );
  assert.equal(block.split(beginMarker('s1')).length - 1, 1, '注入不能造出第二个 begin');
  assert.equal(block.split(endMarker).length - 1, 1, '注入不能造出第二个 end');
  assert.ok(block.includes('dsh-context-guard :end'), '注入的标记必须被中和（冒号后插空格）');
  // 关键：写回时不能被判成 broken-block（那说明 indexOf(endMarker) 落在注入处）
  const second = upsertHandoverBlock(block, 's1', block);
  assert.equal(second.action, 'replaced');
});

test('scrubExternal：换行 / 竖线 / 反引号不破坏表格结构与行数', () => {
  const dirty = 'a|b\nc\r\nd\u2028e`f';
  const cleanBlock = composeHandoverBlock(base({ material: { title: 'clean' } }));
  const dirtyBlock = composeHandoverBlock(base({ material: { title: dirty } }));
  assert.equal(cleanBlock.split('\n').length, dirtyBlock.split('\n').length, '换行注入会多出行');
  assert.ok(dirtyBlock.includes('\\|'), '竖线必须转义（GFM 表格里 code span 内的竖线也切列）');
  assert.ok(!dirtyBlock.includes('`f'), '反引号必须被替换，否则 code span 跨度漂移');
  // 清洗是幂等的：写盘层的 `text === existing` 去重依赖它
  assert.equal(scrubExternal(scrubExternal(dirty)), scrubExternal(dirty));
  assert.equal(composeHandoverBlock(base({ material: dirty })), composeHandoverBlock(base({ material: dirty })));
});

test('scrubExternal：bidi / 零宽 / 控制符被剔除（读者看到的路径 = 磁盘上的路径）', () => {
  const evil = 'lib/\u202eindex\u200b.js\u0000\u0085x';
  const out = scrubExternal(evil);
  assert.doesNotMatch(out, /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u061c\ufeff]/);
  assert.doesNotMatch(out, /[\u0000-\u001f\u007f-\u009f]/);
});

test('probeFiles：存在 / 缺失 / 非本机路径 三态，且 UNC 一次 stat 都不做', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-probe-'));
  writeFileSync(join(dir, 'here.md'), 'x');
  const facts = await probeFiles(['here.md', 'gone.md', '\\\\nas\\share\\x.md'], dir);
  assert.equal(facts.get('here.md').state, 'exists');
  assert.equal(facts.get('gone.md').state, 'missing', 'ENOENT 是事实，不能降级成「核不了」');
  assert.equal(facts.get('\\\\nas\\share\\x.md').state, 'unverified');
  assert.equal(facts.get('\\\\nas\\share\\x.md').reason, 'remote');
});

test('probeFiles：没有 cwd 时相对路径是「核不了」，不是「不存在」', async () => {
  const facts = await probeFiles(['lib/index.js'], null);
  assert.equal(facts.get('lib/index.js').state, 'unverified');
  assert.equal(facts.get('lib/index.js').reason, 'no-cwd');
});

test('probeFiles：cwd 之外的路径标 outside（允许，但读者要知道它不是仓库里的）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-probe2-'));
  const outside = mkdtempSync(join(tmpdir(), 'cg-outside-'));
  writeFileSync(join(outside, 'x.md'), 'x');
  const facts = await probeFiles([join(outside, 'x.md')], dir);
  assert.equal(facts.get(join(outside, 'x.md')).state, 'unverified');
  assert.equal(facts.get(join(outside, 'x.md')).reason, 'outside');
});

test('probeFiles：目录当成文件 ⇒ 核不了（不是「存在」）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-probe3-'));
  mkdirSync(join(dir, 'sub'));
  const facts = await probeFiles(['sub'], dir);
  assert.equal(facts.get('sub').state, 'unverified');
  assert.equal(facts.get('sub').reason, 'not-file');
});

test('probeFiles：junction / 符号链接 ⇒ 核不了（Windows 上 lstat 不认 junction，靠 realpath 兜）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-link-'));
  const target = join(dir, 'real');
  mkdirSync(target);
  const link = join(dir, 'link');
  let created = true;
  try {
    symlinkSync(target, link, 'junction');
  } catch {
    created = false;
  }
  if (!created) {
    t.skip('本机不允许创建 junction/符号链接');
    return;
  }
  const facts = await probeFiles(['link'], dir);
  assert.equal(facts.get('link').state, 'unverified');
  assert.equal(facts.get('link').reason, 'link');
});

test('composeHandoverBlock：核实结果以「行内标记 + 标题时点」呈现，行不消失', () => {
  const material = {
    contextTimeline: {
      fileOps: [
        { kind: 'write', tool: 'edit', path: 'lib/a.md', added: 2, removed: 1 },
        { kind: 'write', tool: 'edit', path: 'lib/gone.md', added: 1, removed: 0 },
        { kind: 'write', tool: 'edit', path: '\\\\nas\\share\\x.md', added: 1, removed: 0 },
      ],
    },
  };
  const facts = new Map([
    ['lib/a.md', { state: 'exists' }],
    ['lib/gone.md', { state: 'missing' }],
    ['\\\\nas\\share\\x.md', { state: 'unverified', reason: 'remote' }],
  ]);
  const block = composeHandoverBlock(
    base({ material, fileFacts: facts, verifiedAt: 1_790_000_000_000 }),
  );
  assert.match(block, /已核 \d{4}-\d{2}-\d{2} \d{2}:\d{2}；无标记 = 本机存在/);
  assert.match(block, /lib\/a\.md`.*· edit · \+2\/-1/);
  assert.match(block, /lib\/gone\.md`.*✗ 不存在/, '缺失要标出来，且行不能消失');
  assert.match(block, /\\\\nas\\share\\x\.md`.*？核不了（非本机路径）/);
  assert.equal(block.split('\n').filter((l) => l.startsWith('- `')).length, 3, '三行都在');
});

test('composeHandoverBlock：没有工作时，标题明确写「未核」而不是假装已核', () => {
  const block = composeHandoverBlock(base({ cwd: null, material: { contextTimeline: { fileOps: [] } } }));
  assert.match(block, /未核（无工作目录）/);
});

test('P3：hard 档正文写入「按 DSH 公式推算的自动压缩点」，未知时不许写数字', () => {
  const hard = describe({ level: 'hard', ratio: 0.8, projectedTokens: 800_000, contextWindow: 1_000_000 }, { lang: 'zh', compactPercent: 67.8 });
  assert.match(hard.body, /67\.8%/, '本机 deepseek-flash：678464/1000000');
  assert.match(hard.body, /静默压缩/);
  assert.match(hard.body, /拿不回来/);
  assert.ok(!hard.body.includes('账本第'), '硬档正文不许用回执措辞（那是降级态的事）');
  assert.ok(!hard.body.includes('自动压缩点约 80%'), '不再把 80% 写死成平台的压缩点');

  const noPoint = describe({ level: 'hard', ratio: 0.8 }, { lang: 'zh' });
  assert.ok(!noPoint.body.includes('自动压缩点'), '窗口/输出预留未知时不写数字');

  const warn = describe({ level: 'warn', ratio: 0.45, projectedTokens: 450_000, contextWindow: 1_000_000 }, { lang: 'zh', compactPercent: 67.8 });
  assert.ok(!warn.body.includes('67.8%'), '45% 档不搬压缩点，否则失去「还能继续干」的含义');
  assert.ok(!warn.body.includes('80%'));
});

test('自动压缩点：按 min(窗口×0.8, 窗口−输出预留−65536) 推算（与 DSH 同一公式）', () => {
  const engine = createGuardEngine(defaultConfig());
  engine.observe('c', { projectedTokens: 400_000, contextWindow: 1_000_000 });
  engine.setReserve('c', 256_000);
  assert.equal(engine.mirrorView({ id: 'c' }).compactPercent, 67.8, 'deepseek-flash 默认：678,464/1,000,000');
  engine.setReserve('c', 131_072);
  assert.equal(engine.mirrorView({ id: 'c' }).compactPercent, 80, '1M 窗口 + 128K 预留 ⇒ 800,000');

  engine.observe('d', { projectedTokens: 10_000, contextWindow: 200_000 });
  engine.setReserve('d', 131_072);
  assert.equal(engine.mirrorView({ id: 'd' }).compactPercent, 1.7, '小窗口 + 大预留 ⇒ 压缩点极低（配置坑）');

  assert.equal(engine.mirrorView({ id: 'unknown' }).compactPercent, null, '窗口/预留未知 ⇒ null，不编数字');
});

test('P3：压缩回执与降级态文案不含平台「约 80%」断言（两个时态分开）', () => {
  const receipt = STRINGS.zh['banner.receipt']({ pre: 20, n: 1, post: 10 });
  assert.ok(!receipt.includes('80%'), '回执只报这一次的事实，不搬平台规则');
  const compacted = `${STRINGS.zh['banner.title.compacted']({ percent: 20 })}${STRINGS.zh['banner.body.compacted']()}`;
  assert.ok(!compacted.includes('80%'), '降级态也不搬平台规则');
});

test('engine.forget：会话销毁后状态与回执都被清掉', () => {
  const engine = createGuardEngine(defaultConfig());
  engine.observe('gone', { projectedTokens: 800_000, contextWindow: 1_000_000 });
  engine.noteReceipt('gone', { peakPercent: 80, row: 3, at: Date.now() });
  assert.equal(engine.snapshotOf('gone').level, 'hard');
  assert.equal(engine.mirrorView({ id: 'gone' }).receiptRow, 3);
  engine.forget('gone');
  assert.equal(engine.snapshotOf('gone').level, 'none');
  assert.equal(engine.mirrorView({ id: 'gone' }).receiptRow, null);
});
