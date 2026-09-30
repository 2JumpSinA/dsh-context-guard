/**
 * 自动交接草稿的单元测试（纯函数 + IO 失败面）。
 * 集成面（真跑 apply + 假投影）在 `tools/selftest.mjs` 的 6f。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  beginMarker,
  endMarker,
  changedFiles,
  composeHandoverBlock,
  fmtTime,
  recentTurns,
  resolveHandoverPath,
  toolMix,
  upsertHandoverBlock,
  writeHandoverBlock,
} from '../lib/handover.mjs';

const reading = { known: true, ratio: 0.52, projectedTokens: 520_000, contextWindow: 1_000_000 };

test('changedFiles：只认 kind=write、跳过失败项、倒序去重、受 max 限制', () => {
  const ops = [
    { kind: 'read', path: 'a.mjs', time: 1 },
    { kind: 'write', path: 'b.mjs', tool: 'edit', added: 2, removed: 1, time: 2 },
    { kind: 'write', path: 'b.mjs', tool: 'edit', added: 9, removed: 9, time: 3 },
    { kind: 'write', path: 'c.mjs', err: true, time: 4 },
    { kind: 'write', path: 'd.mjs', tool: 'write', added: 5, removed: 0, time: 5 },
  ];
  const out = changedFiles(ops, 5);
  assert.deepEqual(out.map((f) => f.path), ['d.mjs', 'b.mjs']);
  assert.equal(out[1].added, 9, '倒序时应该保留**最新**那次写');
  assert.equal(changedFiles(ops, 1).length, 1);
  assert.deepEqual(changedFiles(null), []);
});

test('recentTurns：取最近 N 轮、压平空白、截断', () => {
  const turns = Array.from({ length: 8 }, (_, i) => ({ turn: i + 1, prompt: `  第${i + 1}轮\n诉求  `, response: 'x'.repeat(300) }));
  const out = recentTurns({ turns }, 3);
  assert.deepEqual(out.map((t) => t.turn), [6, 7, 8]);
  assert.equal(out[0].prompt, '第6轮 诉求');
  assert.equal(out[0].response.length, 160);
  assert.deepEqual(recentTurns(null, 3), []);
});

test('toolMix：按调用数倒序、受 max 限制', () => {
  const out = toolMix({ tools: { read: { calls: 3 }, pwsh: { calls: 9 }, edit: { calls: 5 } } }, 2);
  assert.deepEqual(out.map((t) => t.tool), ['pwsh', 'edit']);
  assert.deepEqual(toolMix(null), []);
});

test('fmtTime：本地时间固定形状；非法值给破折号', () => {
  assert.match(fmtTime(Date.UTC(2026, 8, 29, 10, 5)), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(fmtTime(undefined), '—');
});

test('composeHandoverBlock：带标记 + 机器事实 + 待补空槽', () => {
  const block = composeHandoverBlock({
    sessionId: 's1',
    now: 1_790_000_000_000,
    reading,
    cwd: 'D:\\proj',
    config: { handoverTurns: 2, handoverFiles: 3 },
    material: {
      title: '阈值校准',
      identity: { createdAt: 1_789_000_000_000 },
      tokenCost: { calls: 42, cost: 1.234, lastActivity: 1_790_000_000_000 },
      sessionStats: { turns: 7 },
      contextTimeline: {
        contextWindow: 1_000_000,
        timing: { toolCalls: 12, tools: { pwsh: { calls: 9 } } },
        fileOps: [{ kind: 'write', tool: 'edit', path: 'lib/policy.mjs', added: 6, removed: 2, time: 1 }],
      },
      turnOutline: { turns: [{ turn: 7, prompt: '把阈值改掉', response: '改完了' }] },
    },
  });
  assert.ok(block.startsWith(beginMarker('s1')));
  assert.ok(block.trimEnd().endsWith(endMarker));
  assert.match(block, /\*\*52\.0%\*\*/);
  assert.match(block, /¥1\.23/);
  assert.match(block, /lib\/policy\.mjs/);
  assert.match(block, /把阈值改掉/);
  assert.match(block, /- \[ \] 结论：/);
});

test('composeHandoverBlock：locale=en 时整块英文（§19.6 的落点）', () => {
  const block = composeHandoverBlock({
    sessionId: 's1',
    now: 1_790_000_000_000,
    reading,
    cwd: 'D:\\proj',
    locale: 'en',
    config: { handoverTurns: 2, handoverFiles: 3 },
    material: {
      title: 'threshold calibration',
      identity: { createdAt: 1_789_000_000_000 },
      tokenCost: { calls: 42, cost: 1.234, lastActivity: 1_790_000_000_000 },
      sessionStats: { turns: 7 },
      contextTimeline: {
        contextWindow: 1_000_000,
        timing: { toolCalls: 12, tools: { pwsh: { calls: 9 } } },
        fileOps: [{ kind: 'write', tool: 'edit', path: 'lib/policy.mjs', added: 6, removed: 2, time: 1 }],
      },
      turnOutline: { turns: [{ turn: 7, prompt: 'drop the ratio', response: 'done' }] },
    },
  });
  // 结构照旧：标记、机器事实、待补空槽
  assert.ok(block.startsWith(beginMarker('s1')));
  assert.ok(block.trimEnd().endsWith(endMarker));
  assert.match(block, /\*\*52\.0%\*\*/);
  assert.match(block, /¥1\.23/);
  assert.match(block, /lib\/policy\.mjs/);
  // 外框是英文的
  assert.match(block, /Auto handoff draft/);
  assert.match(block, /\| Item \| Value \|/);
  assert.match(block, /\*\*To fill in \(by the agent\)\*\*/);
  assert.match(block, /- \[ \] Conclusions:/);
  // 用户自己写的内容（标题 / 诉求）必须原样透传，不许被语言层改写
  assert.match(block, /threshold calibration/);
  assert.match(block, /drop the ratio/);
  // 整块不许混汉字
  assert.doesNotMatch(block, /[\u3400-\u4dbf\u4e00-\u9fff]/);
});

test('composeHandoverBlock：素材缺席不抛，且不假装有数据', () => {
  const block = composeHandoverBlock({
    sessionId: 's2',
    now: 1_790_000_000_000,
    reading: { known: false, ratio: null },
    material: {},
    config: {},
    cwd: null,
  });
  assert.match(block, /fail-closed，不假装 0%/);
  assert.match(block, /（本次会话没有 `write` 类文件操作）/);
  assert.match(block, /（宿主没有提供 `turnOutline`）/);
  assert.match(block, /（未知）/);
  // 同样「没数据」的话，en 版要说得一样明确（fail-closed 的措辞是双语各一套，不是照抄中文）
  const en = composeHandoverBlock({
    sessionId: 's2',
    now: 1_790_000_000_000,
    reading: { known: false, ratio: null },
    material: {},
    config: {},
    cwd: null,
    locale: 'en',
  });
  assert.match(en, /no data \(fail-closed; not pretending it is 0%\)/);
  assert.match(en, /\(no `write` file operations in this session\)/);
  assert.match(en, /\(the host did not provide `turnOutline`\)/);
  assert.match(en, /\(untitled\)/);
  assert.match(en, /\(unknown\)/);
});

test('recentTurns：wire 视图是数组、宿主状态是 {turns}，两种形状都收', () => {
  const wire = [
    { turn: 1, prompt: 'A', response: 'B' },
    { turn: 2, prompt: 'C', response: 'D' },
  ];
  assert.deepEqual(recentTurns(wire).map((t) => t.turn), [1, 2]);
  assert.deepEqual(recentTurns({ turns: wire, draft: 'x' }).map((t) => t.turn), [1, 2]);
  assert.deepEqual(recentTurns(wire, 1).map((t) => t.turn), [2]);
  assert.deepEqual(recentTurns(undefined), []);
  assert.deepEqual(recentTurns({ turns: [] }), []);
});

test('composeHandoverBlock：slim head 无 fileOps ⇒ 该段如实报空，不编造', () => {
  const block = composeHandoverBlock({
    sessionId: 's3',
    now: 1_790_000_000_000,
    reading,
    cwd: 'D:\\proj',
    config: {},
    material: {
      // dsh-context 的 buildTimelineHead：有 timing / contextWindow / detailRev，**没有 fileOps**
      contextTimeline: {
        contextWindow: 1_000_000,
        timing: { toolCalls: 5, tools: { pwsh: { calls: 5 } } },
        detailRev: 9,
      },
      // wire 数组形状：以前读 `.turns` 会印「宿主没有提供」
      turnOutline: [{ turn: 3, prompt: '把阈值改掉', response: '改完了' }],
    },
  });
  assert.match(block, /（本次会话没有 `write` 类文件操作）/);
  assert.match(block, /工具分布 \| pwsh 5/);
  assert.match(block, /把阈值改掉/);
  assert.match(block, /改完了/);
});

test('upsertHandoverBlock：没有则追加、有则整块替换（且不动别的会话的块）', () => {
  const blockA = `${beginMarker('a')}\nAAA\n${endMarker}`;
  const blockB = `${beginMarker('b')}\nBBB\n${endMarker}`;
  const first = upsertHandoverBlock('# 交接\n\n正文\n', 'a', blockA);
  assert.equal(first.action, 'appended');
  assert.match(first.text, /# 交接\n\n正文\n\n<!-- dsh-context-guard:begin a -->/);

  const two = upsertHandoverBlock(first.text, 'b', blockB);
  const replaced = upsertHandoverBlock(two.text, 'a', `${beginMarker('a')}\nAAA2\n${endMarker}`);
  assert.equal(replaced.action, 'replaced');
  assert.match(replaced.text, /AAA2/);
  assert.doesNotMatch(replaced.text, /AAA\n/);
  assert.match(replaced.text, /BBB/, '别的会话那块必须原样保留');
  assert.match(replaced.text, /# 交接/, '正文不动');
});

test('resolveHandoverPath：绝对路径原样；相对路径要 cwd；没有 cwd 就返回 null', () => {
  assert.equal(resolveHandoverPath('D:\\proj', 'HANDOVER.md'), join('D:\\proj', 'HANDOVER.md'));
  assert.equal(resolveHandoverPath('D:\\proj', 'D:\\other\\H.md'), 'D:\\other\\H.md');
  assert.equal(resolveHandoverPath(null, 'HANDOVER.md'), null);
  assert.equal(resolveHandoverPath('D:\\proj', '   '), null);
});

test('writeHandoverBlock：写出、二次调用幂等（只有一块），且返回的 path 只有文件名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-ho-'));
  const file = join(dir, 'HANDOVER.md');
  const block = `${beginMarker('s1')}\n第一版\n${endMarker}`;
  const r1 = await writeHandoverBlock({ file, sessionId: 's1', block });
  assert.equal(r1.status, 'appended');
  assert.equal(r1.path, 'HANDOVER.md', '只回文件名：状态路由是本地无认证路由，绝不回绝对路径');
  assert.match(readFileSync(file, 'utf8'), /第一版/);

  const r2 = await writeHandoverBlock({ file, sessionId: 's1', block: `${beginMarker('s1')}\n第二版\n${endMarker}` });
  assert.equal(r2.status, 'replaced');
  const text = readFileSync(file, 'utf8');
  assert.equal((text.match(/dsh-context-guard:begin/g) ?? []).length, 1);
  assert.match(text, /第二版/);
  assert.doesNotMatch(text, /第一版/);
  assert.equal(existsSync(`${file}.dsh-context-guard.tmp`), false, '临时文件必须已被 rename 掉');
});

test('writeHandoverBlock：写不进去时返回 error 而**不抛**', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-ho-'));
  mkdirSync(join(dir, 'adir'));
  const r = await writeHandoverBlock({ file: join(dir, 'adir'), sessionId: 's1', block: 'x' });
  assert.equal(r.status, 'error');
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
  assert.equal((await writeHandoverBlock({ file: '', sessionId: 's1', block: 'x' })).error, 'no-cwd');
});

test('writeHandoverBlock：既有文件里的正文与其它会话的块都不受影响', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-ho-'));
  const file = join(dir, 'HANDOVER.md');
  writeFileSync(file, `# 交接\n\n${beginMarker('other')}\n别的\n${endMarker}\n\n尾部\n`, 'utf8');
  await writeHandoverBlock({ file, sessionId: 'mine', block: `${beginMarker('mine')}\n我的\n${endMarker}` });
  const text = readFileSync(file, 'utf8');
  assert.match(text, /# 交接/);
  assert.match(text, /别的/);
  assert.match(text, /尾部/);
  assert.match(text, /我的/);
});

// ————————————————————————————————————————————————————————————————
// 2026-09-30 安全审计（P1-1）加固后的边界：逐条证伪
// ————————————————————————————————————————————————————————————————

test('writeHandoverBlock：父目录不存在 ⇒ 拒绝，且不创建目录（不 mass-mkdir）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-ho-'));
  const r = await writeHandoverBlock({ file: join(dir, 'nope', 'HANDOVER.md'), sessionId: 's1', block: 'x' });
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'no-parent-dir');
  assert.equal(existsSync(join(dir, 'nope')), false);
});

test('writeHandoverBlock：目标已存在但不是文本类文件 ⇒ 拒绝改写（foreign-file），原文件一字不动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-ho-'));
  const file = join(dir, 'package.json');
  writeFileSync(file, '{"a":1}\n', 'utf8');
  const r = await writeHandoverBlock({ file, sessionId: 's1', block: 'x' });
  assert.equal(r.error, 'foreign-file');
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n');
});

test('writeHandoverBlock：符号链接 ⇒ 拒绝（不跟随链接改写真实目标）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-ho-'));
  const real = join(dir, 'real.md');
  writeFileSync(real, '# real\n', 'utf8');
  const link = join(dir, 'link.md');
  try {
    symlinkSync(real, link);
  } catch {
    t.skip('本机不允许创建符号链接（Windows 需开发者模式）');
    return;
  }
  const r = await writeHandoverBlock({ file: link, sessionId: 's1', block: 'x' });
  assert.equal(r.error, 'symlink');
  assert.equal(readFileSync(real, 'utf8'), '# real\n');
});
