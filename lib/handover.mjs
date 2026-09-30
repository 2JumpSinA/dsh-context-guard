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
  lines.push('');
  lines.push(t('handover.todo.conclusion'));
  lines.push(t('handover.todo.pitfalls'));
  lines.push(t('handover.todo.next'));
  lines.push('');
  lines.push(endMarker);
  return lines.join('\n');
}

/**
 * 幂等写入：同会话已有标记块 ⇒ 整块替换；否则**追加到文件末尾**（不动既有正文）。纯函数。
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
  return { text: `${text.slice(0, start)}${block}${text.slice(stop)}`, action: 'replaced' };
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
 *   · **原子替换**：同目录临时文件 + `rename`，避免「读—改—写」竞态把别的会话的块覆盖掉；
 *   · **权限收紧**：`mode 0o600`（内容含本次改过的文件清单与会话摘要）；
 *   · **只回文件名**：`path` 永远是 `basename`，绝不把本机绝对路径回给状态路由（P1-2）。
 *
 * @returns {Promise<{status: 'replaced'|'appended'|'error', path: string|null, bytes: number, error: string|null}>}
 */
export async function writeHandoverBlock({ file, sessionId, block }) {
  if (typeof file !== 'string' || file === '') {
    return { status: 'error', path: null, bytes: 0, error: 'no-cwd' };
  }
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

    const { text, action } = upsertHandoverBlock(existing ?? '', sessionId, block);
    const tmp = `${file}.dsh-context-guard.tmp`;
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
    return { status: action, path: name, bytes: Buffer.byteLength(text, 'utf8'), error: null };
  } catch (error) {
    return { status: 'error', path: name, bytes: 0, error: String(error?.code ?? error?.message ?? error) };
  }
}
