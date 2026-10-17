/**
 * 「自动交接草稿」——插件在跨过 `warnRatio` 时，把宿主**已经算好的投影**拼成一块机器事实交接。
 *
 * 设计约束（与插件其余部分一致）：
 *   ⛔ **零 LLM、零额外请求**：全部素材来自 session projection（tokenCost / contextTimeline /
 *      turnOutline / sessionStats / contextPressure），不产生任何上下文税。
 *   ⛔ **不写叙述**：插件不知道你干了什么、结论是什么 —— 它只写「可核对的机器事实」，
 *      并留出「待补」空槽给 agent。**不要把这一块当成合格交接。**
 *   ⛔ **fail-soft**：路径不可解析、文件不可写、权限不足 —— 一律只记状态，绝不抛回投影回调
 *      （提示插件不能成为别人的故障源）。
 *
 * 本文件**只被宿主半边 import**，不进 `lib/client.js` 的 bundle（bundle 只内联 i18n.mjs +
 * policy.mjs + client-source.js）—— 所以这里可以自由使用 node 内置模块。
 */
import { readFile, writeFile, lstat, rename } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';

import { makeT } from './i18n.mjs';

/** 每个会话一块，用带 sessionId 的注释标记，便于幂等替换与人工整块删除。 */
export const beginMarker = (sessionId) => `<!-- dsh-context-guard:begin ${sessionId} -->`;
export const endMarker = '<!-- dsh-context-guard:end -->';

/**
 * 「待补」区的**子标记**（v0.3.6 新增，解决一个确定性的信息丢失）：
 *
 * 整块替换是按 begin/end 做的 —— 也就是说 agent 把结论填进「待补」后，水位再涨 5 个点
 * 触发一次刷新，填好的内容会被**整个覆盖**。所以在待补区外面再套一对子标记，
 * 刷新时把**旧块里这一段**原样搬进新块：机器事实更新，人工结论保留。
 *
 * ⚠️ 子标记只包「三条 checkbox 及其后的内容」，**不包** `**待补（由 agent 写）**` 这一行 ——
 * 标题跟着新块的语言走（中英会话各一份），人工区内容则原样保留。
 */
export const TODO_BEGIN = '<!-- dsh-context-guard:todo:begin -->';
export const TODO_END = '<!-- dsh-context-guard:todo:end -->';

/**
 * 「压缩前快照」的**独立块**标记（v0.4.1）。
 *
 * 为什么单独一块、而不塞进自动草稿块：草稿块在每次水位步进时**整块替换**（只保留待补区），
 * 塞进去会被下一次刷新冲掉。压缩是"一锤子"事件，它的读数必须独立留存 ⇒ 自己的 begin/end。
 */
export const preBeginMarker = (sessionId) => `<!-- dsh-context-guard:pre-compaction ${sessionId} -->`;
export const preEndMarker = '<!-- dsh-context-guard:pre-compaction:end -->';

/** `fileOps.kind` 里只有 `write` 表示真动过文件（实测分布：write 3292 / search 2827 / read 2024）。 */
const WRITE_KIND = 'write';

const pad = (n) => String(n).padStart(2, '0');

/** 本地时间 `YYYY-MM-DD HH:mm`（不依赖 locale，避免不同机器格式漂移）。 */
export function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 最近被写过的文件（倒序、去重、跳过失败项）。 */
export function changedFiles(fileOps, max = 12) {
  if (!Array.isArray(fileOps)) return [];
  const out = [];
  const seen = new Set();
  for (let i = fileOps.length - 1; i >= 0 && out.length < max; i -= 1) {
    const op = fileOps[i];
    if (op === null || typeof op !== 'object') continue;
    if (op.err === true) continue;
    if (String(op.kind) !== WRITE_KIND) continue;
    const p = typeof op.path === 'string' ? op.path : null;
    if (p === null || seen.has(p)) continue;
    seen.add(p);
    out.push({
      path: p,
      tool: typeof op.tool === 'string' ? op.tool : null,
      added: Number.isFinite(op.added) ? op.added : 0,
      removed: Number.isFinite(op.removed) ? op.removed : 0,
      time: Number.isFinite(op.time) ? op.time : null,
    });
  }
  return out;
}

const squash = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 最近 N 轮的「诉求 / 回应」摘要。
 *
 * ⚠️ 2026-09-30（第十一棒）实测更正：`turnOutline` 的 **wire 视图是数组**
 * （单元定义里 `view: (state) => state.turns`），而**宿主状态**是 `{ turns, draft }`。
 * 只认 `{turns}` ⇒ onChanged 那条路永远拼不出这一段（草稿会印「宿主没有提供」）。
 * 这里两种形状都收：`stateOf` 给的用 `.turns`，线上视图给的直接当数组用。
 */
export function recentTurns(turnOutline, max = 6) {
  const raw = Array.isArray(turnOutline)
    ? turnOutline
    : Array.isArray(turnOutline?.turns)
      ? turnOutline.turns
      : [];
  return raw.slice(-max).map((t) => ({
    turn: Number.isFinite(t?.turn) ? t.turn : null,
    prompt: squash(t?.prompt, 160),
    response: squash(t?.response, 160),
  }));
}

/** 工具使用分布（说明这次会话的「工作形态」）。 */
export function toolMix(timing, max = 6) {
  const tools = timing?.tools;
  if (tools === null || typeof tools !== 'object') return [];
  return Object.entries(tools)
    .map(([tool, v]) => ({ tool, calls: Number.isFinite(v?.calls) ? v.calls : 0 }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, max);
}

/**
 * 拼出那一块 markdown。**纯函数**（时间一律由调用方传入），单测直接跑它。
 *
 * 语言：`locale` 由调用方（`lib/index.js`）按会话解析后传进来，**默认 `zh`**
 * —— 不传就与加双语之前逐字一致，老断言不受影响。
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {number} input.now
 * @param {{known: boolean, ratio: number|null, projectedTokens?: number|null, contextWindow?: number|null}} input.reading
 * @param {object} input.material 各 projection 的最新值
 * @param {object} input.config    归一化后的配置（只读 handoverTurns / handoverFiles）
 * @param {string|null} input.cwd
 * @param {'zh'|'en'} [input.locale]
 */
export function composeHandoverBlock({
  sessionId,
  now,
  reading,
  material = {},
  config = {},
  cwd = null,
  locale = 'zh',
}) {
  const t = makeT(locale === 'en' ? 'en' : 'zh');
  const turns = recentTurns(material.turnOutline, config.handoverTurns ?? 6);
  const files = changedFiles(material.contextTimeline?.fileOps, config.handoverFiles ?? 12);
  const mix = toolMix(material.contextTimeline?.timing, 6);
  const cost = material.tokenCost ?? {};
  const stats = material.sessionStats ?? {};
  const tl = material.contextTimeline ?? {};
  const identity = material.identity ?? {};
  const ratio = reading?.known === true && Number.isFinite(reading.ratio) ? reading.ratio : null;
  const win = Number.isFinite(tl.contextWindow) ? tl.contextWindow : null;
  const proj = Number.isFinite(reading?.projectedTokens) ? reading.projectedTokens : null;

  const title = typeof material.title === 'string' && material.title !== '' ? material.title : t('handover.title.empty');
  const lines = [];
  lines.push(beginMarker(sessionId));
  lines.push('');
  lines.push(t('handover.heading', { time: fmtTime(now), ratio }));
  lines.push('');
  lines.push(t('handover.note.zeroLlm'));
  lines.push(t('handover.note.howto'));
  lines.push('');
  lines.push(t('handover.table.header'));
  lines.push('|---|---|');
  lines.push(t('handover.row.session', { id: sessionId, title: squash(title, 60) }));
  lines.push(t('handover.row.cwd', { cwd: cwd === null ? t('handover.unknown') : `\`${cwd}\`` }));
  const occupancy =
    ratio === null
      ? t('handover.occupancy.nodata')
      : `**${(ratio * 100).toFixed(1)}%**${
          proj === null || win === null
            ? ''
            : t('handover.occupancy.approx', { k: `${(proj / 1000).toFixed(0)}K`, w: `${(win / 1000).toFixed(0)}K` })
        }`;
  lines.push(t('handover.row.occupancy', { value: occupancy }));
  const scale =
    `${Number.isFinite(stats.turns) ? t('handover.scale.turns', { n: stats.turns }) : ''}` +
    `${Number.isFinite(cost.calls) ? t('handover.scale.calls', { n: cost.calls }) : t('handover.scale.callsUnknown')}` +
    `${Number.isFinite(tl.timing?.toolCalls) ? t('handover.scale.tools', { n: tl.timing.toolCalls }) : ''}`;
  lines.push(t('handover.row.scale', { value: scale }));
  lines.push(
    t('handover.row.cost', {
      value: Number.isFinite(cost.cost)
        ? t('handover.cost.value', { amount: Number(cost.cost).toFixed(2) })
        : t('handover.cost.nodata'),
    }),
  );
  lines.push(
    // ⚠️ `createdAt` 由 index.js 的 `noteMaterial` 直接挂在 material 上（取自 session header），
    //    **不是** `identity.createdAt` —— 2026-09-30 真机草稿里这一格印成「—」就是这个读错字段的 bug。
    t('handover.row.time', {
      from: fmtTime(Number.isFinite(material.createdAt) ? material.createdAt : identity.createdAt),
      to: fmtTime(cost.lastActivity ?? now),
    }),
  );
  if (mix.length > 0) {
    lines.push(t('handover.row.toolmix', { list: mix.map((m) => `${m.tool} ${m.calls}`).join(' · ') }));
  }
  lines.push('');

  lines.push(t('handover.files.heading', { n: files.length }));
  lines.push('');
  if (files.length === 0) {
    lines.push(t('handover.files.none'));
  } else {
    for (const f of files) {
      const delta = f.added > 0 || f.removed > 0 ? ` · +${f.added}/-${f.removed}` : '';
      lines.push(`- \`${f.path}\`${f.tool === null ? '' : ` · ${f.tool}`}${delta}`);
    }
  }
  lines.push('');

  lines.push(t('handover.turns.heading', { n: turns.length }));
  lines.push('');
  if (turns.length === 0) {
    lines.push(t('handover.turns.none'));
  } else {
    for (const item of turns) {
      lines.push(
        t('handover.turn.line', {
          turn: item.turn ?? '?',
          prompt: item.prompt || '—',
          response: item.response || '—',
        }),
      );
    }
  }
  lines.push('');

  lines.push(t('handover.todo.heading'));
  lines.push(TODO_BEGIN);
  lines.push('');
  lines.push(t('handover.todo.conclusion'));
  lines.push(t('handover.todo.pitfalls'));
  lines.push(t('handover.todo.next'));
  lines.push(TODO_END);
  lines.push('');
  lines.push(endMarker);
  return lines.join('\n');
}

/**
 * 从**旧块**里取出人工区（`TODO_BEGIN`/`TODO_END` 之间）。
 *
 * 旧块没有子标记时（≤0.3.5 写的）退回「第一条 `- [ ]` 行到块末尾」——
 * 那正好是待补列表的位置，而且**不需要知道语言**（中英两种块都能命中）。
 * @returns {string|null} 取不到就 null
 */
function oldTodoRegion(oldBlock) {
  const b = oldBlock.indexOf(TODO_BEGIN);
  if (b >= 0) {
    const e = oldBlock.indexOf(TODO_END, b + TODO_BEGIN.length);
    if (e >= 0) return oldBlock.slice(b + TODO_BEGIN.length, e);
  }
  const m = oldBlock.match(/\n- \[[ xX]\] /);
  if (m === null || m.index === undefined) return null;
  return oldBlock.slice(m.index + 1);
}

/** 把人工区塞回新块的子标记之间；新块没有子标记就原样返回（绝不因此丢整块）。 */
function withTodoRegion(block, region) {
  const b = block.indexOf(TODO_BEGIN);
  if (b < 0) return block;
  const e = block.indexOf(TODO_END, b + TODO_BEGIN.length);
  if (e < 0) return block;
  return `${block.slice(0, b + TODO_BEGIN.length)}${region}${block.slice(e)}`;
}

/**
 * 幂等写入：同会话已有标记块 ⇒ 整块替换；否则**追加到文件末尾**（不动既有正文）。纯函数。
 *
 * v0.3.6：替换时**保留「待补」人工区**。此前整块替换会把 agent 填好的结论一起冲掉 ——
 * 那是确定性的信息丢失（补错还能改，丢了都不知道），比"结论由谁写"更值得先修。
 * @returns {{text: string, action: 'replaced'|'appended'}}
 */
export function upsertHandoverBlock(existingText, sessionId, block) {
  const text = typeof existingText === 'string' ? existingText : '';
  const begin = beginMarker(sessionId);
  const start = text.indexOf(begin);
  if (start < 0) {
    const glue = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { text: `${text}${glue}${block}\n`, action: 'appended' };
  }
  const endIdx = text.indexOf(endMarker, start);
  const stop = endIdx < 0 ? text.length : endIdx + endMarker.length;
  const kept = oldTodoRegion(text.slice(start, stop));
  const nextBlock = kept === null ? block : withTodoRegion(block, kept);
  return { text: `${text.slice(0, start)}${nextBlock}${text.slice(stop)}`, action: 'replaced' };
}

/**
 * 幂等写入「压缩前快照」块：一个会话一块，**每次压缩替换**（不累积）。
 * 与自动草稿块用**不同的标记**，所以两者互不干扰。
 */
export function upsertPreCompactionBlock(existingText, sessionId, block) {
  const text = typeof existingText === 'string' ? existingText : '';
  const begin = preBeginMarker(sessionId);
  const start = text.indexOf(begin);
  if (start < 0) {
    const glue = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { text: `${text}${glue}${block}\n`, action: 'appended' };
  }
  const endIdx = text.indexOf(preEndMarker, start);
  const stop = endIdx < 0 ? text.length : endIdx + preEndMarker.length;
  return { text: `${text.slice(0, start)}${block}${text.slice(stop)}`, action: 'replaced' };
}

/**
 * 合成「压缩前快照」块（v0.4.1，零 LLM）。
 *
 * 平台压缩之后，压缩前的读数（水位/花费/文件）就再也查不到了 —— 这个块是给平台的黑盒
 * 留一份白盒记录。素材与自动草稿同源（宿主状态真源），所以两边的数字对得上。
 */
export function composePreCompactionBlock({ sessionId, now, reading, material, locale = 'zh' }) {
  const t = makeT(locale);
  const m = material ?? {};
  const r = reading && Number.isFinite(reading.ratio) ? reading : null;
  const pct = r === null ? null : (r.ratio * 100).toFixed(1);
  const size =
    r && Number.isFinite(r.projectedTokens) && Number.isFinite(r.contextWindow)
      ? `（≈${Math.round(r.projectedTokens / 1000)}K / ${Math.round(r.contextWindow / 1000)}K）`
      : '';
  const cost = m.tokenCost && Number.isFinite(m.tokenCost.cost) ? m.tokenCost.cost : null;
  const files = changedFiles(m.contextTimeline?.fileOps, 8);

  const lines = [];
  lines.push(preBeginMarker(sessionId));
  lines.push(t('pre.title', { at: fmtTime(now) }));
  lines.push('');
  lines.push(t('pre.note'));
  lines.push('');
  lines.push(t('handover.table.header'));
  lines.push('|---|---|');
  lines.push(t('pre.row.occupancy', { value: pct === null ? t('pre.unknown') : `**${pct}%**${size}` }));
  lines.push(t('pre.row.cost', { value: cost === null ? t('handover.cost.nodata') : `**¥${cost.toFixed(2)}**` }));
  lines.push(
    t('pre.row.files', {
      n: files.length,
      list: files.length === 0 ? t('pre.files.none') : files.map((f) => `\`${f.path}\``).join(' · '),
    }),
  );
  lines.push(t('pre.row.time', { at: fmtTime(now) }));
  lines.push('');
  lines.push(preEndMarker);
  return lines.join('\n');
}

/**
 * 待补区**是否被填过**（v0.4.0，纯函数）。
 *
 * 判据只看"结构"，不看具体语言：一行 trim 后不是空行、且不是「`- [ ] 标签：` 这种**冒号结尾**的空槽」
 * 就算有内容。这样 zh / en 两套模板、以及 agent 把 checkbox 勾上（`- [x]`）再写内容，都能识别。
 */
export function isTodoFilled(text) {
  const region = oldTodoRegion(typeof text === 'string' ? text : '');
  if (region === null) return false;
  return region
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line !== '' && !/^-[ ]*\[[ xX]\][ ]*.*[：:]$/.test(line) && !/^-[ ]*\[[ xX]\][ ]*.*:$/.test(line));
}

/** 只看**指定会话那一块**的待补区（避免读到文件里别的会话的块）。 */
export function todoFilledIn(text, sessionId) {
  const source = typeof text === 'string' ? text : '';
  const start = source.indexOf(beginMarker(sessionId));
  if (start < 0) return false;
  const endIdx = source.indexOf(endMarker, start);
  return isTodoFilled(source.slice(start, endIdx < 0 ? source.length : endIdx));
}

/**
 * 从磁盘判断该会话的待补是否已填。读不到文件 ⇒ `null`（**不知道**，不是"没填"）。
 * 宿主路由用它把"结论还在不在"变成状态面上的一个字段，而不是靠人记。
 */
export async function readTodoFilled(file, sessionId) {
  try {
    return todoFilledIn(await readFile(file, 'utf8'), sessionId);
  } catch {
    return null;
  }
}

/**
 * 该路径是否已经「自带根」，无论写它的人用的是哪个平台。
 *
 * ⛔ 不能只用 `isAbsolute()` —— 它是**平台相关**的：
 *   Linux 上 `isAbsolute('D:\\other\\H.md')` = false ⇒ 会被当相对路径拼进 cwd，
 *   拼出 `'D:\\proj/D:\\other\\H.md'` 这种不存在的路径（CI 在 ubuntu 上实测抓到）；
 *   Windows 上 `/home/x/H.md` 同样会误判。
 * 配置里出现另一种平台的绝对路径是很现实的（从文档复制、跨机器同步配置），
 * 所以这里显式认三种形态：本平台绝对路径 / 盘符或 UNC / POSIX 斜杠开头。
 */
function hasRoot(p) {
  return (
    isAbsolute(p) || // 本平台语义
    /^[A-Za-z]:[\\/]/.test(p) || // Windows 盘符：C:\x 或 C:/x
    /^\\\\/.test(p) || // UNC：\\server\share
    /^\//.test(p) // POSIX 绝对路径（win32 的 isAbsolute 不认）
  );
}

/** 相对路径按会话工作目录解析；绝对路径原样使用（两种平台的绝对路径都认）。 */
export function resolveHandoverPath(cwd, configured) {
  if (typeof configured !== 'string' || configured.trim() === '') return null;
  const p = configured.trim();
  if (hasRoot(p)) return p;
  if (typeof cwd !== 'string' || cwd === '') return null;
  return join(cwd, p);
}

/** 目标**已存在**时允许改写的扩展名（防止 `handoverPath` 手滑指到 `.json` / `.yml` / `.gitignore` 之类）。 */
const TEXT_EXT = new Set(['', '.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc']);

/**
 * 落盘（fail-soft）。**任何**异常都变成 `{status:'error'}` 返回，绝不抛。
 *
 * 2026-09-30 按安全审计加固（P1-1）：
 *   · **不建目录**：父目录不存在 ⇒ `error:'no-parent-dir'`（`mkdir -p` 会把手滑的绝对路径一路竣工）；
 *   · **不改写非文本文件**：目标已存在且扩展名不在白名单 ⇒ `error:'foreign-file'`；
 *   · **不跟随符号链接**：目标是链接 ⇒ `error:'symlink'`；
 *   · **原子替换**：同目录临时文件 + `rename` —— 只保证"不会写出半截文件"，
 *     ⚠️ **不保证"不丢更新"**：并发交错下后写者仍会覆盖前写者的块。丢块由
 *     `writeHandoverBlock` 的**按文件串行队列**解决（P1-3，见下方 `enqueueFileWrite`）；
 *   · **权限收紧**：`mode 0o600`（内容含本次改过的文件清单与会话摘要）；
 *   · **只回文件名**：`path` 永远是 `basename`，绝不把本机绝对路径回给状态路由（P1-2）。
 *
 * @returns {Promise<{status: 'replaced'|'appended'|'error', path: string|null, bytes: number, error: string|null}>}
 */

/* ── 同一目标文件的串行队列（P1-3）────────────────────────────────────────────
 * 锁的粒度必须与**资源**一致。这里的资源是「一个文件」，不是「一个会话」：
 * 同一 cwd 下所有会话都写同一个 `HANDOVER.md`，而 index.js 里的 `pending` 是按 sessionId 的。
 * 没有这把锁时，「读 → upsert → 写 → rename」跨 await 交错会让**后写者覆盖先写者的块**（永久丢块）。
 * · 按文件名分组排队；
 * · 链条尾部**永不 reject**，否则一次写入失败会把后续所有写入带崩（unhandled rejection）。
 */
const fileWriteQueues = new Map();
let tmpSeq = 0;

function enqueueFileWrite(file, task) {
  const tail = fileWriteQueues.get(file) ?? Promise.resolve();
  const run = tail.then(task, task); // 前一次即使失败，也照样执行这一次
  const settled = run.then(
    () => {},
    () => {},
  );
  fileWriteQueues.set(file, settled);
  settled.finally(() => {
    if (fileWriteQueues.get(file) === settled) fileWriteQueues.delete(file);
  });
  return run;
}

export async function writeHandoverBlock({ file, sessionId, block, upsert = upsertHandoverBlock }) {
  if (typeof file !== 'string' || file === '') {
    return { status: 'error', path: null, bytes: 0, error: 'no-cwd' };
  }
  // 同一文件上的所有写入串行执行（自动草稿、手动 /draft、压缩前快照都走这里）
  return enqueueFileWrite(file, () => writeHandoverBlockOnce({ file, sessionId, block, upsert }));
}

async function writeHandoverBlockOnce({ file, sessionId, block, upsert }) {
  const name = basename(file);
  try {
    let existing = null;
    try {
      existing = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { status: 'error', path: name, bytes: 0, error: String(error?.code ?? error?.message ?? error) };
      }
    }

    if (existing === null) {
      // 新文件：只允许落在**已存在**的目录里（不做 mass-mkdir）
      try {
        const dir = await lstat(dirname(file));
        if (!dir.isDirectory()) return { status: 'error', path: name, bytes: 0, error: 'no-parent-dir' };
      } catch {
        return { status: 'error', path: name, bytes: 0, error: 'no-parent-dir' };
      }
    } else {
      const st = await lstat(file);
      if (st.isSymbolicLink()) return { status: 'error', path: name, bytes: 0, error: 'symlink' };
      if (!TEXT_EXT.has(extname(file).toLowerCase())) {
        return { status: 'error', path: name, bytes: 0, error: 'foreign-file' };
      }
    }

    const { text, action } = upsert(existing ?? '', sessionId, block);
    // ⚠️ 临时名**必须唯一**（P1-3）：固定名在并发下会让先 `rename` 的一方把别人的内容搬走，
    //    第二个 `rename` 抛 ENOENT —— 日志报"写失败"，而文件其实已经被改过（排查的人会看错方向）。
    const tmp = `${file}.${process.pid}.${++tmpSeq}.dsh-context-guard.tmp`;
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
    return { status: action, path: name, bytes: Buffer.byteLength(text, 'utf8'), error: null };
  } catch (error) {
    return { status: 'error', path: name, bytes: 0, error: String(error?.code ?? error?.message ?? error) };
  }
}
