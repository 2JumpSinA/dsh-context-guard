/**
 * 由 `node scripts/build-client.mjs` 生成，**不要直接改这个文件**。
 *
 * 生成方式：把 `lib/i18n.mjs` + `lib/policy.mjs`（去掉跨模块 import 与所有 export）逐字注入下面的
 * factory，再加上 `lib/client-source.js` 的 UI 部分。`test/client-sync.test.mjs` 会重新生成一遍
 * 逐字节比对，所以「策略两边各写一份、慢慢漂移」这条路被堵死了。
 * ⚠️ 新增共享模块必须同时改 `scripts/build-client.mjs` 的 `SHARED_MODULES`（顺序即依赖顺序）。
 *
 * 手写 bundle 的契约（读自 `@deepseek-ai/dsh-client-modules` 的 boot 协议与已装插件实物）：
 *   - `window.__ModuleLoader__.load({ id, factory })`，**id 必须等于包名**（图行 id）；
 *   - factory 只在第一次 materialize 时跑一次，返回 `module.exports`；
 *   - 返回的就**是 cordis 插件对象** `{name, inject, apply}`；
 *   - 只 require 基线外部（react / react/jsx-runtime）；其余一律走 `ctx.slots` / props。
 */
window.__ModuleLoader__.load({
  id: "@2jumpsina/dsh-context-guard",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    /**
     * ⚠️ 诊断护栏：bundle 就是这一整个 factory。**它若抛异常，boot 只会说
     * 「1 entry did not activate / import failed」，真正的错误在浏览器控制台里**，
     * 而控制台很容易没人看（首轮实测就是这么被坑的）。所以这里显式接住，
     * 打一条带包名与堆栈的错误再原样抛出 —— 不吞异常，只让它可见。
     */
    try {
      var react = require("react");

      //#region 内嵌共享代码（唯一来源：lib/i18n.mjs + lib/policy.mjs）
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
    const LOCALES = ['zh', 'en'];

    /** 兜底语言：**刻意是 zh** —— 升级到本版时，语言线索缺失的老用户看到的文案不该变。 */
    const DEFAULT_LOCALE = 'zh';

    /** 基本区 + 扩展 A + 兼容区。判定「这段文本是不是中文」只需要粗略命中，不做分词。 */
    const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

    /** 文本里有没有汉字（host 半边用「该会话首条用户输入」猜语言）。 */
    function hasHan(text) {
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
    function pickLocale(pref, hints = {}) {
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
    function makeT(locale) {
      const table = Object.prototype.hasOwnProperty.call(STRINGS, locale) ? STRINGS[locale] : STRINGS[DEFAULT_LOCALE];
      const t = (key, vars) => {
        const fn = table[key];
        if (typeof fn !== 'function') return key;
        return fn(vars === undefined || vars === null ? {} : vars, t);
      };
      return t;
    }

    /* eslint-disable no-template-curly-in-string */
    const STRINGS = {
      zh: {
        // ————————————————————————————————————————————————————————————————
        // policy.mjs · banner / 外推推送正文（原 `guardDescribe()` 与 `pushText()` 里的字面量）
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

    /**
     * dsh-context-guard · 纯策略（零依赖，host 半边与 client 半边共用一份）
     *
     * 这里只做「拿官方算好的数字 → 一个提示决策」这一件事，不碰任何 cordis / React / DOM：
     *   - 输入：`contextPressure` projection（`projectedTokens` / `contextWindow`）
     *   - 输出：`{ state, signal }`，signal 只在本轮**跨越**档位的那一刻非 null（边沿触发）
     *
     * 为什么必须是纯函数：§10.2 第 3 条要求这个插件的上下文税 = 0（不注册 model-facing 工具、
     * 不注入任何 prompt 段落）。纯函数可以在真机之外被完整覆盖，装进运行时之前就能证明
     * 「双档 + 迟滞 + 冷却 + compaction 回落 + fail-closed」五条都对。
     *
     * 本文件是 client 半边 `lib/client.js` 里内嵌那段策略的**唯一来源**：
     * `scripts/build-client.mjs` 把本文件（连同 `lib/i18n.mjs`）去掉 import/export 后注入 client 的
     * factory，`test/client-sync.test.mjs` 逐字节核对，所以不存在「两边各写一份、慢慢漂移」。
     *
     * ⚠️ 允许的唯一 import 是 `./i18n.mjs`（文案表，同样会被内联进同一个作用域）—— 见 build 脚本的
     * `SHARED_MODULES`。除此之外本文件必须保持零依赖。
     */

    /** 档位。'none' = 不提示；'warn' = 该收尾了；'hard' = 该换会话了。 */
    const LEVELS = ['none', 'warn', 'hard'];

    /** 档位的可比较序（'none' < 'warn' < 'hard'），给「从哪一档起才外推」用。 */
    const LEVEL_ORDER = { none: 0, warn: 1, hard: 2 };

    /**
     * 宿主状态读取路由（**host 注册、client 读取**的那条通路）。
     *
     * 为什么路径要住在共享策略里：它是两半边之间的**契约**。写两份就会出现
     * 「宿主换了路径、浏览器还在读旧路径」这类只在真机上才暴露的漂移，
     * 而 build-client 的同源护栏能把这类漂移直接变成红灯。
     */
    const STATE_ROUTE = '/api/context-guard/state';

    /**
     * ⛔ **本文件里最贵的一条坑（2026-09-29 实测踩中）**：
     * 插件 `Config` 里标了 `.volatile()` 的字段，**`apply(ctx, config)` 收到的不是值，而是一个引用对象**
     * —— 只能 `config.warnRatio.get()` 拿到当前值。这是 DSH 让「设置页改完立即生效」的机制
     * （`@deepseek-ai/dsh-llm-deepseek` 的 `plainOptions()` 就是同一个写法）。
     *
     * 不摊平的后果是**静默拿到默认值**：patch 里配了 `warnRatio: 0.33`、设置页写进去了、
     * `settings.guardDescribe()` 也显示 0.33，而插件自己一直在按 0.6 判断 —— 没有任何报错，
     * 因为它读的是 `ref.warnRatio === undefined`。本次排查花了整整一轮，记在这里别再犯。
     *
     * 为什么不用 `import { isVolatile } from '@deepseek-ai/cosmokit'`：本插件靠 junction 挂在 profile 里，
     * Node 从**真实路径**（工作区内）解析依赖，那里没有 `@deepseek-ai/*`（`schemastery` 是我们自带的一份）。
     * 而 cosmokit 的判定就是 `Symbol.for('cosmokit.volatile.write') in value`，全局 symbol 跨副本同一把钥匙
     * ⇒ 自己写三行等价判定，比多挂一个包更稳。
     */
    const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

    /** 是不是 cosmokit 的 volatile 引用（照 `@deepseek-ai/cosmokit` 的 `isVolatile` 逐字等价）。 */
    function isVolatileRef(value) {
      return typeof value === 'object' && value !== null && VOLATILE_WRITE in value;
    }

    /**
     * 把 loader 交给插件的配置摊平成普通值（逐字段 `.get()`）。
     * 对普通对象（单测、client 收到的 JSON）是恒等变换，所以两边可以共用同一份。
     */
    function plainConfig(raw) {
      if (raw === null || typeof raw !== 'object') return {};
      const out = {};
      for (const key of Object.keys(raw)) {
        const value = raw[key];
        out[key] = isVolatileRef(value) ? value.get() : value;
      }
      return out;
    }

    /** 迟滞/冷却是**轮**为单位还是**观测**为单位，由调用方决定；这里只认单调自增的计数。 */
    function defaultConfig(overrides = {}) {
      return {
        enabled: true,
        // 用**官方定价**对「占用率 → 每次调用成本」曲线做过标定后，从 0.6 / 0.8 下调（见 README「阈值与设计取舍」）：
        //   · 观测到的会话峰值从未超过 ~80%（平台自身会在 ~80% 处 compaction）⇒ `hardRatio` 必须明显早于那一刻，
        //     否则 `respectCompaction` 会把提示消音，hard 档可能永远不出声；
        //   · 每次调用的成本随占用率近似线性上升（高档位约是空会话的数倍），因此越晚收尾越贵。
        warnRatio: 0.45,
        hardRatio: 0.6,
        hysteresisRatio: 0.05,
        cooldownTurns: 5,
        onResume: true,
        respectCompaction: true,
        includeCacheShare: true,
        crossSessionTrend: true,
        trendWindowHours: 24,
        trendEscalateAt: 3,
        // —— 自动交接草稿（2026-09-29 新增）。跨过 warnRatio 时由**宿主半边**零 LLM 起草一块机器事实
        //    （会话/水位/花费/改过的文件/最近几轮摘要），叙述留给 agent；只读已算好的投影 ⇒ 上下文税仍是 0。
        //    默认开：这是「一个任务一个会话」的落地动作 —— 45% 开始起草，60% 换会话时交接已经在文件里。
        handoverOnWarn: true,
        handoverPath: 'HANDOVER.md',
        handoverRefreshPercent: 5,
        handoverTurns: 6,
        handoverFiles: 12,
        // —— 文案语言（2026-09-30 新增）。`auto` 由两半边**各自**解析（能看到的线索不同）：
        //    client 看 `navigator.language`，host 看该会话首条用户输入是否含汉字，
        //    两边都拿不到 ⇒ 兜底 `zh`（保持升级前的行为，不惊动现有用户）。
        //    显式 `zh`/`en` 时两半边都听它的；设置页与启动日志用 `DSH_CONTEXT_GUARD_LOCALE` 兜底。
        locale: 'auto',
        // —— 外推推送（§10.5 之后那条线）。默认全关：**推送是显式选择**，
        //    一个提示插件绝不该在用户没要求的情况下往他手机里发消息。
        pushChannel: 'none',
        pushMinLevel: 'hard',
        pushCooldownMinutes: 10,
        ...overrides,
      };
    }

    /** 初始状态：一档都没武装（armed=false 表示还没进过 warn）。 */
    function initialState() {
      return {
        level: 'none',
        armed: false,
        turn: 0,
        cooldown: 0,
        compactionDrop: false,
        occupancy: null,
      };
    }

    /**
     * 把一份投影收敛成一次「观测」。
     *
     * ⛔ 一律 fail-closed（§10.3 第 5 条）：三个字段在官方那里是 **last-wins、不是一个原子观测**，
     * 切模型后会出现「新窗口配旧压力」。所以这里做三件保守的事：
     *   1. 分母（contextWindow）缺失 / 非正 / 非有限 ⇒ 不判定，UI 应显示「无数据」；
     *   2. 分子（projectedTokens）缺失 / 非有限 / 为负 ⇒ 同上；
     *   3. 分子 > 分母（只可能来自错配）⇒ 夹到 1.0，不产生 >100% 的荒谬提示。
     *
     * @param {{projectedTokens?: number, pressureTokens?: number, contextWindow?: number}|null|undefined} pressure
     * @returns {{known: boolean, ratio: number|null, ratioRaw: number|null, projectedTokens: number|null, pressureTokens: number|null, contextWindow: number|null, clampMismatch: boolean}}
     */
    function readOccupancy(pressure) {
      const empty = {
        known: false,
        ratio: null,
        ratioRaw: null,
        projectedTokens: null,
        pressureTokens: null,
        contextWindow: null,
        clampMismatch: false,
      };
      if (pressure === null || pressure === undefined || typeof pressure !== 'object') return empty;

      const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
      const projected = num(pressure.projectedTokens);
      const window_ = num(pressure.contextWindow);
      const raw = num(pressure.pressureTokens);

      if (projected === null || projected < 0) return { ...empty, contextWindow: window_, pressureTokens: raw };
      if (window_ === null || window_ <= 0) return { ...empty, projectedTokens: projected, pressureTokens: raw };

      const ratioRaw = projected / window_;
      const clampMismatch = ratioRaw > 1;
      return {
        known: true,
        ratio: clampMismatch ? 1 : ratioRaw,
        ratioRaw,
        projectedTokens: projected,
        pressureTokens: raw,
        contextWindow: window_,
        clampMismatch,
      };
    }

    /**
     * 核心决策：吸收一次观测。
     *
     * 五条规则对应 §10.3 的五个坑：
     *   1. 挂的是 `projectedTokens / contextWindow`（该不该换会话），不是缓存命中率（那是 damage-pulse 的活）；
     *   2. 一律比率，不用绝对 token（换模型即换窗口）；
     *   3. 双档 warn/hard + 迟滞（回落到 warn−hysteresis 才重新武装）+ 边沿（只在跨越那一刻发信号）+ 冷却 N 轮；
     *   4. compaction 交互：数字掉下来 ⇒ 清掉触发标志；`respectCompaction` 时压缩后的高水位才算数；
     *   5. 数据缺席 ⇒ 不改状态、不发信号（fail-closed）。
     *
     * @param {object} state 上一次的 GuardState
     * @param {object} reading readOccupancy 的返回值
     * @param {object} [options] { respectCompaction?: boolean, atTurnBoundary?: boolean }
     * @returns {{state: object, signal: object|null}}
     */
    function reduce(state, reading, options = {}) {
      const next = { ...state };
      if (!reading || reading.known !== true || reading.ratio === null) {
        // fail-closed：无分母不动状态机，也不清除既有档位（清除要靠 nextTurn 或回落观测）。
        return { state: next, signal: null };
      }

      const cfg = options.config ?? defaultConfig();
      const ratio = reading.ratio;
      const hysteresis = Math.max(0, cfg.hysteresisRatio ?? 0);
      // 回落线：warn 以下 hysteresis 才算「真的下来了」。hard 不设独立回落线 —— 回到 warn 区间即可重新武装。
      const rearmBelow = Math.max(0, cfg.warnRatio - hysteresis);

      const wasLevel = state.level;
      next.occupancy = {
        ratio,
        ratioRaw: reading.ratioRaw,
        projectedTokens: reading.projectedTokens,
        contextWindow: reading.contextWindow,
        clampMismatch: reading.clampMismatch,
      };

      // —— 回落即清旗（§10.3 第 4 条）：压缩遮蔽一段后 projectedTokens 会掉下来。
      if (ratio < rearmBelow) {
        if (wasLevel !== 'none') next.compactionDrop = true; // 记录「掉下来过」，供 UI 说明
        next.level = 'none';
        next.armed = false;
      } else if (ratio < cfg.warnRatio) {
        next.compactionDrop = false;
      }

      if (ratio < cfg.warnRatio) return { state: next, signal: null };

      const level = ratio >= cfg.hardRatio ? 'hard' : 'warn';

      if (!next.armed) {
        next.armed = true;
        next.level = level;
        next.cooldown = Math.max(0, cfg.cooldownTurns ?? 0);
        // compaction 之后仍在高水位：只有当调用方声明「这轮紧跟一次压缩」时才抑制。
        const suppressed =
          cfg.respectCompaction === true && options.atTurnBoundary === true && options.justCompacted === true;
        if (suppressed) return { state: next, signal: null };
        return { state: next, signal: signalOf('enter', level, next) };
      }

      // 已武装：只在档位**升级**的那一次再响（warn → hard），同级重复不响。
      const rank = { none: 0, warn: 1, hard: 2 };
      if (rank[level] > rank[wasLevel]) {
        next.level = level;
        return { state: next, signal: signalOf('escalate', level, next) };
      }
      next.level = level > wasLevel ? level : wasLevel;
      return { state: next, signal: null };
    }

    /** 收口一只信号，字段名与 UI 措辞都从这里取，避免两边各拼一套。 */
    function signalOf(kind, level, state) {
      return {
        kind, // 'enter' | 'escalate'
        level, // 'warn' | 'hard'
        ratio: state.occupancy?.ratio ?? null,
        projectedTokens: state.occupancy?.projectedTokens ?? null,
        contextWindow: state.occupancy?.contextWindow ?? null,
        turn: state.turn,
        compactionDrop: state.compactionDrop === true,
      };
    }

    /**
     * 一轮结束。§10.4：判定与提示只在 `turn/end`，绝不 mid-turn（那轮已经发出去了，提示没有意义）。
     *
     * @param {object} state
     * @param {object} [cfg]
     * @returns {object} 新状态
     */
    function nextTurn(state, cfg = defaultConfig()) {
      return {
        ...state,
        turn: state.turn + 1,
        cooldown: Math.max(0, (state.cooldown ?? 0) - 1),
        compactionDrop: false,
      };
    }

    /** 冷却期还没过 ⇒ 本轮即便跨档也不出声（但状态照样更新，徽标照样显示真数字）。 */
    function inCooldown(state) {
      return (state.cooldown ?? 0) > 0;
    }

    /**
     * 「这一次跨档要不要外推推送」——纯决策，与通道实现分离（§10.5 之后那条线）。
     *
     * 为什么单独抽出来而不是写在 `apply()` 里：推送是**唯一会跑到用户手机上的**副作用，
     * 它必须能在真机之外被逐条证伪（关着不推、不到档不推、冷却内不推），
     * 而不是靠「读一遍代码觉得没问题」。
     *
     * 与 UI 提示的关系：**外推是 UI 的补集，不是替代**。UI 侧的边沿触发已经保证「同一档位只响一次」，
     * 这里再加一道**跨会话的分钟级冷却** —— 否则同时开着三个会话时，三次硬跨档会连着往微信里发三条。
     *
     * @param {string} level 本次信号的档位（'none' | 'warn' | 'hard'）
     * @param {object} [config] 归一化后的配置
     * @param {{now?: number, lastPushAt?: number}} [state] 注入时钟与上次推送时刻（便于单测）
     * @returns {{push: boolean, reason: string, channel: string, cooldownMs: number}}
     */
    function shouldPush(level, config = {}, state = {}) {
      const channel = config.pushChannel ?? 'none';
      const cooldownMs = Math.max(0, Number(config.pushCooldownMinutes ?? 0)) * 60_000;
      const verdict = (push, reason) => ({ push, reason, channel, cooldownMs });
      if (channel === 'none') return verdict(false, 'channel-off');
      if (level === undefined || level === null) return verdict(false, 'no-level');
      const rank = LEVEL_ORDER[level] ?? 0;
      const min = LEVEL_ORDER[config.pushMinLevel ?? 'hard'] ?? LEVEL_ORDER.hard;
      if (rank === 0) return verdict(false, 'level-none');
      if (rank < min) return verdict(false, 'below-min-level');
      const now = typeof state.now === 'number' ? state.now : Date.now();
      const lastPushAt = typeof state.lastPushAt === 'number' ? state.lastPushAt : 0;
      if (lastPushAt > 0 && now - lastPushAt < cooldownMs) return verdict(false, 'cooldown');
      return verdict(true, 'edge');
    }

    /**
     * 外推推送的正文：一处格式化，UI 与 IM 说同一句话（含指向 `HANDOVER.md` 的下一步）。
     *
     * ⚠️ 语言**优先跟 `described.lang` 走**：`title`/`body` 是 `guardDescribe()` 在那一刻按某种语言生成的，
     * 只把前缀换成另一种语言会得到中英混排的一句话。`opts.lang` 是给「调用方自己拼的 described
     * （老代码 / 手工构造）」留的兜底，不是覆盖开关。
     *
     * @param {{title?: string, body?: string, lang?: 'zh'|'en'}} described `guardDescribe()` 的结论
     * @param {{lang?: 'zh'|'en'}} [opts] 兜底语言（`described.lang` 缺席时才看它，再不给就是 `zh`）
     * @returns {string}
     */
    function pushText(described, opts = {}) {
      const lang = (described?.lang ?? opts.lang) === 'en' ? 'en' : 'zh';
      const t = makeT(lang);
      const title = described?.title ?? t('push.title');
      const body = described?.body ?? '';
      return t('push.prefix', { title, body });
    }

    /**
     * 跨会话趋势（§10.5 的第二种语义）。
     *
     * 「最近 3 个会话都撞 hard」比「这个会话该换了」大一号：措辞该升级成「该换工作方式」。
     * 只在内存里存最近 `trendWindowHours` 小时内的触发时刻与档位，重启即清零 —— 这是提示性
     * 统计，不是账本，不值得落盘、更不该因此引入 IO 失败面。
     */
    class TrendTracker {
      /** @param {object} [cfg] */
      constructor(cfg = defaultConfig()) {
        this.cfg = cfg;
        /** @type {{at: number, sessionId: string, level: string}[]} */
        this.events = [];
      }

      /** 记一次触发。同一会话同一档位只记一次（避免徽标刷屏把趋势泡涨）。 */
      note(sessionId, level, at = Date.now()) {
        if (level !== 'warn' && level !== 'hard') return;
        const dup = this.events.some((e) => e.sessionId === sessionId && e.level === level);
        if (dup) return;
        this.events.push({ at, sessionId, level });
        this.prune(at);
      }

      /** 丢掉窗口之外的事件。 */
      prune(at = Date.now()) {
        const cutoff = at - Math.max(1, this.cfg.trendWindowHours ?? 24) * 3600_000;
        this.events = this.events.filter((e) => e.at >= cutoff);
      }

      /**
       * @param {number} [at]
       * @returns {{hardSessions: number, warnSessions: number, escalated: boolean, windowHours: number}}
       */
      summary(at = Date.now()) {
        this.prune(at);
        const hard = new Set();
        const warn = new Set();
        for (const e of this.events) (e.level === 'hard' ? hard : warn).add(e.sessionId);
        return {
          hardSessions: hard.size,
          warnSessions: warn.size,
          escalated: hard.size >= Math.max(2, this.cfg.trendEscalateAt ?? 3),
          windowHours: this.cfg.trendWindowHours ?? 24,
        };
      }
    }

    /**
     * 提示文案。§10.6：占比数字 + 下一步动作 + 指向交接文档。
     *
     * 刻意**不自造**上下文传递机制，而是指回本工作区既有的 `HANDOVER.md` 惯例
     * （新会话入场成本 ≈3K token）。与 `dsh-migrate-on-429` 的分工：这里只是预防性提示。
     *
     * @param {object} signal
     * @param {object} [opts] { trend?: object, handoffDoc?: string, lang?: 'zh'|'en' }
     * @returns {{title: string, body: string, ratioPercent: number, level: string, lang: 'zh'|'en'}}
     */
    function guardDescribe(signal, opts = {}) {
      const lang = opts.lang === 'en' ? 'en' : 'zh';
      const t = makeT(lang);
      const doc = opts.handoffDoc ?? 'HANDOVER.md';
      const ratio = signal.ratio ?? 0;
      const percent = Math.round(ratio * 100);
      const projected = signal.projectedTokens;
      const window_ = signal.contextWindow;
      const kTokens = (n) => (typeof n === 'number' ? `${Math.round(n / 1000)}K` : '?');
      const trend = opts.trend;
      const trendLine =
        trend && trend.escalated ? t('banner.trend', { hours: trend.windowHours, sessions: trend.hardSessions }) : '';
      const compactionLine = signal.compactionDrop === true ? t('banner.compaction') : '';

      return {
        level: signal.level,
        ratioPercent: percent,
        lang,
        title: t(signal.level === 'hard' ? 'banner.title.hard' : 'banner.title.warn', { percent }),
        body: t('banner.body', {
          projected: kTokens(projected),
          window: kTokens(window_),
          percent,
          compaction: compactionLine,
          doc,
          trend: trendLine,
        }),
      };
    }

    /** 徽标只显示数字，不显示措辞；无数据时给一句显式的话（不要假装是 0%）。 */
    function badgeText(reading) {
      if (!reading || reading.known !== true || reading.ratio === null) return { text: 'ctx —', known: false };
      return { text: `ctx ${Math.round(reading.ratio * 100)}%`, known: true };
    }
      //#endregion

      //#region UI
    /**
     * dsh-context-guard · client 半边 UI（被 `scripts/build-client.mjs` 内联进 client.js）
     *
     * 这一半做三件事（§10.2 第 4 条「宿主算数、UI 说话」的 UI 侧）：
     *   1. 会话头徽标：实时占用率，**只显示数字、不出声**；
     *   2. 跨越 warn/hard 时一次性 banner：占比 + 下一步动作 + 指向 `HANDOVER.md`（§10.6）；
     *   3. 两个槽位共用**同一台状态机**（否则徽标与 banner 会各说各话）。
     *
     * ⛔ 不注入 prompt、不注册 model-facing 工具、不发额外请求 ⇒ 上下文税 0。
     * 数字全部来自官方 `contextPressure` 投影（`useProjection` 这个第五个标准钩子席），
     * 插件只是消费已算好的值。
     *
     * 阈值来源（**三层，优先级由低到高**，`runtimeConfig` 一处合并）：
     *   1. 内嵌策略的 `defaultConfig()`（出厂默认，两边同一份代码）；
     *   2. **宿主真源**：`fetch(STATE_ROUTE)` 读 `lib/index.js` 归一化后的 Config
     *      （`/api/context-guard/state`，同一台机器上的 webServer 路由，无 token、same-origin）
     *      —— 这就是原先「client 读不到宿主设置」那个未做完项的通路；
     *   3. **逃生阀** `window.__DSH_CONTEXT_GUARD__.config`（Console 里可实时改，优先级最高）。
     *
     * ⚠️ 第 2 层是 **fail-soft**，不是 fail-closed：读不到宿主设置时**退回第 1 层默认值继续工作**。
     *    这与 §10.3 第 5 条（缺分母就不判定）不是一回事 —— 那里是「没有事实就不许下结论」，
     *    这里是「拿不到偏好就用默认偏好」，一句提示的档位不值得因为一次 fetch 失败而消失。
     *
     * 语言（`config.locale`，2026-09-30 新增）：`auto` 时**本半边看 `navigator.language`**
     * （宿主半边看的是该会话首条输入是否含汉字 —— 两边能看到的线索本来就不同，见 `lib/i18n.mjs`）。
     * 文案全部查 `STRINGS` 表；表与策略一起被内联进同一个作用域，所以这里直接用 `makeT` / `pickLocale`。
     */

    /**
     * 读宿主真源（第 2 层）。**一次**（页面加载时），失败就退回默认值；
     * 设置改完要刷新页面才生效 —— 与「client 半边要刷新浏览器才进图」是同一件事。
     * 不轮询：提示插件不该为了几个阈值一直占着网络。
     */
    var hostSync = { status: 'idle', at: 0, error: null, route: STATE_ROUTE, keys: 0 };

    /**
     * 逃生阀 + 宿主真源：**三层合并**（默认 < 宿主 < 逃生阀），一处收敛。
     *   - 页面脚本/用户任意时刻调 `window.__DSH_CONTEXT_GUARD__.override({ warnRatio: 0.3 })`
     *     就会重算配置并让 store 与两个槽位下一次渲染立刻用新档位（不用刷新页面）；
     *   - 如果页面上**已经有**这个对象（例如验证脚本用 addInitScript 先设好），
     *     就把它当初始覆盖读进来；
     *   - `host` 是 `fetch(STATE_ROUTE)` 读回来的宿主 Config（见上）。
     *
     * ⚠️ 配置在 **store 创建时**读、之后只在 override / 宿主同步时重算 —— 不在模块顶层读：
     * client bundle 的整个主体就是一个 `factory()`，内联进来的策略代码被包在 `try {}` 里，
     * 在那里 `var` 声明却在块外读取会踩提升顺序的坑（首轮实测就是这个：`CONFIG is not defined`）。
     */
    function overrideFromWindow() {
      var w = typeof window !== "undefined" ? window.__DSH_CONTEXT_GUARD__ : undefined;
      return (w && w.config) || {};
    }

    /** 只认策略认识的那些键：宿主多塞字段（或恶意页面塞东西）不该改变档位语义。 */
    function pickKnown(source) {
      var out = {};
      var known = defaultConfig();
      for (var k in known) {
        if (!Object.prototype.hasOwnProperty.call(known, k)) continue;
        if (source && Object.prototype.hasOwnProperty.call(source, k)) out[k] = source[k];
      }
      return out;
    }

    function runtimeConfig(hostConfig, overrideConfig) {
      var cfg = defaultConfig(pickKnown(hostConfig));
      cfg = defaultConfig(Object.assign({}, cfg, pickKnown(overrideConfig)));
      if (!(cfg.hardRatio > cfg.warnRatio)) cfg.hardRatio = Math.min(1, cfg.warnRatio + 0.05);
      return cfg;
    }

    /**
     * 每会话一台状态机 + 一个趋势表。**两个槽位共用同一个实例**。
     *
     * 两条防自激的设计（都是踩过 React 外部 store 的经典坑）：
     *   - `offer` 记住上一次收到的 pressure **引用**，同一个引用直接返回 —— 投影值本身是
     *     reference-stable 的（每帧/基线才换一次），所以「effect → offer → notify → 重渲染 →
     *     effect」这条环在这里被切断，不会自旋。
     *   - 观测走**串行队列**：microtask 里一次排空，保证状态机推进顺序 == 事件顺序
     *     （同步合并会把两个连续观测压成一个，边沿就丢了）。
     */
    function createGuardStore() {
      var hostCfg = {};
      var overrideCfg = overrideFromWindow();
      var cfg = runtimeConfig(hostCfg, overrideCfg);
      var sessions = new Map();
      var trend = new TrendTracker(cfg);
      var listeners = new Set();
      var queue = [];
      var draining = false;

      /**
       * 本半边的语言解析：显式 `zh`/`en` 最高，其次 `navigator.language`，都没有 ⇒ `zh` 兜底。
       * 每次配置变化（宿主同步 / 逃生阀 override）都重算 —— 改语言不必刷新页面。
       */
      function resolveLocale() {
        return pickLocale(cfg.locale, {
          navigatorLanguage: typeof navigator !== "undefined" ? navigator.language : undefined,
        });
      }
      var locale = resolveLocale();
      var t = makeT(locale);
      function retranslate() {
        var next = resolveLocale();
        if (next === locale) return;
        locale = next;
        t = makeT(next);
      }

      function slotOf(id) {
        var s = sessions.get(id);
        if (s === undefined) {
          s = { state: initialState(), reading: null, signal: null, seq: 0, lastPressure: undefined };
          sessions.set(id, s);
        }
        return s;
      }

      function emit() {
        listeners.forEach(function (notify) {
          try {
            notify();
          } catch (error) {
            /* 一个订阅者炸了不能拖死别的槽位 */
          }
        });
      }

      function drain() {
        if (draining) return;
        draining = true;
        try {
          while (queue.length > 0) {
            var item = queue.shift();
            consume(item[0], item[1]);
          }
        } finally {
          draining = false;
        }
      }

      function consume(sessionId, pressure) {
        var session = slotOf(sessionId);
        var reading = readOccupancy(pressure);
        var out = reduce(session.state, reading, { config: cfg, atTurnBoundary: true, justCompacted: false });
        var changed = session.reading === null || !sameReading(session.reading, reading);
        session.state = out.state;
        session.reading = reading;
        if (out.signal !== null && cfg.enabled) {
          var cooled = out.state.cooldown > 0 && out.signal.kind !== "enter";
          if (!cooled) {
            session.signal = out.signal;
            session.seq += 1;
            changed = true;
            if (cfg.crossSessionTrend) trend.note(sessionId, out.signal.level);
          }
        }
        if (changed) emit();
      }

      function sameReading(a, b) {
        return (
          a.known === b.known &&
          a.ratio === b.ratio &&
          a.projectedTokens === b.projectedTokens &&
          a.contextWindow === b.contextWindow &&
          a.clampMismatch === b.clampMismatch
        );
      }

      return {
        config: function () {
          return cfg;
        },
        /** 当前文案语言（`zh` / `en`）。给排障把手与验收脚本看，别在组件里自己算。 */
        locale: function () {
          return locale;
        },
        /** 查表函数：组件渲染统一走它，避免半句中文半句英文。 */
        t: function (key, vars) {
          return t(key, vars);
        },
        /** 实时改档位（顺序地套用 normalize 规则），供 `__DSH_CONTEXT_GUARD__.override()` 用。 */
        setConfig: function (next) {
          for (var j in next) if (Object.prototype.hasOwnProperty.call(next, j)) overrideCfg[j] = next[j];
          cfg = runtimeConfig(hostCfg, overrideCfg);
          trend.cfg = cfg;
          retranslate();
          emit();
          return cfg;
        },
        /**
         * 套用宿主真源（第 2 层）。**只影响档位与措辞，不碰任何会话状态** ——
         * 已经算出来的读数不会被一次配置同步抹掉，否则「改个阈值就把 banner 的判据洗掉」。
         */
        setHostConfig: function (next) {
          hostCfg = pickKnown(next);
          cfg = runtimeConfig(hostCfg, overrideCfg);
          trend.cfg = cfg;
          retranslate();
          emit();
          return cfg;
        },
        hostConfig: function () {
          return hostCfg;
        },
        trend: function () {
          return trend.summary();
        },
        sessionOf: function (id) {
          return sessions.get(id) || null;
        },
        /** 排障用只读快照：每会话的档位、读数、信号序号。 */
        dump: function () {
          var out = {};
          sessions.forEach(function (value, key) {
            out[key] = {
              level: value.state ? value.state.level : null,
              armed: value.state ? value.state.armed : null,
              cooldown: value.state ? value.state.cooldown : null,
              seq: value.seq,
              reading: value.reading,
              signal: value.signal,
            };
          });
          return out;
        },
        subscribe: function (notify) {
          listeners.add(notify);
          return function () {
            listeners.delete(notify);
          };
        },
        offer: function (sessionId, pressure) {
          var session = slotOf(sessionId);
          if (pressure === session.lastPressure) return; // 切断自激环（见上）
          session.lastPressure = pressure;
          queue.push([sessionId, pressure]);
          queueMicrotask(drain);
        },
        settleTurn: function (sessionId) {
          var session = slotOf(sessionId);
          session.state = nextTurn(session.state, cfg);
        },
      };
    }

    var store = createGuardStore();

    /**
     * 从宿主真源同步一次设置（`GET STATE_ROUTE`）。
     *
     * 三条不许破的性质：
     *   - **不抛**：任何失败都收敛成 `hostSync.status = 'failed'` + 退回默认值（fail-soft，见文件头）；
     *   - **不刷屏**：只在 `apply()` 时读一次；Console 里可手动 `refreshFromHost()`；
     *   - **不影响渲染路径**：sync 只写配置与一个只读状态对象，槽位渲染不依赖它完成（先渲染、后到货）。
     *
     * @returns {Promise<{status: string, config?: object}>} 永不 reject
     */
    function syncFromHost() {
      if (typeof fetch !== "function") {
        hostSync = { status: "unsupported", at: Date.now(), error: "no fetch", route: STATE_ROUTE, keys: 0 };
        return Promise.resolve({ status: hostSync.status });
      }
      hostSync = { status: "loading", at: Date.now(), error: null, route: STATE_ROUTE, keys: 0 };
      return fetch(STATE_ROUTE, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" } })
        .then(function (response) {
          if (!response || response.ok !== true) throw new Error("HTTP " + (response ? response.status : "?"));
          return response.json();
        })
        .then(function (payload) {
          var host = (payload && payload.config) || {};
          var applied = store.setHostConfig(host);
          hostSync = {
            status: "ok",
            at: Date.now(),
            error: null,
            route: STATE_ROUTE,
            keys: Object.keys(host).length,
            pushChannel: applied.pushChannel,
            at_host: payload && payload.at,
          };
          return { status: "ok", config: applied };
        })
        .catch(function (error) {
          hostSync = {
            status: "failed",
            at: Date.now(),
            error: String((error && error.message) || error).slice(0, 200),
            route: STATE_ROUTE,
            keys: 0,
          };
          return { status: "failed", error: hostSync.error };
        });
    }

    /**
     * 槽位内的订阅钩子。`getSnapshot` 返回会话槽对象本身（引用稳定，只有真的变了才换），
     * 所以 React 拿到的是一个不会每次渲染都新建的值。
     */
    function useGuard(sessionId) {
      return react.useSyncExternalStore(
        function (notify) {
          return store.subscribe(notify);
        },
        function () {
          return store.sessionOf(sessionId);
        },
        function () {
          return null;
        },
      );
    }

    /** 投影钩子席的防御性读取：席位缺席（旧 harness / 没有 token-meter）时返回 undefined，
     *  而不是把异常抛进整个会话头。 */
    function safeProjection(props, key) {
      try {
        if (props && typeof props.useProjection === "function") return props.useProjection(key);
      } catch (error) {
        /* capability absent */
      }
      return undefined;
    }

    /** 两个槽位共用的「喂观测」效果。 */
    function useOffer(sessionId, pressure) {
      react.useEffect(
        function () {
          if (sessionId !== null) store.offer(sessionId, pressure);
        },
        [sessionId, pressure],
      );
    }

    function sessionIdOf(props) {
      var id = props && (props.sessionId !== undefined ? props.sessionId : props.session && props.session.id);
      return id === undefined || id === null || id === "" ? null : String(id);
    }

    var COLORS = {
      none: { fg: "var(--dsh-text-secondary, #6b7280)", dot: "var(--dsh-text-tertiary, #9ca3af)" },
      warn: { fg: "var(--dsh-warning-text, #b45309)", dot: "var(--dsh-warning, #f59e0b)" },
      hard: { fg: "var(--dsh-danger-text, #b91c1c)", dot: "var(--dsh-danger, #dc2626)" },
    };

    function kTokens(n) {
      return typeof n === "number" && isFinite(n) ? Math.round(n / 1000) + "K" : "?";
    }

    /**
     * 徽标：`ctx 82%`。**无数据时显式显示「ctx —」**（§10.3 第 5 条 fail-closed：
     * 没有分母就绝不假装是 0%，UI 上必须是两句话）。
     */
    function Badge(props) {
      var sessionId = sessionIdOf(props);
      var pressure = safeProjection(props, "contextPressure");
      useOffer(sessionId, pressure);

      var session = useGuard(sessionId);
      var cfg = store.config();
      var reading = session ? session.reading : null;
      var badge = badgeText(reading);
      var level = (session && session.state && session.state.level) || "none";
      var colors = COLORS[level] || COLORS.none;
      var ratio = reading && reading.known ? Math.max(0, Math.min(1, reading.ratio)) : 0;
      var hasData = badge.known;
      var percent = Math.round((reading && reading.ratio ? reading.ratio : 0) * 100);

      var tr = store.t;
      var title;
      if (hasData) {
        title =
          tr("badge.title.context", {
            projected: kTokens(reading.projectedTokens),
            window: kTokens(reading.contextWindow),
            percent: percent,
          }) +
          "\n" +
          tr("badge.title.thresholds", {
            warn: Math.round(cfg.warnRatio * 100),
            hard: Math.round(cfg.hardRatio * 100),
          }) +
          (cfg.pushChannel !== "none"
            ? "\n" + tr("badge.title.push", { level: cfg.pushMinLevel, minutes: cfg.pushCooldownMinutes })
            : "") +
          "\n" +
          tr("badge.title.source.label") +
          (hostSync.status === "ok"
            ? tr("badge.title.source.host")
            : tr("badge.title.source.builtin", { status: hostSync.status })) +
          (level === "hard"
            ? "\n" + tr("badge.action.hard")
            : level === "warn"
              ? "\n" + tr("badge.action.warn")
              : "");
      } else {
        title = tr("badge.title.nodata");
      }

      return react.createElement(
        "div",
        {
          title: title,
          "data-dsh-context-guard": "badge",
          "data-level": level,
          "data-percent": hasData ? String(percent) : "",
          style: {
            display: "inline-flex",
            flexDirection: "column",
            gap: "2px",
            padding: "2px 7px",
            borderRadius: "8px",
            border: "1px solid var(--dsh-border, rgba(128,128,128,.28))",
            background: "var(--dsh-surface-secondary, rgba(128,128,128,.06))",
            lineHeight: 1.1,
            cursor: "default",
            userSelect: "none",
          },
        },
        react.createElement(
          "span",
          {
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "11px",
              fontWeight: 600,
              color: colors.fg,
              whiteSpace: "nowrap",
            },
          },
          react.createElement("span", {
            style: { width: "6px", height: "6px", borderRadius: "50%", background: colors.dot, flex: "0 0 auto" },
          }),
          badge.text,
        ),
        react.createElement(
          "span",
          {
            style: {
              display: "inline-flex",
              gap: "2px",
              height: "2px",
              width: "34px",
              opacity: hasData ? 1 : 0.3,
              background: "var(--dsh-border, rgba(128,128,128,.25))",
              borderRadius: "2px",
              overflow: "hidden",
            },
          },
          react.createElement("span", { style: { flex: String(Math.max(0.0001, ratio)), background: colors.dot } }),
          react.createElement("span", { style: { flex: String(Math.max(0.0001, 1 - ratio)) } }),
        ),
      );
    }

    /**
     * 一次性 banner（§10.4「当前回复结束后提示」+ §10.6 文案）。
     *
     * 「一次性」只由**两道真闸**保证，刻意**不做**「用户一动鼠标就算他看过了」那种聪明：
     *   ① 策略层 `signal` 只在**跨越那一刻**产生（边沿触发），同级重复不产生；
     *   ② 本 Map 记「本会话这一档位已经出过声」—— 点「知道了」或 × 才写一条。
     * 只有**回落之后重新爬升**（策略会再产生一个 enter）或**升级到下一档**时才会再来一次，
     * 那是想要的行为，不是复读。
     *
     * ⚠️ 首轮实测踩过的坑：一开始还加了「窗口级 mousedown/keydown 就标已读」，
     * 结果用户在 banner 出现**之前**的任何点击（例如点侧栏新建会话）都会把它标掉，
     * 于是「明明该响却不响」，而且原因极难查。提示插件的原则是**宁可留着让人点掉**，
     * 也不要替用户判定「他已经看过了」。
     */
    var bannerSeen = new Map();

    function Banner(props) {
      var sessionId = sessionIdOf(props);
      var pressure = safeProjection(props, "contextPressure");
      useOffer(sessionId, pressure);

      var session = useGuard(sessionId);
      var cfg = store.config();
      var bumpPair = react.useState(0);
      var bump = bumpPair[1];
      var level = session && session.state ? session.state.level : "none";
      var reading = session ? session.reading : null;
      var ratio = reading && reading.known ? reading.ratio : 0;
      var key = sessionId !== null ? sessionId + "|" + level : null;
      var seen = key !== null ? bannerSeen.get(key) : undefined;
      /** 只在「本会话这一档位还没出过声」时才显示。 */
      var visible = level !== "none" && cfg.enabled && key !== null && seen === undefined;

      if (!visible) return null;

      try {
        return renderBanner(props, { sessionId: sessionId, session: session, level: level, reading: reading, ratio: ratio, key: key, cfg: cfg, bump: bump });
      } catch (error) {
        // React 会吞掉渲染期异常（没有 error boundary 时只留下一条 console 错误），
        // 所以这里显式接住并打点：宁可看见一条噪音日志，也不要「明明该响却不响」。
        if (typeof window !== "undefined") {
          window.__DSH_CONTEXT_GUARD_ERR__ = (window.__DSH_CONTEXT_GUARD_ERR__ || []).concat([
            { where: "Banner", message: String((error && error.stack) || error).slice(0, 500), at: Date.now() },
          ]);
        }
        return null;
      }
    }

    /** Banner 的实际渲染体（单独一个函数，方便上面整块接住异常）。 */
    function renderBanner(props, ctxBag) {
      var sessionId = ctxBag.sessionId;
      var session = ctxBag.session;
      var level = ctxBag.level;
      var reading = ctxBag.reading;
      var ratio = ctxBag.ratio;
      var key = ctxBag.key;
      var cfg = ctxBag.cfg;
      var bump = ctxBag.bump;

      var described = guardDescribe(
        {
          kind: "enter",
          level: level,
          ratio: ratio,
          projectedTokens: reading ? reading.projectedTokens : null,
          contextWindow: reading ? reading.contextWindow : null,
          compactionDrop: !!(session && session.state && session.state.compactionDrop),
        },
        { trend: cfg.crossSessionTrend ? store.trend() : undefined, lang: store.locale() },
      );
      var colors = COLORS[level] || COLORS.warn;
      var tr = store.t;

      var close = function (kind) {
        bannerSeen.set(key, { kind: kind, at: Date.now(), level: level, ratio: ratio });
        store.settleTurn(sessionId);
        bump(function (n) {
          return n + 1;
        });
      };

      var buttonStyle = {
        font: "inherit",
        padding: "3px 10px",
        borderRadius: "6px",
        cursor: "pointer",
        border: "1px solid var(--dsh-border, rgba(128,128,128,.4))",
        background: "transparent",
        color: "inherit",
      };

      return react.createElement(
        "div",
        {
          "data-dsh-context-guard": "banner",
          "data-level": level,
          style: {
            display: "flex",
            alignItems: "flex-start",
            gap: "10px",
            margin: "6px 10px",
            padding: "9px 12px",
            borderRadius: "10px",
            border: "1px solid " + colors.dot,
            background: "var(--dsh-surface-secondary, rgba(128,128,128,.07))",
            color: "var(--dsh-text-primary, inherit)",
            fontSize: "12px",
            lineHeight: 1.5,
          },
        },
        react.createElement(
          "div",
          { style: { flex: "1 1 auto", minWidth: 0 } },
          react.createElement(
            "div",
            { style: { fontWeight: 700, color: colors.fg, marginBottom: "2px" } },
            described.title,
          ),
          react.createElement("div", { style: { whiteSpace: "pre-wrap", opacity: 0.92 } }, described.body),
        ),
        react.createElement(
          "div",
          { style: { display: "flex", gap: "6px", flex: "0 0 auto" } },
          react.createElement(
            "button",
            {
              type: "button",
              onClick: function () {
                close("dismissed");
              },
              style: buttonStyle,
            },
            tr("banner.button.dismiss"),
          ),
          react.createElement(
            "button",
            {
              type: "button",
              title: tr("banner.button.hide.title"),
              onClick: function () {
                close("read");
              },
              style: {
                font: "inherit",
                padding: "3px 8px",
                borderRadius: "6px",
                cursor: "pointer",
                border: "none",
                background: "transparent",
                color: "var(--dsh-text-secondary, #6b7280)",
              },
            },
            "×",
          ),
        ),
      );
    }

    /**
     * 注册两个槽位。
     *
     * ⚠️ 槽位名照 `@deepseek-ai/dsh-client-ui-conversation` 的 `SlotMap` 声明取：
     *   - `conversation.session.header.utilities`（kind=list, scope=session，「右对齐的会话工具，升序」）
     *     ⇒ 拿得到标准席 `useProjection` / `sessionId`，正好做徽标；
     *   - `conversation.input.dock`（kind=list, scope=session，「composer 卡片上方的整宽条目」）
     *     ⇒ 同样拿得到 `useProjection`，正好放 banner。
     *   `shell.overlay` 虽是「一次性通知」的官方式席位，但它是 **root** scope ⇒ **没有 `useProjection`**，
     *   要用它就得自己搭一层跨半边 observable。本 MVP 不搭那层，改用会话内席位。
     *
     * `register({inject})` 是**返回业务面对象的工厂**，不是服务名数组 —— 本插件不需要注入面，
     * 所以整个 `inject` 键都不写。
     */
    function apply(ctx) {
      var disposers = [];
      var calls = [];

      /** 宽松传递：手写 JS bundle 里组件签名是宽类型，用恒等函数把它交给 `register` 的泛型位（照 damage-pulse 的 `registerErased` 做法）。 */
      function erased(component) {
        return component;
      }

      function register(slotName, order, id, component) {
        calls.push({ slot: slotName, id: id, at: Date.now() });
        var handle = ctx.slots.inject(slotName, function () {
          calls.push({ slot: slotName, id: id, mounted: true, at: Date.now() });
          return ctx.slots.register(
            { name: slotName, id: "context-guard:" + id, order: order },
            erased(component),
          );
        });
        disposers.push(handle);
      }

      ctx.effect(function () {
        register("conversation.session.header.utilities", 30, "badge", Badge);
        register("conversation.input.dock", 25, "banner", Banner);
        ctx.logger && ctx.logger.info && ctx.logger.info(store.t("client.log.registered"));
        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            try {
              if (typeof disposers[i] === "function") disposers[i]();
            } catch (error) {
              /* 卸载路径不抛 */
            }
          }
          disposers.length = 0;
        };
      }, "context-guard: slots");

      // 宿主真源：**先渲染、后到货**（不 await —— 槽位注册不能被一次网络读挡住）。
      var hostSyncPromise = syncFromHost();
      hostSyncPromise.then(function (result) {
        if (ctx.logger && ctx.logger.info) {
          ctx.logger.info(
            result.status === "ok"
              ? store.t("client.log.host.adopted", {
                  keys: hostSync.keys,
                  warn: store.config().warnRatio,
                  hard: store.config().hardRatio,
                })
              : store.t("client.log.host.failed", { status: result.status, error: hostSync.error || "" }),
          );
        }
      });

      // 排障/调档把手：验证脚本与操作者都能在 Console 里
      // 一眼看到「注册了几次、挂上几次、当前读数」，并实时改档位。
      // 只读快照 + 一个 override 入口，不参与任何隐式判定。
      try {
        if (typeof window !== "undefined") {
          var existing = window.__DSH_CONTEXT_GUARD__ || {};
          existing.plugin = "dsh-context-guard";
          existing.calls = calls;
          existing.store = store;
          existing.hasSlots = !!(ctx && ctx.slots);
          // ⚠️ 这两个只服务于**本机验收脚本**（在真机上就地试挂一个席位）。
          //    它们不提升任何权限 —— 这段代码本来就跑在 DSH Web 页面里，页面内任何脚本都已持有同等能力 ——
          //    但若你不需要那条验收链路，删掉下面两行即可（`tools/verify-client.mjs` 第 3c 项会随之失效）。
          existing.ctx = ctx;
          existing.react = react;
          existing.Badge = Badge;
          existing.Banner = Banner;
          // ⚠️ `config` 必须是**活的**：宿主设置是 `apply()` 之后才到货的，拍一张快照会骗人
          //    （第一版就是快照，于是「逃生阀 0.01 生效」与「宿主 0.33 生效」看起来一样，
          //     连验收脚本都被它骗过一轮）。用 getter，顺带让 Console 里看到的永远是当前档位。
          Object.defineProperty(existing, "config", {
            configurable: true,
            enumerable: true,
            get: function () {
              return store.config();
            },
          });
          existing.override = function (next) {
            return store.setConfig(next || {});
          };
          // 宿主真源的观测面：`hostSync()` 给当前状态，`hostConfig()` 给真源值，
          // `refreshFromHost()` 手动重读（设置改完之后不必刷新页面）。
          existing.hostSync = function () {
            return hostSync;
          };
          existing.hostConfig = function () {
            return store.hostConfig();
          };
          existing.syncFromHost = syncFromHost;
          existing.refreshFromHost = function () {
            return syncFromHost();
          };
          existing.hostSyncReady = hostSyncPromise;
          // 固定住这个全局：**可读、可调档，但不能被整体替换**（防止页面里别的脚本把把手换成假的）。
          // 逃生阀仍走 `override()`，或在加载前用 `addInitScript` 预置 —— 两条路都不受影响。
          Object.defineProperty(window, "__DSH_CONTEXT_GUARD__", {
            value: existing,
            writable: false,
            configurable: false,
            enumerable: true,
          });
        }
      } catch (error) {
        /* 排障把手失败不影响功能 */
      }

      return { store: store, Badge: Badge, Banner: Banner, config: store.config(), calls: calls };
    }
      //#endregion

      module.exports = { name: "context-guard", inject: ["slots"], apply: apply };
      return module.exports;
    } catch (error) {
      var detail = (error && error.stack) || String(error);
      // eslint-disable-next-line no-console
      console.error(
        "[dsh-context-guard] client bundle factory 抛异常 —— 这就是 boot 报的 import failure 的真身：\n" + detail,
      );
      throw error;
    }
  },
});
