/**
 * dsh-context-guard · 双语文案表（**host 半边与 client 半边共用一份**）
 *
 * 为什么单独一个文件：宿主半边的日志 / 草稿块与浏览器半边的徽标 / banner **必须说同一种话**，
 * 而 client 半边没有构建链（手写 bundle）⇒ 这张表要能像 `policy.mjs` 一样被
 * `scripts/build-client.mjs` 逐字内联进 factory。所以它**零依赖、纯 ESM**、不许 import。
 *
 * 三条设计约束（照 §19.6.2 定的做，别临时改主意）：
 *   1. 表里放**函数**，不发明 `{name}` 占位符 —— 原来怎么写模板字面量就怎么搬进来，改写风险最低；
 *   2. 每个 key 在 zh / en 两版**都必须存在**（`test/i18n.test.mjs` 逐 key 比对键集合，这是防漂移的
 *      唯一机械护栏；en 版还不许返回汉字）；
 *   3. 函数签名统一 `(vars, t)`：`t` 是**同语言**的查表函数，需要嵌套时直接调它
 *      （例如把「（未知）」嵌进表格行里），避免外层把半句话当参数传下来。
 *
 * ⚠️ 设置页那 18 条 `description` **不走这张表**：DSH 的 config schema 是加载期静态元数据，
 *    没有 per-locale 描述机制，设置页也无从知道会话语言 ⇒ 那里用「English / 中文」合并式
 *    （见 `lib/index.js`）。将来 DSH 若支持按 locale 描述，把那些字符串搬到这里查表即可。
 */

/** 支持的语言。'zh' 是兜底（拿不到任何线索时保持现状，不惊动现有用户）。 */
export const LOCALES = ['zh', 'en'];

/** 兜底语言：**刻意是 zh** —— 升级到本版时，语言线索缺失的老用户看到的文案不该变。 */
export const DEFAULT_LOCALE = 'zh';

/** 基本区 + 扩展 A + 兼容区。判定「这段文本是不是中文」只需要粗略命中，不做分词。 */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 文本里有没有汉字（host 半边用「该会话首条用户输入」猜语言）。 */
export function hasHan(text) {
  return typeof text === 'string' && HAN.test(text);
}

/**
 * 解析 `locale` 配置。两半边**能看到的线索不同**，所以线索按需传：
 *   - client 半边传 `navigatorLanguage`（`navigator.language`，浏览器语言）；
 *   - host 半边传 `sampleText`（该会话首条用户输入）—— 宿主侧**没有任何 locale 服务**可读；
 *   - 两半边都可以传 `env`（`DSH_CONTEXT_GUARD_LOCALE` 环境变量，文档里写成逃生阀）。
 *
 * 优先级：**显式 `zh`/`en` 最高** → navigator → 会话首条输入 → 环境变量 → `DEFAULT_LOCALE`。
 *
 * @param {'auto'|'zh'|'en'|string|undefined|null} pref
 * @param {{navigatorLanguage?: string, sampleText?: string, env?: string}} [hints]
 * @returns {'zh'|'en'}
 */
export function pickLocale(pref, hints = {}) {
  if (pref === 'zh' || pref === 'en') return pref;
  const nav = hints?.navigatorLanguage;
  if (typeof nav === 'string' && nav.trim() !== '') {
    // 只认前缀：`zh` / `zh-CN` / `zh-Hans` → zh，其余一律 en。
    return nav.trim().toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }
  const sample = hints?.sampleText;
  if (typeof sample === 'string' && sample.trim() !== '') return hasHan(sample) ? 'zh' : 'en';
  const env = hints?.env;
  if (env === 'zh' || env === 'en') return env;
  return DEFAULT_LOCALE;
}

/**
 * 取一个语言的查表函数。**永不抛**：键缺失时原样返回 key（有 `test/i18n.test.mjs` 盯着键集合，
 * 真漂移了会在测试里红，而不是在用户面前炸）。
 *
 * @param {'zh'|'en'} locale
 * @returns {(key: string, vars?: object) => string}
 */
export function makeT(locale) {
  const table = Object.prototype.hasOwnProperty.call(STRINGS, locale) ? STRINGS[locale] : STRINGS[DEFAULT_LOCALE];
  const t = (key, vars) => {
    const fn = table[key];
    if (typeof fn !== 'function') return key;
    return fn(vars === undefined || vars === null ? {} : vars, t);
  };
  return t;
}

/* eslint-disable no-template-curly-in-string */
export const STRINGS = {
  zh: {
    // ————————————————————————————————————————————————————————————————
    // policy.mjs · banner / 外推推送正文（原 `describe()` 与 `pushText()` 里的字面量）
    // ————————————————————————————————————————————————————————————————
    'banner.title.hard': (v) => `上下文 ${v.percent}% —— 该开新会话了`,
    'banner.title.warn': (v) => `上下文 ${v.percent}% —— 该收尾了`,
    'banner.body': (v) =>
      `本会话下一次请求将携带 ≈${v.projected} / ${v.window} 上下文（${v.percent}%）${v.compaction}。\n` +
      `建议本轮结束后：先把交接写进 \`${v.doc}\`，再开新会话。${v.trend}`,
    'banner.compaction': () => '（压缩让水位掉下去过一次，现在又上来了）',
    'banner.trend': (v) =>
      `\n近 ${v.hours} 小时内已有 ${v.sessions} 个会话撞到 hard —— 该考虑换工作方式了，不只是换这个会话。`,
    'push.title': () => '上下文压力偏高',
    'push.prefix': (v) => `[DSH 上下文守卫] ${v.title}${v.body ? `\n${v.body}` : ''}`,

    // ————————————————————————————————————————————————————————————————
    // handover.mjs · 自动草稿块的每一行（原 `composeHandoverBlock()` 里的字面量）
    // ————————————————————————————————————————————————————————————————
    'handover.heading': (v) =>
      `### 🤖 自动交接草稿（dsh-context-guard · ${v.time}${v.ratio === null ? '' : ` · 占用 ${(v.ratio * 100).toFixed(0)}%`}）`,
    'handover.note.zeroLlm': () => '> 本块由插件在跨过 `warnRatio` 时**零 LLM 自动生成**：只有机器事实，**没有结论**。',
    'handover.note.howto': () =>
      '> 请 agent 在下面「待补」里写结论 / 坑 / 下一步，或折进 `§0`/`§1` 后**把整块删掉**（它不参与人工编号）。',
    'handover.table.header': () => '| 项 | 值 |',
    'handover.row.session': (v) => `| 会话 | \`${v.id}\` · 「${v.title}」 |`,
    'handover.row.cwd': (v) => `| 工作目录 | ${v.cwd} |`,
    'handover.unknown': () => '（未知）',
    'handover.row.occupancy': (v) => `| 水位 | ${v.value} |`,
    'handover.occupancy.nodata': () => '无数据（fail-closed，不假装 0%）',
    'handover.occupancy.approx': (v) => `（≈${v.k} / ${v.w}，下一次请求口径）`,
    'handover.row.scale': (v) => `| 规模 | ${v.value} |`,
    'handover.scale.turns': (v) => `${v.n} 轮 · `,
    'handover.scale.calls': (v) => `${v.n} 次调用`,
    'handover.scale.callsUnknown': () => '调用数未知',
    'handover.scale.tools': (v) => ` · 工具 ${v.n} 次`,
    'handover.row.cost': (v) => `| 花费 | ${v.value} |`,
    'handover.cost.value': (v) => `**¥${v.amount}**（账本 \`tokenCost\`）`,
    'handover.cost.nodata': () => '（账本无数据）',
    'handover.row.time': (v) => `| 时间 | ${v.from} → ${v.to} |`,
    'handover.row.toolmix': (v) => `| 工具分布 | ${v.list} |`,
    'handover.files.heading': (v) => `**改过的文件**（最近 ${v.n} 个，倒序去重）`,
    'handover.files.none': () => '- （本次会话没有 `write` 类文件操作）',
    'handover.turns.heading': (v) => `**最近 ${v.n} 轮的诉求 / 回应摘要**`,
    'handover.turns.none': () => '- （宿主没有提供 `turnOutline`）',
    'handover.turn.line': (v) => `- **T${v.turn}** 诉求：\`${v.prompt}\` ｜ 回应：\`${v.response}\``,
    'handover.todo.heading': () => '**待补（由 agent 写）**',
    'handover.todo.conclusion': () => '- [ ] 结论：',
    'handover.todo.pitfalls': () => '- [ ] 踩过的坑 / 反直觉的地方：',
    'handover.todo.next': () => '- [ ] 未做完 / 下一步：',
    'handover.title.empty': () => '（无标题）',

    // ————————————————————————————————————————————————————————————————
    // client-source.js · 徽标 tooltip / banner 按钮 / 浏览器控制台
    // ————————————————————————————————————————————————————————————————
    'badge.title.context': (v) =>
      `本会话下一次请求将携带 ≈${v.projected} / ${v.window} 上下文（${v.percent}%）`,
    'badge.title.thresholds': (v) => `warn ${v.warn}% · hard ${v.hard}%`,
    'badge.title.push': (v) => `外推推送：微信（${v.level} 档起，间隔 ${v.minutes} 分钟）`,
    'badge.title.source.label': () => '阈值来源：',
    'badge.title.source.host': () => '宿主设置',
    'badge.title.source.builtin': (v) => `内置默认值（宿主设置读取${v.status}）`,
    'badge.action.hard': () => '该换会话了：先写交接，再开新会话。',
    'badge.action.warn': () => '该准备收尾了。',
    'badge.title.nodata': () => '暂无上下文压力数据（provider 未上报，或本会话尚未发出请求）',
    'banner.button.dismiss': () => '知道了',
    'banner.button.hide.title': () => '隐藏到下一档位（本会话这一档位不再提示）',
    'client.log.registered': () => '[context-guard] 会话头徽标 + 跨档 banner 已注册',
    'client.log.host.adopted': (v) =>
      `[context-guard] 已采用宿主设置（${v.keys} 项）：warn=${v.warn} hard=${v.hard}`,
    'client.log.host.failed': (v) => `[context-guard] 宿主设置读取${v.status}，使用内置默认值：${v.error}`,

    // ————————————————————————————————————————————————————————————————
    // index.js · 宿主日志（`info()` / `warn()`）
    // ————————————————————————————————————————————————————————————————
    'log.hit': (v) => `[${v.name}] ${v.title} —— ${v.body}`,
    'log.config.parseFailed': (v) => `[${v.name}] 重新解析设置失败（继续用上一份）：${v.error}`,
    'log.config.updated': (v) =>
      `[${v.name}] 设置已更新：warn=${v.warn} hard=${v.hard} 冷却=${v.cooldown}轮 ` +
      `enabled=${v.enabled} 外推=${v.push}`,
    'log.mounted': (v) =>
      `[${v.name}] 已挂载：warn=${v.warn} hard=${v.hard} 迟滞=${v.hysteresis} ` +
      `冷却=${v.cooldown}轮 onResume=${v.onResume} enabled=${v.enabled} ` +
      `外推=${v.push}${v.pushDetail}`,
    'log.mounted.pushDetail': (v) => `(${v.level} 档起 / 间隔 ${v.minutes} 分钟)`,
    'log.push.failed': (v) => `[${v.name}] 外推未成功（${v.code}）：${v.detail}`,
    'log.push.channelAbsent': () => 'wechatNotify 服务不可用（未装或未激活）',
    'log.push.emptyResult': () => '发送无返回',
    'log.push.noSender': (v) => `[${v.name}] 有 wechatNotify 服务但读不到 send()；外推推送保持不可用`,
    'log.push.ready': (v) => `[${v.name}] 外推通道就绪：wechatNotify`,
    'log.web.noRegister': (v) =>
      `[${v.name}] 有 webServer 服务但读不到 register()；浏览器半边将退回内置默认值`,
    'log.web.routeRegistered': (v) =>
      `[${v.name}] 已注册宿主状态路由 ${v.route}（浏览器半边据此用真源阈值，而不是内置默认值）`,
    'log.handover.written': (v) => `[${v.name}] 自动交接草稿（${v.status}）：${v.path}`,
    'log.handover.failed': (v) => `[${v.name}] 自动交接草稿失败：${v.path} —— ${v.error}`,
    'log.handover.noPath': () => '(无路径)',
    'log.handover.exception': (v) => `[${v.name}] 自动交接起草异常（已忽略）：${v.error}`,
    'log.projections.noOnChanged': (v) =>
      `[${v.name}] 有 sessionProjections 服务但读不到 onChanged；本插件静默降级`,
    'log.projections.subscribed': (v) => `[${v.name}] 已订阅 ${v.key} 等 ${v.count} 个投影（判定 + 交接素材）`,
    'log.observe.exception': (v) => `[${v.name}] observe 异常（已忽略）：${v.error}`,
    'log.arming.reset': (v) => `[${v.name}] 路由/模型变化：会话 ${v.session} 的提示武装已重置（避免新窗口配旧压力）`,
    'log.sessionEvent.exception': (v) => `[${v.name}] session/event 处理异常（已忽略）：${v.error}`,
    'log.resume.exception': (v) => `[${v.name}] resume 判定异常（已忽略）：${v.error}`,
  },

  en: {
    // ————————————————————————————————————————————————————————————————
    // policy.mjs · banner / push text
    // ————————————————————————————————————————————————————————————————
    'banner.title.hard': (v) => `Context ${v.percent}% — start a new session`,
    'banner.title.warn': (v) => `Context ${v.percent}% — wrap this one up`,
    'banner.body': (v) =>
      `This session's next request will carry ≈${v.projected} / ${v.window} of context (${v.percent}%)${v.compaction}.\n` +
      `After this turn: write the handoff into \`${v.doc}\` first, then open a new session.${v.trend}`,
    'banner.compaction': () => ' (the number dropped once during compaction and is high again)',
    'banner.trend': (v) =>
      `\n${v.sessions} sessions hit the hard line in the last ${v.hours}h — consider changing how you split the work, not just this session.`,
    'push.title': () => 'Context pressure is high',
    'push.prefix': (v) => `[DSH context-guard] ${v.title}${v.body ? `\n${v.body}` : ''}`,

    // ————————————————————————————————————————————————————————————————
    // handover.mjs · one key per line of the auto-draft block
    // ————————————————————————————————————————————————————————————————
    'handover.heading': (v) =>
      `### 🤖 Auto handoff draft (dsh-context-guard · ${v.time}${v.ratio === null ? '' : ` · ${(v.ratio * 100).toFixed(0)}% used`})`,
    'handover.note.zeroLlm': () =>
      '> Written by the plugin with **zero LLM calls** when the session crossed `warnRatio`: machine facts only, **no conclusions**.',
    'handover.note.howto': () =>
      '> Agent: write conclusions / pitfalls / next steps into the slots below, or fold them into `§0`/`§1` and **delete this whole block** (it is not part of the manual numbering).',
    'handover.table.header': () => '| Item | Value |',
    'handover.row.session': (v) => `| Session | \`${v.id}\` · "${v.title}" |`,
    'handover.row.cwd': (v) => `| Working directory | ${v.cwd} |`,
    'handover.unknown': () => '(unknown)',
    'handover.row.occupancy': (v) => `| Occupancy | ${v.value} |`,
    'handover.occupancy.nodata': () => 'no data (fail-closed; not pretending it is 0%)',
    'handover.occupancy.approx': (v) => `(≈${v.k} / ${v.w}, next-request basis)`,
    'handover.row.scale': (v) => `| Size | ${v.value} |`,
    'handover.scale.turns': (v) => `${v.n} turns · `,
    'handover.scale.calls': (v) => `${v.n} calls`,
    'handover.scale.callsUnknown': () => 'call count unknown',
    'handover.scale.tools': (v) => ` · ${v.n} tool calls`,
    'handover.row.cost': (v) => `| Cost | ${v.value} |`,
    'handover.cost.value': (v) => `**¥${v.amount}** (ledger \`tokenCost\`)`,
    'handover.cost.nodata': () => '(no data in the ledger)',
    'handover.row.time': (v) => `| Time | ${v.from} → ${v.to} |`,
    'handover.row.toolmix': (v) => `| Tool mix | ${v.list} |`,
    'handover.files.heading': (v) => `**Files changed** (last ${v.n}, newest first, deduplicated)`,
    'handover.files.none': () => '- (no `write` file operations in this session)',
    'handover.turns.heading': (v) => `**Last ${v.n} turns — request / response summary**`,
    'handover.turns.none': () => '- (the host did not provide `turnOutline`)',
    'handover.turn.line': (v) => `- **T${v.turn}** request: \`${v.prompt}\` | response: \`${v.response}\``,
    'handover.todo.heading': () => '**To fill in (by the agent)**',
    'handover.todo.conclusion': () => '- [ ] Conclusions:',
    'handover.todo.pitfalls': () => '- [ ] Pitfalls / counter-intuitive findings:',
    'handover.todo.next': () => '- [ ] Unfinished work / next steps:',
    'handover.title.empty': () => '(untitled)',

    // ————————————————————————————————————————————————————————————————
    // client-source.js · badge tooltip / banner buttons / browser console
    // ————————————————————————————————————————————————————————————————
    'badge.title.context': (v) =>
      `This session's next request will carry ≈${v.projected} / ${v.window} of context (${v.percent}%)`,
    'badge.title.thresholds': (v) => `warn ${v.warn}% · hard ${v.hard}%`,
    'badge.title.push': (v) => `Push: WeChat (from level ${v.level}, at most every ${v.minutes} min)`,
    'badge.title.source.label': () => 'Threshold source: ',
    'badge.title.source.host': () => 'host settings',
    'badge.title.source.builtin': (v) => `built-in defaults (host settings read ${v.status})`,
    'badge.action.hard': () => 'Time for a new session: write the handoff first, then start one.',
    'badge.action.warn': () => 'Time to start wrapping up.',
    'badge.title.nodata': () =>
      'No context-pressure data yet (provider has not reported, or this session has not sent a request)',
    'banner.button.dismiss': () => 'Got it',
    'banner.button.hide.title': () => 'Hide until the next level (this level will not be shown again in this session)',
    'client.log.registered': () => '[context-guard] session-header badge + level-crossing banner registered',
    'client.log.host.adopted': (v) =>
      `[context-guard] adopted host settings (${v.keys} keys): warn=${v.warn} hard=${v.hard}`,
    'client.log.host.failed': (v) => `[context-guard] host settings read ${v.status}; using built-in defaults: ${v.error}`,

    // ————————————————————————————————————————————————————————————————
    // index.js · host logs (`info()` / `warn()`)
    // ————————————————————————————————————————————————————————————————
    'log.hit': (v) => `[${v.name}] ${v.title} — ${v.body}`,
    'log.config.parseFailed': (v) => `[${v.name}] failed to re-parse settings (keeping the previous set): ${v.error}`,
    'log.config.updated': (v) =>
      `[${v.name}] settings updated: warn=${v.warn} hard=${v.hard} cooldown=${v.cooldown} turns ` +
      `enabled=${v.enabled} push=${v.push}`,
    'log.mounted': (v) =>
      `[${v.name}] mounted: warn=${v.warn} hard=${v.hard} hysteresis=${v.hysteresis} ` +
      `cooldown=${v.cooldown} turns onResume=${v.onResume} enabled=${v.enabled} ` +
      `push=${v.push}${v.pushDetail}`,
    'log.mounted.pushDetail': (v) => `(from level ${v.level} / every ${v.minutes} min)`,
    'log.push.failed': (v) => `[${v.name}] push did not succeed (${v.code}): ${v.detail}`,
    'log.push.channelAbsent': () => 'wechatNotify service unavailable (not installed or not active)',
    'log.push.emptyResult': () => 'send returned nothing',
    'log.push.noSender': (v) => `[${v.name}] wechatNotify service present but send() unreadable; push stays unavailable`,
    'log.push.ready': (v) => `[${v.name}] push channel ready: wechatNotify`,
    'log.web.noRegister': (v) =>
      `[${v.name}] webServer service present but register() unreadable; the browser half falls back to built-in defaults`,
    'log.web.routeRegistered': (v) =>
      `[${v.name}] host state route registered at ${v.route} (the browser half reads real settings from it instead of built-in defaults)`,
    'log.handover.written': (v) => `[${v.name}] auto handoff draft (${v.status}): ${v.path}`,
    'log.handover.failed': (v) => `[${v.name}] auto handoff draft failed: ${v.path} — ${v.error}`,
    'log.handover.noPath': () => '(no path)',
    'log.handover.exception': (v) => `[${v.name}] auto handoff drafting threw (ignored): ${v.error}`,
    'log.projections.noOnChanged': (v) =>
      `[${v.name}] sessionProjections service present but onChanged unreadable; this plugin degrades silently`,
    'log.projections.subscribed': (v) =>
      `[${v.name}] subscribed to ${v.key} and ${v.count} projections in total (decision + handoff material)`,
    'log.observe.exception': (v) => `[${v.name}] observe threw (ignored): ${v.error}`,
    'log.arming.reset': (v) =>
      `[${v.name}] route/model changed: re-armed guard for session ${v.session} (avoids pairing a new window with old pressure)`,
    'log.sessionEvent.exception': (v) => `[${v.name}] session/event handling threw (ignored): ${v.error}`,
    'log.resume.exception': (v) => `[${v.name}] resume decision threw (ignored): ${v.error}`,
  },
};
/* eslint-enable no-template-curly-in-string */
