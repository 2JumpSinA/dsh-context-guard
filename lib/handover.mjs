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
import { readFile, writeFile, lstat, rename, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

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
 * 「压缩账」的**独立块**标记（v0.5.0，取代 v0.4.1 的每会话快照块）。
 *
 * 为什么仍然单独一块、且是**全局一张表**：
 *   · 草稿块在每次水位步进时整块替换（只保留待补区）⇒ 账行放进去会被下一次刷新冲掉（§30.7 的教训）；
 *   · 每会话一块的终局是「同一个文件里堆着 N 块谁也说不清哪块有效」，而压缩是稀疏事件
 *     （真机一次会话 0–3 次）⇒ 一张全局表更短、可横向比较、且行数本身就是跨重启的持久计数。
 * 行键是 `compactionId`（宿主事件载荷里有）：同一事件重复投递/重放/重试都只落一行。
 */
export const LEDGER_BEGIN = '<!-- dsh-context-guard:ledger:begin -->';
export const LEDGER_END = '<!-- dsh-context-guard:ledger:end -->';
/** 全表上限（超过按最旧 FIFO 淘汰，单次写入最多淘汰一行）——防止半年后把 §0 挤出屏幕。 */
export const LEDGER_MAX_ROWS = 50;
/** 每会话上限：同一会话压很多次时，只留最近 3 次。 */
export const LEDGER_MAX_PER_SESSION = 3;

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
 * 外部文本清洗（v0.6.0）。块里会进 agent 提供的 prompt / response / 文件路径 / 工具名 ——
 * 这是全项目**唯一能合法携带任意字面量**的进块路径，必须拦住七类东西：
 *
 *   1. **换行族**：`\n` / `\r` / U+2028 / U+2029 / **U+0085（NEL，不在 `\s` 里）** —— 否则能伪造整行事实；
 *   2. **控制符 / NUL**：终端与编辑器会截断显示，路径核对被误导；
 *   3. **零宽 / bidi**：U+200B–200F / U+202A–202E / U+2066–2069 / U+061C / U+FEFF ——
 *      读者看到的路径可能与磁盘上的**不是同一个**（这是人眼欺骗，不是解析逃逸，别当安全边界）；
 *   4. **守卫标记前缀**：`<!-- dsh-context-guard:` 一旦出现在块内，下一次刷新 `indexOf(endMarker)`
 *      会落在注入处，人工区被静默替换（与 §30.7 同类）；
 *   5. **反引号**：奇数个就会让 inline code 跨度漂移、吞掉后文；
 *   6. **竖线 `|`**：GFM 表格里**即使包在 code span 内**也切列 ⇒ 转义成 `\|`；
 *   7. **超长**：截断并加省略号。
 *
 * **幂等**：对结果再跑一次必须逐字节相同 —— 否则写盘层的 `text === existing` 去重永远不成立，
 * 每次水位步进都会重写文件（`unchanged` 计数归零）。
 */
export function scrubExternal(value, max = 160) {
  if (typeof value !== 'string' || value === '') return '';
  let s = value.normalize('NFC');
  s = s.replace(/[\r\n\u2028\u2029\u0085]+/g, ' ');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  s = s.replace(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u061c\u2060-\u2064\ufeff]/g, '');
  // 只中和「守卫标记前缀」：把冒号后插空格。正常文本里出现的 dsh-context-guard 字样不受影响。
  s = s.replace(/<!--\s*dsh-context-guard:/gi, '<!-- dsh-context-guard :');
  s = s.replace(/`/g, "'");
  // 只转义**尚未转义**的竖线（幂等：已经是 `\|` 的跳过，否则第二次会变成 `\\|`）
  s = s.replace(/(^|[^\\])\|/g, '$1\\|');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

const TIMEOUT = Object.assign(new Error('probe timeout'), { code: 'TIMEOUT' });

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(TIMEOUT), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const safeRealpath = (p, native = true) => {
  try {
    return native ? realpathSync.native(p) : realpathSync(p);
  } catch {
    return null;
  }
};

const isInside = (child, parent) => {
  if (parent === null || parent === undefined) return false;
  const a = child.toLowerCase();
  const b = parent.toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
};

/**
 * 写时校验「关键文件还在不在」（v0.6.0）。**只做本机文件系统事实，绝不执行任何命令。**
 *
 * 三态（刻意不合并成「未核实」）：
 *   · `exists` —— 核过，本机存在；
 *   · `missing` —— ENOENT，是事实（读者可以直接据此行动）；
 *   · `unverified` —— 我们的盲区（非本机盘 / 无 cwd / 链接 / 越界 / 权限 / 超时）。
 *
 * 两条硬约束（来自评审）：
 *   · **UNC / 网络路径一律不 stat** —— 一次 SMB 超时能卡住按文件串行的写盘队列，
 *     而压缩账比草稿更怕延迟；
 *   · **每个路径都有硬超时**（默认 150ms），超时按「核不了」处理，不重试。
 *
 * @returns {Promise<Map<string, {state: 'exists'|'missing'|'unverified', reason?: string}>>}
 */
export async function probeFiles(paths, cwd, { limit = 12, timeoutMs = 150 } = {}) {
  const out = new Map();
  if (!Array.isArray(paths) || paths.length === 0) return out;
  const root = typeof cwd === 'string' && cwd !== '' ? safeRealpath(cwd) : null;
  for (const raw of paths.slice(0, limit)) {
    const p = typeof raw === 'string' ? raw : '';
    if (p === '') {
      out.set(p, { state: 'unverified', reason: 'empty' });
      continue;
    }
    // UNC（\\server\share）与 //server/share：不 stat，直接「核不了」——避免卡住写盘队列。
    if (/^[\\/]{2}/.test(p)) {
      out.set(p, { state: 'unverified', reason: 'remote' });
      continue;
    }
    if (root === null && !isAbsolute(p)) {
      out.set(p, { state: 'unverified', reason: 'no-cwd' });
      continue;
    }
    const abs = isAbsolute(p) ? p : join(root ?? cwd, p);
    try {
      out.set(p, await withTimeout(checkOne(abs, root), timeoutMs));
    } catch (error) {
      out.set(p, { state: 'unverified', reason: error?.code === 'TIMEOUT' ? 'timeout' : 'error' });
    }
  }
  return out;
}

/** 单个路径：先 realpath 比对父链（junction 在 Windows 上 lstat 不认），再看叶子。 */
async function checkOne(abs, root) {
  const real = safeRealpath(abs);
  if (real === null) {
    // realpath 失败：区分「真的不存在」与「核不了」
    try {
      await lstat(abs);
      return { state: 'unverified', reason: 'link' };
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'missing' };
      if (error?.code === 'EACCES' || error?.code === 'EPERM') return { state: 'unverified', reason: 'denied' };
      return { state: 'unverified', reason: 'error' };
    }
  }
  if (root !== null && !isInside(real, root)) return { state: 'unverified', reason: 'outside' };
  try {
    const st = await lstat(abs);
    if (st.isFile()) return { state: 'exists' };
    if (st.isSymbolicLink()) return { state: 'unverified', reason: 'link' };
    // Windows 的 junction / 挂载点：lstat 报 directory、不报 symbolic link。
    // 用 realpath 是否改变了路径来判断「这是不是链接」，否则普通目录会被误判成 not-file。
    return real.toLowerCase() === abs.toLowerCase()
      ? { state: 'unverified', reason: 'not-file' }
      : { state: 'unverified', reason: 'link' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unverified', reason: 'error' };
  }
}

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
    prompt: scrubExternal(t?.prompt, 160),
    response: scrubExternal(t?.response, 160),
  }));
}

/** 工具使用分布（说明这次会话的「工作形态」）。 */
export function toolMix(timing, max = 6) {
  const tools = timing?.tools;
  if (tools === null || typeof tools !== 'object') return [];
  return Object.entries(tools)
    .map(([tool, v]) => ({ tool: scrubExternal(tool, 40), calls: Number.isFinite(v?.calls) ? v.calls : 0 }))
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
  fileFacts = null,
  verifiedAt = null,
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

  const title = material.title === undefined || material.title === null || material.title === ''
    ? t('handover.title.empty')
    : scrubExternal(String(material.title), 60);
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
  lines.push(t('handover.row.session', { id: scrubExternal(sessionId, 80), title }));
  lines.push(t('handover.row.cwd', { cwd: cwd === null ? t('handover.unknown') : `\`${scrubExternal(String(cwd), 200)}\`` }));
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

  const facts = fileFacts instanceof Map ? fileFacts : null;
  const headingSuffix =
    facts === null
      ? t(cwd === null ? 'handover.files.notVerifiedNoCwd' : 'handover.files.notVerified')
      : t('handover.files.verified', { at: fmtTime(Number.isFinite(verifiedAt) ? verifiedAt : now) });
  lines.push(`${t('handover.files.heading', { n: files.length })}${headingSuffix}`);
  lines.push('');
  if (files.length === 0) {
    lines.push(t('handover.files.none'));
  } else {
    for (const f of files) {
      const delta = f.added > 0 || f.removed > 0 ? ` · +${f.added}/-${f.removed}` : '';
      const tool = f.tool === null ? '' : ` · ${scrubExternal(f.tool, 40)}`;
      const fact = facts === null ? null : facts.get(f.path);
      let mark = '';
      if (fact !== null && fact !== undefined) {
        if (fact.state === 'missing') mark = t('handover.files.mark.missing');
        else if (fact.state === 'unverified') mark = t('handover.files.mark.cannot', { reason: reasonText(t, fact.reason) });
      }
      lines.push(`- \`${scrubExternal(f.path, 260)}\`${tool}${delta}${mark}`);
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
  /**
   * ⚠️ fail-safe（v0.5.0，CTO 一票否决区）：以前这里是 `stop = endIdx < 0 ? text.length : …`，
   * 也就是「只有 begin、没有 end」时把 begin 之后**直到文件末尾**整段替换掉。
   * §19.5 已经因为同类切片真实截断过一次文件；这份文档尾部本来就常躺着多块自动草稿，
   * 一次手工清理删掉半截标记，下一次水位步进就会吞掉后面所有正文。
   * 现在：结构不认 ⇒ **一个字都不写**，让调用方拿到 `broken-block` 并记状态。
   */
  if (endIdx < 0) return { text, action: 'broken-block' };
  const stop = endIdx + endMarker.length;
  const kept = oldTodoRegion(text.slice(start, stop));
  const nextBlock = kept === null ? block : withTodoRegion(block, kept);
  return { text: `${text.slice(0, start)}${nextBlock}${text.slice(stop)}`, action: 'replaced' };
}

/**
 * 合成「压缩账」表的表头与一条行的渲染器。
 *
 * 表是**全局一张**：`#` 是跨重启的行号（从文件里解析，不用内存计数器），
 * `事件` 列是宿主的 `compactionId` —— 幂等键，同一事件重复投递只落一行。
 */
function renderLedgerHeader(t) {
  return [LEDGER_BEGIN, t('ledger.title'), '', t('ledger.header'), '|---|---|---|---|---|---|---|---|'].join('\n');
}

const REASON_KEYS = new Set(['remote', 'no-cwd', 'empty', 'link', 'outside', 'not-file', 'denied', 'timeout', 'error']);
const reasonText = (t, reason) => t(`handover.files.reason.${REASON_KEYS.has(reason) ? reason : 'error'}`);

function renderLedgerRow(t, entry, seq) {
  const peak = Number.isFinite(entry.peakPercent) ? `${entry.peakPercent.toFixed(1)}%` : t('ledger.unknownPeak');
  const size = typeof entry.size === 'string' && entry.size !== '' ? entry.size : '—';
  const cost = Number.isFinite(entry.cost) ? `¥${entry.cost.toFixed(2)}` : '—';
  const files = Number.isFinite(entry.files) ? String(entry.files) : '—';
  const event = typeof entry.eventId === 'string' && entry.eventId !== '' ? scrubExternal(entry.eventId, 8) : '—';
  return t('ledger.row', {
    i: seq,
    at: entry.at,
    session: scrubExternal(String(entry.sessionId ?? ''), 8),
    peak,
    size,
    cost,
    files,
    event,
  });
}

/** 只认「表体行」：以 `| 数字 |` 开头。表头/分隔行/空行一律跳过。 */
function ledgerRowsOf(inner) {
  return inner
    .split('\n')
    .filter((line) => /^\|\s*\d+\s*\|/.test(line))
    .map((line) => {
      const cells = line.split('|').map((c) => c.trim());
      // cells = ['', '#', 时间, 会话, 峰值, 尺寸, 花费, 文件, 事件, '']
      return {
        seq: Number(cells[1]),
        at: cells[2] ?? '',
        session: cells[3] ?? '',
        peak: cells[4] ?? '',
        size: cells[5] ?? '',
        cost: cells[6] ?? '',
        files: cells[7] ?? '',
        event: cells[8] ?? '',
      };
    });
}

/**
 * 追加一行压缩账。纯函数（不碰 IO），失败形态只有一种：**块坏了就拒绝写**。
 *
 * @param {string} existingText 目标文件现有内容
 * @param {{at:string, sessionId:string, peakPercent:number|null, size?:string, cost:number|null, files:number, eventId?:string}} entry
 * @returns {{text:string, action:'appended'|'unchanged'|'broken-block'}}
 */
export function upsertLedgerRow(existingText, entry, { locale = 'zh' } = {}) {
  const text = typeof existingText === 'string' ? existingText : '';
  const t = makeT(locale);
  const start = text.indexOf(LEDGER_BEGIN);
  if (start < 0) {
    const block = `${renderLedgerHeader(t)}\n${renderLedgerRow(t, entry, 1)}\n${LEDGER_END}`;
    const glue = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return { text: `${text}${glue}${block}\n`, action: 'appended', seq: 1 };
  }
  const endIdx = text.indexOf(LEDGER_END, start + LEDGER_BEGIN.length);
  // ⚠️ 只有 begin 没有 end ⇒ 说明文件被人手工改坏。**绝不**把 begin 之后整段当账本写，
  //    那会吞掉后面的正文（§19.5 的真实事故）。宁可不写。
  if (endIdx < 0) return { text, action: 'broken-block' };
  const inner = text.slice(start + LEDGER_BEGIN.length, endIdx);
  const rows = ledgerRowsOf(inner);
  const event = typeof entry.eventId === 'string' ? scrubExternal(entry.eventId, 8) : '';
  if (event !== '' && rows.some((row) => row.event === event)) {
    const existing = rows.find((row) => row.event === event);
    return { text, action: 'unchanged', seq: existing ? existing.seq : null };
  }

  const sessionKey = scrubExternal(String(entry.sessionId ?? ''), 8);
  const fresh = { seq: 0, at: entry.at, session: sessionKey, peak: '', size: '', cost: '', files: '', event, _fresh: true };
  rows.push(fresh);
  // 上限淘汰：每会话最多 N 行、全表最多 M 行；单次写入最多淘汰一行（避免一次触发删一堆）。
  const perSession = rows.filter((row) => row.session === sessionKey);
  if (perSession.length > LEDGER_MAX_PER_SESSION) rows.splice(rows.indexOf(perSession[0]), 1);
  else if (rows.length > LEDGER_MAX_ROWS) rows.splice(0, 1);
  const seq = rows.indexOf(fresh) + 1;

  const body = rows
    .map((row, index) =>
      row._fresh === true
        ? renderLedgerRow(t, entry, index + 1)
        : t('ledger.row', {
            i: index + 1,
            at: row.at,
            session: row.session,
            peak: row.peak,
            size: row.size,
            cost: row.cost,
            files: row.files,
            event: row.event,
          }),
    )
    .join('\n');
  const rebuild = `${renderLedgerHeader(t)}\n${body}\n${LEDGER_END}`;
  return { text: `${text.slice(0, start)}${rebuild}${text.slice(endIdx + LEDGER_END.length)}`, action: 'appended', seq };
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

/**
 * v0.7.0（审查 #21）：串行队列的键必须**规范化**。
 *
 * 旧实现拿 `file` 原串当键：`D:\proj\HANDOVER.md`（cwd 拼出来的）与 `d:\proj\hAnDoVer.md`
 * （配置里写的绝对路径、Windows 大小写不敏感）是两个键 ⇒ 同一个文件不排队 ⇒
 * 「读 → upsert → 写 → rename」交错时后写者会覆盖先写者的块（P1-3 防丢块的前提被绕过）。
 */
function queueKey(file) {
  const text = String(file ?? '');
  try {
    const resolved = resolve(text);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return text;
  }
}

function enqueueFileWrite(file, task) {
  const key = queueKey(file);
  const tail = fileWriteQueues.get(key) ?? Promise.resolve();
  const run = tail.then(task, task); // 前一次即使失败，也照样执行这一次
  const settled = run.then(
    () => {},
    () => {},
  );
  fileWriteQueues.set(key, settled);
  settled.finally(() => {
    if (fileWriteQueues.get(key) === settled) fileWriteQueues.delete(key);
  });
  return run;
}

export async function writeHandoverBlock({ file, sessionId, block, upsert = upsertHandoverBlock }) {
  return updateHandoverFile({ file, apply: (text) => upsert(text, sessionId, block) });
}

/**
 * 追加一行「压缩账」（v0.5.0）。与草稿块共用**同一个**按文件串行的写盘队列与原子写，
 * 所以「同一个 HANDOVER.md 上有两个写者」不会互相覆盖 —— 合并发生在锁内的 `existingText` 上。
 */
export async function appendLedgerRow({ file, entry, locale = 'zh' }) {
  return updateHandoverFile({ file, apply: (text) => upsertLedgerRow(text, entry, { locale }) });
}

/**
 * 唯一的写盘入口：读 → `apply(existingText)` → 硬化检查 → 唯一临时名 → rename。
 * `apply` 返回 `{text, action}`；`action` 原样作为 `status` 回给调用方（含 `broken-block`/`unchanged`）。
 */
export async function updateHandoverFile({ file, apply }) {
  if (typeof file !== 'string' || file === '') {
    return { status: 'error', path: null, bytes: 0, error: 'no-cwd' };
  }
  // 同一文件上的所有写入串行执行（自动草稿、手动 /draft、压缩账都走这里）
  return enqueueFileWrite(file, () => updateHandoverFileOnce({ file, apply }));
}

async function updateHandoverFileOnce({ file, apply }) {
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

    const { text, action, seq } = apply(existing ?? '');
    // 结构不认（缺 end、块被手工改坏）⇒ 不写盘，把原因交给调用方记状态。宁可不写，不可吞正文。
    if (action === 'broken-block') return { status: 'error', path: name, bytes: 0, error: 'broken-block' };
    if (action === 'unchanged' || text === (existing ?? '')) {
      return { status: 'unchanged', path: name, bytes: Buffer.byteLength(existing ?? '', 'utf8'), error: null, seq: seq ?? null };
    }
    // ⚠️ 临时名**必须唯一**（P1-3）：固定名在并发下会让先 `rename` 的一方把别人的内容搬走，
    //    第二个 `rename` 抛 ENOENT —— 日志报"写失败"，而文件其实已经被改过（排查的人会看错方向）。
    const tmp = `${file}.${process.pid}.${++tmpSeq}.dsh-context-guard.tmp`;
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tmp, file);
    } catch (error) {
      /**
       * v0.7.0（审查 #21）：rename 失败（Windows 上杀软/编辑器锁文件很常见）时，
       * 临时文件会留在用户仓库里，每失败一次多一个。这里尽力清理，再抛回原因。
       */
      try {
        await unlink(tmp);
      } catch {
        /* 清不掉就算了：不能因为清理失败掩盖真正的写入错误 */
      }
      throw error;
    }
    return { status: action, path: name, bytes: Buffer.byteLength(text, 'utf8'), error: null, seq: seq ?? null };
  } catch (error) {
    return { status: 'error', path: name, bytes: 0, error: String(error?.code ?? error?.message ?? error) };
  }
}
