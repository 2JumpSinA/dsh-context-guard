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
 * 本文件**只被宿主半边 import**，不进 `lib/client.js` 的 bundle（bundle 只内联 policy.mjs +
 * client-source.js）—— 所以这里可以自由使用 node 内置模块。
 */
import { readFile, writeFile, lstat, rename } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';

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

/** 最近 N 轮的「诉求 / 回应」摘要。 */
export function recentTurns(turnOutline, max = 6) {
  const turns = Array.isArray(turnOutline?.turns) ? turnOutline.turns : [];
  return turns.slice(-max).map((t) => ({
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
 * @param {object} input
 * @param {string} input.sessionId
 * @param {number} input.now
 * @param {{known: boolean, ratio: number|null, projectedTokens?: number|null, contextWindow?: number|null}} input.reading
 * @param {object} input.material 各 projection 的最新值
 * @param {object} input.config    归一化后的配置（只读 handoverTurns / handoverFiles）
 * @param {string|null} input.cwd
 */
export function composeHandoverBlock({ sessionId, now, reading, material = {}, config = {}, cwd = null }) {
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

  const title = typeof material.title === 'string' && material.title !== '' ? material.title : '（无标题）';
  const lines = [];
  lines.push(beginMarker(sessionId));
  lines.push('');
  lines.push(`### 🤖 自动交接草稿（dsh-context-guard · ${fmtTime(now)}${ratio === null ? '' : ` · 占用 ${(ratio * 100).toFixed(0)}%`}）`);
  lines.push('');
  lines.push('> 本块由插件在跨过 `warnRatio` 时**零 LLM 自动生成**：只有机器事实，**没有结论**。');
  lines.push('> 请 agent 在下面「待补」里写结论 / 坑 / 下一步，或折进 `§0`/`§1` 后**把整块删掉**（它不参与人工编号）。');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 会话 | \`${sessionId}\` · 「${squash(title, 60)}」 |`);
  lines.push(`| 工作目录 | ${cwd === null ? '（未知）' : `\`${cwd}\``} |`);
  lines.push(
    `| 水位 | ${ratio === null ? '无数据（fail-closed，不假装 0%）' : `**${(ratio * 100).toFixed(1)}%**${proj === null || win === null ? '' : `（≈${(proj / 1000).toFixed(0)}K / ${(win / 1000).toFixed(0)}K，下一次请求口径）`}`} |`,
  );
  lines.push(
    `| 规模 | ${Number.isFinite(stats.turns) ? `${stats.turns} 轮 · ` : ''}${Number.isFinite(cost.calls) ? `${cost.calls} 次调用` : '调用数未知'}${Number.isFinite(tl.timing?.toolCalls) ? ` · 工具 ${tl.timing.toolCalls} 次` : ''} |`,
  );
  lines.push(
    `| 花费 | ${Number.isFinite(cost.cost) ? `**¥${Number(cost.cost).toFixed(2)}**（账本 \`tokenCost\`）` : '（账本无数据）'} |`,
  );
  lines.push(
    // ⚠️ `createdAt` 由 index.js 的 `noteMaterial` 直接挂在 material 上（取自 session header），
    //    **不是** `identity.createdAt` —— 2026-09-30 真机草稿里这一格印成「—」就是这个读错字段的 bug。
    `| 时间 | ${fmtTime(Number.isFinite(material.createdAt) ? material.createdAt : identity.createdAt)} → ${fmtTime(cost.lastActivity ?? now)} |`,
  );
  if (mix.length > 0) {
    lines.push(`| 工具分布 | ${mix.map((m) => `${m.tool} ${m.calls}`).join(' · ')} |`);
  }
  lines.push('');

  lines.push(`**改过的文件**（最近 ${files.length} 个，倒序去重）`);
  lines.push('');
  if (files.length === 0) {
    lines.push('- （本次会话没有 `write` 类文件操作）');
  } else {
    for (const f of files) {
      const delta = f.added > 0 || f.removed > 0 ? ` · +${f.added}/-${f.removed}` : '';
      lines.push(`- \`${f.path}\`${f.tool === null ? '' : ` · ${f.tool}`}${delta}`);
    }
  }
  lines.push('');

  lines.push(`**最近 ${turns.length} 轮的诉求 / 回应摘要**`);
  lines.push('');
  if (turns.length === 0) {
    lines.push('- （宿主没有提供 `turnOutline`）');
  } else {
    for (const t of turns) {
      lines.push(`- **T${t.turn ?? '?'}** 诉求：\`${t.prompt || '—'}\` ｜ 回应：\`${t.response || '—'}\``);
    }
  }
  lines.push('');

  lines.push('**待补（由 agent 写）**');
  lines.push('');
  lines.push('- [ ] 结论：');
  lines.push('- [ ] 踩过的坑 / 反直觉的地方：');
  lines.push('- [ ] 未做完 / 下一步：');
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

/** 相对路径按会话工作目录解析；绝对路径原样使用。 */
export function resolveHandoverPath(cwd, configured) {
  if (typeof configured !== 'string' || configured.trim() === '') return null;
  const p = configured.trim();
  if (isAbsolute(p)) return p;
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
