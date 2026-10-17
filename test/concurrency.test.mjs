/**
 * P1-3 回归：多会话**并发**写同一个 `HANDOVER.md` 时不得丢块。
 *
 * 病灶：`index.js` 的 `pending` 是按 sessionId 的，而资源是**同一个文件** ⇒
 * 「读 → upsert → 写 → rename」跨 await 交错会让后写者覆盖前写者的块（永久丢块）。
 * 修复：`writeHandoverBlock` 内部按**文件名**串行排队。本测试就是钉住它。
 *
 * ⚠️ 无修复时这个测试是**概率性**失败（交错要撞上才丢），所以并发数取 6、块体量取小，
 * 提高撞上的概率；它仍然不能替代真机压力验证（见审查报告 V4）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeHandoverBlock } from '../lib/handover.mjs';

const blockOf = (id) =>
  `<!-- dsh-context-guard:begin ${id} -->\n\nBODY-${id}\n\n<!-- dsh-context-guard:end -->\n`;

test('P1-3 回归：6 个会话并发写同一文件，一个块都不能丢', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dcg-conc-'));
  const file = join(dir, 'HANDOVER.md');
  const sessions = ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f'];
  try {
    // 全部同时发起（不去 await 中间结果）—— 这正是真机上多会话同时跨阈值的形状
    const results = await Promise.all(
      sessions.map((id) => writeHandoverBlock({ file, sessionId: id, block: blockOf(id) })),
    );
    for (const [i, r] of results.entries()) {
      assert.ok(r.status === 'replaced' || r.status === 'appended', `第 ${i} 次写入应成功，实际 ${r.status}/${r.error}`);
    }
    const text = await readFile(file, 'utf8');
    for (const id of sessions) {
      assert.ok(text.includes(`BODY-${id}`), `会话 ${id} 的块被覆盖丢失了`);
    }
    // 每块都应有配对的 begin / end，别写出半截
    assert.equal((text.match(/dsh-context-guard:begin/g) ?? []).length, sessions.length);
    assert.equal((text.match(/dsh-context-guard:end/g) ?? []).length, sessions.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('P1-3：同一会话重复写是幂等的（替换而非追加）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dcg-idem-'));
  const file = join(dir, 'HANDOVER.md');
  try {
    const id = 'same-session';
    await writeHandoverBlock({ file, sessionId: id, block: blockOf(id) });
    await writeHandoverBlock({ file, sessionId: id, block: blockOf(id).replace('BODY-', 'BODY2-') });
    const text = await readFile(file, 'utf8');
    assert.equal((text.match(/dsh-context-guard:begin/g) ?? []).length, 1, '同一会话只该留一块');
    assert.ok(text.includes('BODY2-'), '第二次写应生效');
    assert.ok(!text.includes('BODY-same-session'), '旧内容应被替换');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
