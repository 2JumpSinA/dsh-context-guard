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
  TODO_BEGIN,
  TODO_END,
  LEDGER_BEGIN,
  LEDGER_END,
  changedFiles,
  composeHandoverBlock,
  fmtTime,
  isTodoFilled,
  todoFilledIn,
  upsertLedgerRow,
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
  // v0.3.6：待补区带子标记，且标记在三条空槽之前（刷新时据此保留人工内容）
  assert.ok(block.includes(TODO_BEGIN) && block.includes(TODO_END), '待补区带子标记');
  assert.ok(block.indexOf(TODO_BEGIN) < block.indexOf('- [ ] 结论：'), '子标记在空槽之前');
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

// v0.3.6：刷新时保留「待补」人工区 —— 这条是**信息不丢**的护栏（此前整块替换会把 agent 填的结论冲掉）
test('upsertHandoverBlock：刷新后人工结论仍在，机器事实已更新', () => {
  const oldBlock = [
    beginMarker('s2'),
    '旧机器事实 1%',
    '**待补（由 agent 写）**',
    TODO_BEGIN,
    '',
    '- [ ] 结论：已完成，只剩 UI 冒烟',
    '- [ ] 踩过的坑 / 反直觉的地方：无',
    '- [ ] 未做完 / 下一步：跑真机',
    TODO_END,
    endMarker,
  ].join('\n');
  const newBlock = [
    beginMarker('s2'),
    '新机器事实 2%',
    '**待补（由 agent 写）**',
    TODO_BEGIN,
    '',
    '- [ ] 结论：',
    '- [ ] 踩过的坑 / 反直觉的地方：',
    '- [ ] 未做完 / 下一步：',
    TODO_END,
    endMarker,
  ].join('\n');

  const up = upsertHandoverBlock(`# 交接\n\n${oldBlock}\n`, 's2', newBlock);
  assert.equal(up.action, 'replaced');
  assert.ok(up.text.includes('新机器事实 2%'), '机器事实必须更新');
  assert.ok(!up.text.includes('旧机器事实 1%'), '旧机器事实要被替换掉');
  assert.ok(up.text.includes('已完成，只剩 UI 冒烟'), '人工结论必须保留');
  assert.ok(up.text.includes('跑真机'), '「下一步」必须保留');
  assert.equal(up.text.split(beginMarker('s2')).length - 1, 1, '仍然只有一块');
});

test('upsertHandoverBlock：旧块没有子标记（≤0.3.5）时，人工区靠 - [ ] 锚点保留', () => {
  const legacy = [
    beginMarker('s3'),
    '旧事实',
    '**待补（由 agent 写）**',
    '',
    '- [ ] 结论：旧结论也要活下来',
    '- [ ] 未做完 / 下一步：x',
    endMarker,
  ].join('\n');
  const fresh = [
    beginMarker('s3'),
    '新事实',
    '**待补（由 agent 写）**',
    TODO_BEGIN,
    '',
    '- [ ] 结论：',
    '- [ ] 未做完 / 下一步：',
    TODO_END,
    endMarker,
  ].join('\n');

  const up = upsertHandoverBlock(legacy, 's3', fresh);
  assert.ok(up.text.includes('旧结论也要活下来'), '旧块的结论被搬进新块');
  assert.ok(up.text.includes('新事实'), '机器事实更新');
});

// v0.4.0：把「结论还在不在」变成可判断的布尔值（banner 上显示 待补：未补 / 已补）
test('isTodoFilled / todoFilledIn：空模板=未补，写进去=已补，且只看自己那一块', () => {
  const empty = [TODO_BEGIN, '', '- [ ] 结论：', '- [ ] 踩过的坑 / 反直觉的地方：', '- [ ] 未做完 / 下一步：', TODO_END].join('\n');
  assert.equal(isTodoFilled(empty), false, '三条空槽就是未补');

  const filled = empty.replace('- [ ] 结论：', '- [ ] 结论：已经补完了');
  assert.equal(isTodoFilled(filled), true, '冒号后面有字就是已补');

  const checked = empty.replace('- [ ] 结论：', '- [x] 结论：勾上也补了');
  assert.equal(isTodoFilled(checked), true, '- [x] 也算填过');

  const prose = empty.replace('- [ ] 结论：', '结论：这一段是纯散文，没有 checkbox');
  assert.equal(isTodoFilled(prose), true, 'agent 把 checkbox 换成散文也算填过');

  const file = [
    '# 交接',
    beginMarker('mine') + '\n' + empty + '\n' + endMarker,
    beginMarker('other') + '\n' + filled + '\n' + endMarker,
  ].join('\n\n');
  assert.equal(todoFilledIn(file, 'mine'), false, '只认自己那块（别的会话填了不算）');
  assert.equal(todoFilledIn(file, 'other'), true);
  assert.equal(todoFilledIn(file, 'missing'), false, '没有块就是未补');
});

// v0.5.0：压缩账 —— 一张全局表，按 compactionId 幂等，峰值取压缩前读数
const ledgerEntry = (over = {}) => ({
  at: '2026-10-19 15:42',
  sessionId: 's9',
  peakPercent: 67.7,
  size: '≈677K/1000K',
  cost: 10.88,
  files: 2,
  eventId: 'c0ffee01',
  ...over,
});

test('upsertLedgerRow：追加成一张表，行里带峰值 / 花费 / 文件数 / 事件 id', () => {
  const first = upsertLedgerRow('# 交接\n', ledgerEntry());
  assert.equal(first.action, 'appended');
  assert.ok(first.text.includes(LEDGER_BEGIN) && first.text.includes(LEDGER_END), '要带自己的标记块');
  assert.match(first.text, /\| 1 \| 2026-10-19 15:42 \| s9 \| 67\.7% \| ≈677K\/1000K \| ¥10\.88 \| 2 \| c0ffee01 \|/);
  assert.equal(first.seq, 1);

  const second = upsertLedgerRow(first.text, ledgerEntry({ at: '2026-10-19 16:10', eventId: 'c0ffee02' }));
  assert.equal(second.action, 'appended');
  assert.equal(second.seq, 2, '行号递增');
  assert.equal(second.text.split(LEDGER_BEGIN).length - 1, 1, '全局只有一块账本');
  assert.ok(second.text.includes('c0ffee01') && second.text.includes('c0ffee02'), '两行都在');
});

test('upsertLedgerRow：同一 compactionId 重复投递只落一行', () => {
  const first = upsertLedgerRow('', ledgerEntry({ eventId: 'same' }));
  const again = upsertLedgerRow(first.text, ledgerEntry({ eventId: 'same', peakPercent: 99 }));
  assert.equal(again.action, 'unchanged');
  assert.equal(again.text, first.text, '不写盘、不改字节');
  assert.equal(again.seq, 1, '回的是已有那一行');
});

test('upsertLedgerRow：每会话最多 3 行，超了淘汰最旧的（单次只淘汰一行）', () => {
  let text = '';
  for (let i = 1; i <= 4; i += 1) text = upsertLedgerRow(text, ledgerEntry({ eventId: `e${i}`, at: `t${i}` })).text;
  const rows = text.split('\n').filter((line) => /^\|\s*\d+\s*\|/.test(line));
  assert.equal(rows.length, 3, '4 次压缩同一会话 ⇒ 只留 3 行');
  assert.ok(!text.includes('t1'), '最旧的那行被淘汰');
  assert.ok(text.includes('t4'), '最新那行在');
});

test('upsertLedgerRow：账本块只有 begin、没有 end ⇒ 拒绝写，绝不吞后面的正文', () => {
  const broken = `# 头\n\n${LEDGER_BEGIN}\n| 1 | old |\n\n# 后面是人类正文\n`;
  const out = upsertLedgerRow(broken, ledgerEntry({ eventId: 'x' }));
  assert.equal(out.action, 'broken-block');
  assert.equal(out.text, broken, '一个字都不改');
});

test('upsertLedgerRow：账行不碰自动草稿块与待补区', () => {
  const draft = `${beginMarker('s9')}\n机器事实\n${TODO_BEGIN}\n- [x] 结论：已补\n${TODO_END}\n${endMarker}`;
  const out = upsertLedgerRow(`# 头\n\n${draft}\n`, ledgerEntry());
  assert.ok(out.text.includes(draft), '草稿块逐字节不变');
  assert.equal(todoFilledIn(out.text, 's9'), true, '待补状态不受账本影响');
  assert.equal(out.text.split(LEDGER_BEGIN).length - 1, 1);
});

test('resolveHandoverPath：绝对路径原样；相对路径要 cwd；没有 cwd 就返回 null', () => {
  assert.equal(resolveHandoverPath('D:\\proj', 'HANDOVER.md'), join('D:\\proj', 'HANDOVER.md'));
  assert.equal(resolveHandoverPath('D:\\proj', 'D:\\other\\H.md'), 'D:\\other\\H.md');
  assert.equal(resolveHandoverPath(null, 'HANDOVER.md'), null);
  assert.equal(resolveHandoverPath('D:\\proj', '   '), null);
});

// CI 在 ubuntu 上抓到过这个：`isAbsolute('D:\\other\\H.md')` 在 Linux 上是 false
// ⇒ 被当相对路径拼成 'D:\\proj/D:\\other\\H.md'。反向也成立：win32 的 isAbsolute 不认 '/x'。
// 所以「自带根」必须按跨平台语义判定，而不是交给 path.isAbsolute 一个函数。
test('resolveHandoverPath：跨平台的绝对路径都要原样返回', () => {
  // Windows 形态
  assert.equal(resolveHandoverPath('/proj', 'D:\\other\\H.md'), 'D:\\other\\H.md');
  assert.equal(resolveHandoverPath('/proj', 'C:/other/H.md'), 'C:/other/H.md');
  assert.equal(resolveHandoverPath('/proj', '\\\\srv\\share\\H.md'), '\\\\srv\\share\\H.md');
  // POSIX 形态（在 Windows 上跑时 isAbsolute('/x') 为 false，同样要认）
  assert.equal(resolveHandoverPath('C:\\proj', '/home/x/H.md'), '/home/x/H.md');
  // 真正的相对路径仍必须按 cwd 解析
  assert.equal(resolveHandoverPath('/proj', 'docs/H.md'), join('/proj', 'docs/H.md'));
  // 单字母目录不能被误判成盘符（“D:” 后面必须紧跟分隔符）
  assert.equal(resolveHandoverPath('/proj', 'D:other.md'), join('/proj', 'D:other.md'));
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
