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
        // v0.6.0（P3「说真话」）：正文按档位分开。
        // 硬档讲**平台事实**（约 80% 静默压缩、压掉的内容拿不回来），但**不许**说「读数永久消失」——
        // v0.5.0 的压缩账恰恰会抢存一行，那句话会变成新的假话。也不许出现「账本第 N 行」那种回执措辞。
        'banner.body.hard': (v) =>
          `本会话下一次请求将携带 ≈${v.projected} / ${v.window} 上下文（${v.percent}%）${v.compaction}。\n` +
          `平台会静默压缩${v.point}；压掉的内容拿不回来 —— 那一刻的读数，只有压缩账里记下了才留得下（没记就没有）。\n` +
          `建议本轮结束后：先把交接写进 \`${v.doc}\`，再开新会话。`,
        // v0.6.2：压缩点三态 —— exact 来自 DSH 解析后的配置，estimated 来自出厂常量
        'banner.body.hard.point.exact': (v) => `（自动压缩点 ${v.percent}%）`,
        'banner.body.hard.point.estimated': (v) => `（按 DSH 默认参数推算，自动压缩点约 ${v.percent}%）`,
        'banner.body.hard.off': (v) =>
          `本会话下一次请求将携带 ≈${v.projected} / ${v.window} 上下文（${v.percent}%）${v.compaction}。\n` +
          `这个会话的自动压缩是关掉的 —— 撞窗口后请求会直接溢出。\n` +
          `建议本轮结束后：先把交接写进 \`${v.doc}\`，再开新会话。`,
        // warn 档只讲「该收尾了」，不搬 80% 过来（否则 45% 就失去「还能继续干」的含义）
        'banner.body.warn': (v) =>
          `本会话下一次请求将携带 ≈${v.projected} / ${v.window} 上下文（${v.percent}%）${v.compaction}。\n` +
          `建议本轮结束后：先把交接写进 \`${v.doc}\`，再开新会话。`,
        'banner.compaction': () => '（压缩让水位掉下去过一次，现在又上来了）',
        // v0.4.7：压缩把水位压下阈值之后，banner **不自动消失** —— 降级成这条「已解除」的说明，
        // 因为上面那块可复制的交接文本正在被使用，不能因为一次压缩就跟着蒸发。
        // v0.5.0：措辞不再说「压缩救了一次」——它是止损，不是救援。
        'banner.title.compacted': (v) => `上下文已回落到 ${v.percent}%（那次压缩把读数吃掉了）`,
        'banner.body.compacted': () =>
          '这一档的提醒到此为止 —— 不必马上换会话。上面的交接文本仍然有效，需要的话直接复制。',
        // v0.5.0：压缩回执。数据来自压缩账最后一行（宿主侧账本），不是「banner 出声那一刻」的读数。
        'banner.receipt': (v) => `压缩前 ${v.pre}% · 账本第 ${v.n} 行 · 现在 ${v.post}%`,

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
        // v0.6.0：写时校验的三种沉默必须能分辨（「沉默 = 已核存在」vs「根本没核」）
        'handover.files.verified': (v) => ` · 已核 ${v.at}；无标记 = 本机存在`,
        'handover.files.notVerified': () => ' · 未核（校验未运行）',
        'handover.files.notVerifiedNoCwd': () => ' · 未核（无工作目录）',
        'handover.files.mark.missing': () => ' · ✗ 不存在',
        'handover.files.mark.cannot': (v) => ` · ？核不了（${v.reason}）`,
        'handover.files.reason.remote': () => '非本机路径',
        'handover.files.reason.no-cwd': () => '没有工作目录',
        'handover.files.reason.empty': () => '空路径',
        'handover.files.reason.link': () => '链接/挂载点',
        'handover.files.reason.outside': () => '在 cwd 之外',
        'handover.files.reason.not-file': () => '不是普通文件',
        'handover.files.reason.denied': () => '没有权限',
        'handover.files.reason.timeout': () => '超时',
        'handover.files.reason.error': () => '读取失败',
        'handover.files.none': () => '- （本次会话没有 `write` 类文件操作）',
        'handover.turns.heading': (v) => `**最近 ${v.n} 轮的诉求 / 回应摘要**`,
        'handover.turns.none': () => '- （宿主没有提供 `turnOutline`）',
        'handover.turn.line': (v) => `- **T${v.turn}** 诉求：\`${v.prompt}\` ｜ 回应：\`${v.response}\``,
        'handover.todo.heading': () => '**待补（由 agent 写）**',
        'handover.todo.conclusion': () => '- [ ] 结论：',
        'handover.todo.pitfalls': () => '- [ ] 踩过的坑 / 反直觉的地方：',
        'handover.todo.next': () => '- [ ] 未做完 / 下一步：',
        'handover.title.empty': () => '（无标题）',
        // v0.5.0：压缩账（全局一张表；取代 v0.4.1 的「每会话一块」快照）
        'ledger.title': () => '### 🗜️ 压缩账（自动追加，勿手改）',
        'ledger.header': () => '| # | 时间 | 会话 | 压缩前峰值 | 尺寸 | 累计花费 | 改过文件 | 事件 |',
        'ledger.row': (v) => `| ${v.i} | ${v.at} | ${v.session} | ${v.peak} | ${v.size} | ${v.cost} | ${v.files} | ${v.event} |`,
        'ledger.unknownPeak': () => '（峰值未知：daemon 重启后 ring 为空）',
        'log.ledger.written': (v) => `[context-guard] 压缩账已追加 ${v.name}（${v.status}）：${v.path}`,
        'log.ledger.failed': (v) => `[context-guard] 压缩账写入失败 ${v.name}：${v.path} · ${v.error}`,

        // ————————————————————————————————————————————————————————————————
        // client-source.js · 徽标 tooltip / banner 按钮 / 浏览器控制台
        // ————————————————————————————————————————————————————————————————
        'badge.title.context': (v) =>
          `本会话下一次请求将携带 ≈${v.projected} / ${v.window} 上下文（${v.percent}%）`,
        'badge.title.thresholds': (v) => `warn ${v.warn}% · hard ${v.hard}%`,
        'badge.title.host': (v) => `宿主判定：第 ${v.turn} 轮 · 冷却剩 ${v.cooldown} 轮`,
        'badge.title.source.label': () => '阈值来源：',
        // v0.6.2：压缩点三态 + 环境指纹（徽标 tooltip）
        'badge.title.compact.exact': (v) => `压缩点 ${v.percent}% · 来源：DSH 已解析配置`,
        'badge.title.compact.estimated': (v) => `压缩点 ≈${v.percent}% · 来源：默认参数（未读到 compaction 配置）`,
        'badge.title.compact.off': () => '压缩点：不适用（自动压缩已关）',
        'badge.title.compact.unknown': (v) => `压缩点未知（${v.reason}）`,
        'badge.title.compact.reason.noWindow': () => '本会话尚未发出请求',
        'badge.title.compact.reason.noRoute': () => '还没识别出模型路由',
        'badge.title.compact.reason.noReserve': () => '缺输出预留',
        'badge.title.env': (v) => `环境：${v.model}${v.preset === '' ? '' : ` · 预设 ${v.preset}`}`,
        'badge.title.source.host': () => '宿主设置',
        'badge.title.source.projection': () => '宿主判定投影（contextGuard）',
        'badge.title.source.absent': () => '未收到宿主判定投影（contextGuard）⇒ 不显示档位',
        'badge.title.source.builtin': (v) => `内置默认值（宿主设置读取${v.status}）`,
        'badge.action.hard': () => '该换会话了：先写交接，再开新会话。',
        'badge.action.warn': () => '该准备收尾了。',
        'badge.title.nodata': () => '暂无上下文压力数据（provider 未上报，或本会话尚未发出请求）',
        'banner.button.dismiss': () => '知道了',
        // 手动起草（banner 上的第二个选择）—— 与「知道了」并列，文案放一起
        'banner.button.draft': () => '写好交接，我复制',
        'banner.draft.tip': () => '只写机器事实（会话 / 水位 / 花费 / 改过的文件 / 最近几轮）；结论留给你或新会话的 agent。',
        // v0.4.0：两段可复制文本 + 待补状态（先补结论，再开新会话）
        'banner.draft.step1.title': () => '① 让本会话补结论（贴回当前会话）',
        'banner.draft.step1.text': (v) =>
          `请把这次会话的结论 / 踩过的坑 / 下一步，写进 ${v.doc} 的「待补」区；只补这三条，不要改写机器事实。`,
        'banner.draft.step2.title': () => '② 开新会话（复制这段）',
        'banner.draft.todo.empty': () => '待补：未补',
        'banner.draft.todo.filled': () => '待补：已补 ✅',
        'banner.draft.pending': () => '正在写入…',
        'banner.draft.done': (v) => `已写入 ${v.doc} —— 把下面这段复制到新会话`,
        'banner.draft.copy': () => '复制',
        'banner.draft.copied': () => '已复制',
        'banner.draft.failed': (v) => `没写成：${v.reason}`,
        'banner.draft.text': (v) => `@${v.doc} 接着这份交接继续。请先把「待补」补完再继续任务。`,
        'banner.draft.reason.disabled': () => '交接起草已在设置里关闭（handoverOnWarn）',
        'banner.draft.reason.busy': () => '上一次还在写，稍等再点',
        'banner.draft.reason.no-reading': () => '还没有水位数据',
        'banner.draft.reason.no-path': () => '该会话没有工作目录，或 handoverPath 为空',
        'banner.draft.reason.write-failed': () => '写入失败（详见宿主日志）',
        'banner.draft.reason.network': () => '连不上宿主（请求失败）',
        'banner.draft.reason.method-not-allowed': () => '路由方法不对',
        'banner.draft.reason.missing-sessionId': () => '缺少会话 id',
        'banner.draft.reason.exception': () => '意外错误（详见宿主日志）',
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
          `enabled=${v.enabled}`,
        'log.mounted': (v) =>
          `[${v.name}] 已挂载：warn=${v.warn} hard=${v.hard} 迟滞=${v.hysteresis} ` +
          `冷却=${v.cooldown}轮 onResume=${v.onResume} enabled=${v.enabled}`,
        // v0.6.2：压缩点来源（排障时先看这三条）
        'log.compactionConfig.config': (v) => `[${v.name}] 压缩点来源：DSH 已解析配置（精确）`,
        'log.compactionConfig.absent': (v) => `[${v.name}] 未发现 compaction 服务；压缩点按默认参数推算`,
        'log.compactionConfig.shape': (v) => `[${v.name}] compaction 服务存在但读不到可识别的配置；压缩点按默认参数推算`,
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
        'log.projections.seeded': (v) => `[${v.name}] 启动补判：按已知读数折叠了 ${v.count} 个会话的状态（历史会话不必等你先发言才提示）`,
        'log.projections.seedFailed': (v) => `[${v.name}] 启动补判失败（不影响后续事件判定）：${v.error}`,
        'log.projection.registered': (v) =>
          `[${v.name}] 已注册 wire 投影 ${v.key}（stateVersion ${v.version}）：浏览器半边直接读档位/冷却，不再自算`,
        'log.projection.noRegister': (v) =>
          `[${v.name}] 有 sessionProjections 服务但读不到 register()；浏览器半边拿不到宿主判定（退回自算）`,
        'log.projection.registerFailed': (v) =>
          `[${v.name}] 注册 wire 投影 ${v.key} 失败（已忽略，不影响判定与外推）：${v.error}`,
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
        // v0.6.0 (P3 "speak the truth"): split by level. The hard body states the platform fact
        // (~80% silent compaction; what it compresses away is gone) but must NOT claim "the reading
        // is lost forever" — the v0.5.0 ledger deliberately keeps a row — and must not use the
        // receipt phrasing ("ledger row N").
        'banner.body.hard': (v) =>
          `This session's next request will carry ≈${v.projected} / ${v.window} of context (${v.percent}%)${v.compaction}.\n` +
          `The platform silently compacts${v.point}; what it compresses away is gone, and that moment's reading survives only as a ledger row (if one was written).\n` +
          `After this turn: write the handoff into \`${v.doc}\` first, then open a new session.`,
        'banner.body.hard.point.exact': (v) => ` (auto-compaction point ${v.percent}%)`,
        'banner.body.hard.point.estimated': (v) => ` (about ${v.percent}% by DSH defaults)`,
        'banner.body.hard.off': (v) =>
          `This session's next request will carry ≈${v.projected} / ${v.window} of context (${v.percent}%)${v.compaction}.\n` +
          `Automatic compaction is off for this session — a request that overflows the window fails outright.\n` +
          `After this turn: write the handoff into \`${v.doc}\` first, then open a new session.`,
        'banner.body.warn': (v) =>
          `This session's next request will carry ≈${v.projected} / ${v.window} of context (${v.percent}%)${v.compaction}.\n` +
          `After this turn: write the handoff into \`${v.doc}\` first, then open a new session.`,
        'banner.compaction': () => ' (the number dropped once during compaction and is high again)',
        // v0.4.7: after compaction pushes the level below the threshold the banner must NOT vanish —
        // it degrades into this "no longer needed" notice, because the copyable handoff text above
        // is likely in use and must not disappear with a compaction.
        // v0.5.0: the wording no longer says "compaction helped" — it is damage control, not a rescue.
        'banner.title.compacted': (v) => `Context is back down to ${v.percent}% (that compaction ate the reading)`,
        'banner.body.compacted': () =>
          'This warning is done — no need to switch sessions right away. The handoff text above is still valid; copy it if you need it.',
        // v0.5.0: compaction receipt, read from the last row of the host-side ledger.
        'banner.receipt': (v) => `before compaction ${v.pre}% · ledger row ${v.n} · now ${v.post}%`,

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
        // v0.6.0: the three kinds of silence must be distinguishable
        'handover.files.verified': (v) => ` · checked ${v.at}; no mark = exists locally`,
        'handover.files.notVerified': () => ' · not checked (verifier did not run)',
        'handover.files.notVerifiedNoCwd': () => ' · not checked (no working directory)',
        'handover.files.mark.missing': () => ' · ✗ missing',
        'handover.files.mark.cannot': (v) => ` · ? unverifiable (${v.reason})`,
        'handover.files.reason.remote': () => 'not a local path',
        'handover.files.reason.no-cwd': () => 'no working directory',
        'handover.files.reason.empty': () => 'empty path',
        'handover.files.reason.link': () => 'link / mount point',
        'handover.files.reason.outside': () => 'outside the cwd',
        'handover.files.reason.not-file': () => 'not a regular file',
        'handover.files.reason.denied': () => 'permission denied',
        'handover.files.reason.timeout': () => 'timed out',
        'handover.files.reason.error': () => 'read failed',
        'handover.files.none': () => '- (no `write` file operations in this session)',
        'handover.turns.heading': (v) => `**Last ${v.n} turns — request / response summary**`,
        'handover.turns.none': () => '- (the host did not provide `turnOutline`)',
        'handover.turn.line': (v) => `- **T${v.turn}** request: \`${v.prompt}\` | response: \`${v.response}\``,
        'handover.todo.heading': () => '**To fill in (by the agent)**',
        'handover.todo.conclusion': () => '- [ ] Conclusions:',
        'handover.todo.pitfalls': () => '- [ ] Pitfalls / counter-intuitive findings:',
        'handover.todo.next': () => '- [ ] Unfinished work / next steps:',
        'handover.title.empty': () => '(untitled)',
        // v0.5.0: compaction ledger (one global table, replacing the per-session snapshot block)
        'ledger.title': () => '### 🗜️ Compaction ledger (appended automatically, do not edit)',
        'ledger.header': () => '| # | time | session | peak before | size | total spend | files | event |',
        'ledger.row': (v) => `| ${v.i} | ${v.at} | ${v.session} | ${v.peak} | ${v.size} | ${v.cost} | ${v.files} | ${v.event} |`,
        'ledger.unknownPeak': () => '(peak unknown: ring empty after a daemon restart)',
        'log.ledger.written': (v) => `[context-guard] ledger row appended to ${v.name} (${v.status}): ${v.path}`,
        'log.ledger.failed': (v) => `[context-guard] ledger row write failed ${v.name}: ${v.path} · ${v.error}`,

        // ————————————————————————————————————————————————————————————————
        // client-source.js · badge tooltip / banner buttons / browser console
        // ————————————————————————————————————————————————————————————————
        'badge.title.context': (v) =>
          `This session's next request will carry ≈${v.projected} / ${v.window} of context (${v.percent}%)`,
        'badge.title.thresholds': (v) => `warn ${v.warn}% · hard ${v.hard}%`,
        'badge.title.host': (v) => `host decision: turn ${v.turn} · cooldown ${v.cooldown} left`,
        'badge.title.source.label': () => 'Threshold source: ',
        'badge.title.compact.exact': (v) => `compaction point ${v.percent}% · source: DSH resolved config`,
        'badge.title.compact.estimated': (v) => `compaction point ≈${v.percent}% · source: defaults (no compaction config seen)`,
        'badge.title.compact.off': () => 'compaction point: n/a (automatic compaction is off)',
        'badge.title.compact.unknown': (v) => `compaction point unknown (${v.reason})`,
        'badge.title.compact.reason.noWindow': () => 'no request sent in this session yet',
        'badge.title.compact.reason.noRoute': () => 'model route not identified yet',
        'badge.title.compact.reason.noReserve': () => 'output reserve unknown',
        'badge.title.env': (v) => `environment: ${v.model}${v.preset === '' ? '' : ` · preset ${v.preset}`}`,
        'badge.title.source.host': () => 'host settings',
        'badge.title.source.projection': () => 'host decision projection (contextGuard)',
        'badge.title.source.absent': () => 'no host decision projection (contextGuard) ⇒ no level shown',
        'badge.title.source.builtin': (v) => `built-in defaults (host settings read ${v.status})`,
        'badge.action.hard': () => 'Time for a new session: write the handoff first, then start one.',
        'badge.action.warn': () => 'Time to start wrapping up.',
        'badge.title.nodata': () =>
          'No context-pressure data yet (provider has not reported, or this session has not sent a request)',
        'banner.button.dismiss': () => 'Got it',
        'banner.button.draft': () => 'Write the handoff, I will copy it',
        'banner.draft.tip': () =>
          'Writes machine facts only (session, occupancy, spend, changed files, recent turns); conclusions are left to you or the next session.',
        'banner.draft.step1.title': () => '1) Fill in the conclusions here (paste back into this session)',
        'banner.draft.step1.text': (v) =>
          `Write this session's conclusions / pitfalls / next steps into the "to fill in" area of ${v.doc}. Only those three; do not rewrite the machine facts.`,
        'banner.draft.step2.title': () => '2) Start the new session (copy this)',
        'banner.draft.todo.empty': () => 'to fill in: empty',
        'banner.draft.todo.filled': () => 'to fill in: filled',

        'banner.draft.pending': () => 'Writing…',
        'banner.draft.done': (v) => `Written to ${v.doc} — copy the line below into your new session`,
        'banner.draft.copy': () => 'Copy',
        'banner.draft.copied': () => 'Copied',
        'banner.draft.failed': (v) => `Could not write it: ${v.reason}`,
        'banner.draft.text': (v) =>
          `@${v.doc} Continue from this handoff. Fill in the "to fill in" slots first, then carry on with the task.`,
        'banner.draft.reason.disabled': () => 'handoff drafting is off in settings (handoverOnWarn)',
        'banner.draft.reason.busy': () => 'the previous one is still being written — try again in a moment',
        'banner.draft.reason.no-reading': () => 'no occupancy data yet',
        'banner.draft.reason.no-path': () => 'this session has no working directory, or handoverPath is empty',
        'banner.draft.reason.write-failed': () => 'the write failed (see host logs)',
        'banner.draft.reason.network': () => 'could not reach the host (request failed)',
        'banner.draft.reason.method-not-allowed': () => 'wrong route method',
        'banner.draft.reason.missing-sessionId': () => 'missing session id',
        'banner.draft.reason.exception': () => 'unexpected error (see host logs)',
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
          `enabled=${v.enabled}`,
        'log.mounted': (v) =>
          `[${v.name}] mounted: warn=${v.warn} hard=${v.hard} hysteresis=${v.hysteresis} ` +
          `cooldown=${v.cooldown} turns onResume=${v.onResume} enabled=${v.enabled}`,
        'log.compactionConfig.config': (v) => `[${v.name}] compaction point source: DSH resolved config (exact)`,
        'log.compactionConfig.absent': (v) => `[${v.name}] no compaction service; the compaction point falls back to defaults`,
        'log.compactionConfig.shape': (v) => `[${v.name}] compaction service present but its config is unrecognized; the compaction point falls back to defaults`,
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
        'log.projections.seeded': (v) =>
          `[${v.name}] startup seed: folded the known reading into ${v.count} session(s) so historical sessions warn before you speak`,
        'log.projections.seedFailed': (v) => `[${v.name}] startup seed failed (later events still decide): ${v.error}`,
        'log.projection.registered': (v) =>
          `[${v.name}] registered wire projection ${v.key} (stateVersion ${v.version}): the browser half reads level/cooldown straight from it`,
        'log.projection.noRegister': (v) =>
          `[${v.name}] sessionProjections service present but register() unreadable; the browser half cannot see host decisions (falls back to computing them)`,
        'log.projection.registerFailed': (v) =>
          `[${v.name}] registering wire projection ${v.key} failed (ignored; decisions and push are unaffected): ${v.error}`,
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
     * 手动「写好交接」的触发路由（banner 按钮 → `POST DRAFT_ROUTE?sessionId=…`）。
     *
     * 与 `STATE_ROUTE` 一样住在共享策略里：它是两半边之间的契约，写两份迟早漂移。
     * 语义上它是**一次性的强制起草** —— 跳过「水位涨够才刷」的步进闸门，但仍然
     * 尊重 `handoverOnWarn`、尊重 pending 锁、只写机器事实（零 LLM）。
     */
    const DRAFT_ROUTE = '/api/context-guard/draft';

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
        // —— v0.5.0：`crossSessionTrend` / `trendWindowHours` / `trendEscalateAt` **保留为 no-op**。
        //    行为（TrendTracker、banner 正文、/state.trend）已删除；键不删是因为旧 profile 的
        //    cordis.patch.yml 里可能还写着它们，而 schema 不认键会让插件 init 失败 ⇒ 整机起不来。
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
        // —— v0.5.0：`pushChannel` / `pushMinLevel` / `pushCooldownMinutes` **保留为 no-op**（同上）。
        //    外推推送行为与 i18n 已删除；键保留只为兼容旧配置。
        pushChannel: 'none',
        pushMinLevel: 'hard',
        pushCooldownMinutes: 10,
        ...overrides,
      };
    }

    /*
     * —— 判定状态机已迁走（v0.4.3，复审报告 §2 建议 #6）——
     *
     * `initialState` / `reduce` / `nextTurn` / `inCooldown` / `signalOf` 现在住在 `lib/engine.mjs`。
     * 理由：本文件是**两半边共用**、会被逐字内联进浏览器 bundle 的那份代码；状态机住在里面，
     * 客户端就永远「有一套可用的判定逻辑」，P1-5 那类漂移迟早会回来。搬走之后「客户端没有判定逻辑」
     * 是结构性事实，而不是自觉。
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
     * v0.5.0：`shouldPush` / `pushText` / `TrendTracker` **已删除**。
     *   外推推送：136 个 IM 插件在做同一件事，且它是本插件唯一需要 network/外部服务的组件；
     *   跨会话趋势：只有宿主侧一句正文 + `/state.trend`，且**重启即清零的内存统计**（不是账本）。
     *   两者对应的 i18n 键一并删除；配置键保留为 no-op（见 `defaultConfig` 注释），删键会让旧配置起不来。
     */

    /**
     * 提示文案。§10.6：占比数字 + 下一步动作 + 指向交接文档。
     * @param {object} signal
     * @param {object} [opts] { handoffDoc?: string, lang?: 'zh'|'en' }
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
      const compactionLine = signal.compactionDrop === true ? t('banner.compaction') : '';
      /**
       * v0.6.2：自动压缩点的**三态**。
       *   · `config` —— 读到 DSH 解析后的配置：给数字，且**不许**出现「约/推算」；
       *   · `default` —— 只有出厂常量：给数字，但必须同屏带 `≈` + 来源原因；
       *   · `off` —— 自动压缩被关掉：不给数字，改说「不会自动压缩」；
       *   · `none` —— 算不出来（缺窗口/缺预留）：整句省略，不编数字。
       */
      const compactPercent = Number.isFinite(opts.compactPercent) ? opts.compactPercent : null;
      const basis = opts.compactBasis === 'config' || opts.compactBasis === 'default' || opts.compactBasis === 'off' ? opts.compactBasis : 'none';
      const point =
        compactPercent === null || basis === 'off'
          ? ''
          : t(basis === 'config' ? 'banner.body.hard.point.exact' : 'banner.body.hard.point.estimated', {
              percent: compactPercent.toFixed(1),
            });
      const bodyKey =
        basis === 'off' ? 'banner.body.hard.off' : signal.level === 'hard' ? 'banner.body.hard' : 'banner.body.warn';

      return {
        level: signal.level,
        ratioPercent: percent,
        lang,
        title: t(signal.level === 'hard' ? 'banner.title.hard' : 'banner.title.warn', { percent }),
        body: t(bodyKey, {
          projected: kTokens(projected),
          window: kTokens(window_),
          percent,
          compaction: compactionLine,
          doc,
          point,
        }),
      };
    }

    /** 徽标只显示数字，不显示措辞；无数据时给一句显式的话（不要假装是 0%）。 */
    function badgeText(reading) {
      if (!reading || reading.known !== true || reading.ratio === null) return { text: 'ctx —', known: false };
      return { text: `ctx ${Math.round(reading.ratio * 100)}%`, known: true };
    }

    /**
     * **显示档位**（v0.4.6，真机故障 §37.4）：把「宿主档位」与「官方占用率」合成一个**只读**的显示值。
     *
     * 为什么需要：宿主镜像的档位只在**事件驱动**时前进（`projection.drive`）。打开一个恢复出来的
     * 历史会话**不产生新事件** —— `hydrate` 只算一遍快照、不通知监听者 —— 所以页面加载那一刻
     * 宿主可能还是 `none`，而官方 `contextPressure` 已经是 67%：徽标有数字、banner 不弹，
     * 要等用户先发一条消息才补上。这是「启动那一刻的基线」问题（§37.5），不是判定问题。
     *
     * 边界（**这不是第二套状态机**）：
     *   · 宿主给了 `warn` / `hard` ⇒ 一律听宿主的，本函数什么都不改；
     *   · 阈值由**宿主投影**随 `warnRatio`/`hardRatio` 下发；缺席时才用 `defaultConfig()` 的出厂值；
     *   · 迟滞、冷却、武装、轮次、日志、外推**一个都不在这里** —— 客户端拿不到也写不了判定状态；
     *   · 宿主显式 `enabled: false` ⇒ 直接 `none`（总开关仍然只在宿主）。
     */
    function displayLevel(view, reading, defaults = undefined) {
      const host = view && LEVELS.includes(view.level) ? view.level : 'none';
      if (host !== 'none') return host;
      if (view && view.enabled === false) return 'none';
      if (!reading || reading.known !== true || !Number.isFinite(reading.ratio)) return host;
      const base = defaults ?? defaultConfig();
      const hard = view && Number.isFinite(view.hardRatio) ? view.hardRatio : base.hardRatio;
      const warn = view && Number.isFinite(view.warnRatio) ? view.warnRatio : base.warnRatio;
      if (Number.isFinite(hard) && reading.ratio >= hard) return 'hard';
      if (Number.isFinite(warn) && reading.ratio >= warn) return 'warn';
      return host;
    }

    /**
     * **banner 显示档位**（v0.6.3，产品决定：45% 只静默起草，提醒只在 60%）。
     *
     * 为什么撤掉 warn 那条 banner：它没有事实依据（平台事实是「压缩点」，不是「45% 会出事」），
     * 而且 `bannerSeen` 只在点「知道了」时消解 ⇒ 它会在 45→60 的 15pp 里常驻，
     * 训练出「见 banner 就关」的反射，反而稀释 60% 那条的信噪比。
     * 45% 的**起草**保留（`maybeDraftHandover` 仍按 `warnRatio` 触发），只是不再出声。
     *
     * 语义不变：一旦出过声（hard），水位回落后仍沿用 hard，直到用户点「知道了 / ×」。
     * 纯函数：不读不写任何判定状态。
     */
    function shownBannerLevel(level, firedLevel) {
      if (level === 'hard') return 'hard';
      return firedLevel === 'hard' ? 'hard' : 'none';
    }
      //#endregion

      //#region UI
    /**
     * dsh-context-guard · client 半边 UI（被 `scripts/build-client.mjs` 内联进 client.js）
     *
     * 这一半只做两件事（§10.2 第 4 条「宿主算数、UI 说话」的 UI 侧）：
     *   1. 会话头徽标：占用率 + 宿主判定的档位，**只显示、不出声**；
     *   2. 跨越档位时一次性 banner：占比 + 下一步动作 + 指向 `HANDOVER.md`（§10.6）。
     *
     * ⛔ 不注入 prompt、不注册 model-facing 工具、不发额外请求 ⇒ 上下文税 0。
     *
     * ⛔⛔ **本半边没有判定逻辑**（v0.4.3，复审报告 §2 建议 #1）：
     *   档位 / 武装 / 轮次 / 冷却 / 占用率一律来自宿主注册的 `wire` 投影
     *   （`useProjection("contextGuard")`，见 `lib/index.js` 与 `lib/engine.mjs`）。
     *   历史形状是「客户端自带一套状态机 + 一次 `fetch(/api/context-guard/state)` 抄宿主阈值」，
     *   于是有两套冷却、两套迟滞，`settleTurn` 还挂在 banner 按钮上（点一下就能在客户端推进轮次）。
     *   现在判定状态机**已搬出 `policy.mjs`**（它只住在 `lib/engine.mjs`，不进这个 bundle），
     *   所以「客户端没有判定逻辑」是结构性事实，而不是靠自觉。
     *
     * 语言：`pickLocale(逃生阀 locale, navigator.language)`，兜底 `zh`。
     * 文案仍来自 `lib/i18n.mjs`（与宿主同一份、逐字内联），措辞与判定分离 —— 这就是内联的
     * **必要最小集合**：文案表 + `readOccupancy`（把 contextPressure 归一成读数）+ `describe`。
     */
    var guardLocale = pickLocale(
      (typeof window !== "undefined" && window.__DSH_CONTEXT_GUARD__ && window.__DSH_CONTEXT_GUARD__.config
        ? window.__DSH_CONTEXT_GUARD__.config.locale
        : undefined) ?? "auto",
      { navigatorLanguage: typeof navigator !== "undefined" ? navigator.language : undefined },
    );

    /** 查表函数：组件渲染统一走它，避免半句中文半句英文。 */
    var guardT = makeT(guardLocale);

    /**
     * 排障面（**只读**）：每个会话最近一次读到的宿主投影。给 `__DSH_CONTEXT_GUARD__.store.dump()`
     * 与验收脚本看 —— 它记录的是**宿主说了什么**，不是客户端算了什么（客户端不再算）。
     */
    var lastViews = {};

    /**
     * 保留这个名字（而不是干脆删掉）是为了让验收脚本的 `store.dump()/locale()/config()` 还能读出
     * 「浏览器现在看到什么」。⚠️ 它**没有** `setConfig` / `hostConfig` / `settleTurn` 了：
     * 客户端不再拥有任何判定状态，也就没有能改判定的入口（这正是要消灭的那类漂移）。
     */
    var store = {
      locale: function () {
        return guardLocale;
      },
      t: function (key, vars) {
        return guardT(key, vars);
      },
      config: function () {
        return { source: "projection", locale: guardLocale };
      },
      dump: function () {
        return lastViews;
      },
    };

    /** 记一条排障记录（引用相同就跳过，避免每次渲染都写）。 */
    function noteView(sessionId, view) {
      if (sessionId === null || !view) return;
      if (lastViews[sessionId] === view) return;
      lastViews[sessionId] = {
        level: view.level,
        armed: view.armed === true,
        turn: view.turn,
        cooldown: view.cooldown,
        ratio: view.ratio === undefined ? null : view.ratio,
      };
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

    /**
     * 宿主判定（v0.4.3）：`useProjection("contextGuard")` —— 档位/武装/轮次/冷却/占用率的**唯一真源**。
     *
     * 为什么不再自算：复审报告 §2 #1。客户端那套状态机与宿主那套只靠「一次 fetch 抄一份阈值」
     * 对齐，于是两套冷却、两套迟滞，`settleTurn` 还挂在按钮上（点一下就能在客户端推进轮次）。
     * 现在宿主把判定注册成 `wire` 投影（`lib/index.js` 的 `sessionProjections.register`），
     * 这里只是**读**：`{ level, armed, turn, cooldown, ratio }`，小、扁平、纯 JSON。
     *
     * `undefined` ⇒ 通道缺席（旧宿主 / 未装 token-meter / 注册失败）。此时**没有档位**：
     * 徽标仍然显示 `contextPressure` 的占用率，但不出 banner。
     * ⚠️ 这里刻意**不**退回本地判定 —— 「缺席就自己算一份」正是 P1-5 那类漂移的出生地；
     * 宁可不提示，也不要两套判定各说各话（一句提示的档位不值得为此重新引入第二套状态机）。
     */
    function guardView(props) {
      var view = safeProjection(props, "contextGuard");
      return view && typeof view === "object" ? view : null;
    }

    function sessionIdOf(props) {
      var id = props && (props.sessionId !== undefined ? props.sessionId : props.session && props.session.id);
      return id === undefined || id === null || id === "" ? null : String(id);
    }

    /**
     * v0.6.10：用**客户端自己那份实时读数**重算压缩点。
     *
     * 为什么：宿主缓存的窗口可能落后（真机：宿主 1,048,576 / 客户端 1,000,000，压缩点偏 ~1.5pp）。
     * 参数（ratio / headroom / 预留）仍由宿主下发 —— 客户端只做一次纯算术，不做任何判定。
     * 任何一项缺失就返回 null，调用方回落到宿主算好的 `compactPercent`。
     */
    function liveCompactPercent(reading, view) {
      if (!reading || reading.known !== true) return null;
      if (!view) return null;
      var r = view.compactRatio;
      var headroom = view.compactHeadroom;
      var reserve = view.compactReserve;
      var w = reading.contextWindow;
      if (typeof r !== "number" || typeof headroom !== "number" || typeof reserve !== "number") return null;
      if (typeof w !== "number" || !isFinite(w) || w <= 0) return null;
      var threshold = Math.floor(Math.min(w * r, w - reserve - headroom));
      if (!isFinite(threshold) || threshold <= 0) return null;
      return Math.round((threshold / w) * 1000) / 10;
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
      var view = guardView(props);
      noteView(sessionId, view);

      // `readOccupancy` 只是把官方投影归一成「可信/不可信 + 比率」（纯函数，不碰状态机），
      // 用它显示 `≈120K / 200K` 这种人类可读的分母/分子。
      var reading = readOccupancy(pressure);
      var badge = badgeText(reading);
      // 显示档位：宿主给了就听宿主的；宿主还停在 `none` 而官方读数已过线时兜底
      // （v0.4.6：「恢复的会话在页面加载那一刻没有事件驱动」的显示侧修正，见 `displayLevel`）。
      var level = displayLevel(view, reading);
      var colors = COLORS[level] || COLORS.none;
      // 百分比优先用宿主的 ratio：否则会出现「档位说 hard、徽标说 44%」这种自相矛盾。
      var ratioValue = view && typeof view.ratio === "number" ? view.ratio : reading.known ? reading.ratio : null;
      var ratio = ratioValue === null ? 0 : Math.max(0, Math.min(1, ratioValue));
      var hasData = badge.known || ratioValue !== null;
      var percent = Math.round((ratioValue === null ? 0 : ratioValue) * 100);
      // 宿主投影有 ratio、而 contextPressure 那一半还没到货时，仍然要显示真数字（绝不假装 0%）。
      if (!badge.known && ratioValue !== null) badge = { text: "ctx " + percent + "%", known: true };

      var tr = store.t;
      // v0.6.2：压缩点三态 + 环境指纹（只进 tooltip；徽标正面只表示「当前占用」）
      // v0.6.10：优先用**实时读数**重算（宿主缓存的窗口可能落后），缺参数才回落宿主值。
      var livePercent = liveCompactPercent(reading, view);
      var compactPercent = livePercent !== null ? livePercent : view && typeof view.compactPercent === "number" ? view.compactPercent : null;
      var compactLine = "";
      var envLine = "";
      if (view) {
        if (view.compactBasis === "config" && typeof compactPercent === "number") {
          compactLine = tr("badge.title.compact.exact", { percent: compactPercent.toFixed(1) });
        } else if (view.compactBasis === "default" && typeof compactPercent === "number") {
          compactLine = tr("badge.title.compact.estimated", { percent: compactPercent.toFixed(1) });
        } else if (view.compactBasis === "off") {
          compactLine = tr("badge.title.compact.off");
        } else {
          var why = !reading.known
            ? "noWindow"
            : view.modelTag === null || view.modelTag === undefined
              ? "noRoute"
              : "noReserve";
          compactLine = tr("badge.title.compact.unknown", { reason: tr("badge.title.compact.reason." + why) });
        }
        if (typeof view.modelTag === "string") {
          envLine = tr("badge.title.env", { model: view.modelTag, preset: typeof view.presetTag === "string" ? view.presetTag : "" });
        }
      }
      var title;
      if (hasData) {
        title =
          tr("badge.title.context", {
            projected: kTokens(reading.projectedTokens),
            window: kTokens(reading.contextWindow),
            percent: percent,
          }) +
          (view ? "\n" + tr("badge.title.host", { turn: view.turn, cooldown: view.cooldown }) : "") +
          (compactLine === "" ? "" : "\n" + compactLine) +
          (envLine === "" ? "" : "\n" + envLine) +
          "\n" +
          tr("badge.title.source.label") +
          (view ? tr("badge.title.source.projection") : tr("badge.title.source.absent")) +
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

    /**
     * 本会话**已经出过声的档位**（v0.4.7，真机反馈：压缩把水位压到 20% 之后 banner 整个消失，
     * 而上面那块「①/② 可复制交接」正在被用 —— 一次压缩把用户正在用的面板带走了）。
     *
     * 规矩：出过声就**留着**，只有「知道了 / ×」才关；档位掉回 `none` 时不消失，降级成
     * 「已回落到 X%（压缩救了一次）」那条说明（见 `renderBanner` 的 `compacted` 分支）。
     * 这里只记「显示过」，不参与任何判定 —— 档位仍然只由宿主投影/官方读数给。
     * @type {Map<string, {level: string, ratio: number}>}
     */
    var bannerFired = new Map();
    var BANNER_FIRED_MAX = 200;

    /**
     * 手动「写好交接」的两块支撑：复制到剪贴板、把宿主返回的 reason 翻成人话。
     *
     * 复制优先 Clipboard API、失败退 `execCommand`：Web GUI 是 `http://127.0.0.1`（安全上下文），
     * 正常路径可用；但别只押一条 —— 某些内嵌环境会禁掉 `navigator.clipboard`。
     */
    function fallbackCopy(text) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "readonly");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok === true;
      } catch (error) {
        return false;
      }
    }

    function copyText(text) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          return navigator.clipboard.writeText(text).then(
            function () {
              return true;
            },
            function () {
              return fallbackCopy(text);
            },
          );
        }
      } catch (error) {
        /* 落到兜底 */
      }
      return Promise.resolve(fallbackCopy(text));
    }

    /** reason 是机器词（disabled / no-path / …）；未知词兜到 exception，绝不把 key 甩给用户看。 */
    function draftReason(t, reason) {
      var key = "banner.draft.reason." + (reason || "exception");
      var text = t(key);
      return text === key ? t("banner.draft.reason.exception") : text;
    }

    function Banner(props) {
      var sessionId = sessionIdOf(props);
      var pressure = safeProjection(props, "contextPressure");
      var view = guardView(props);
      noteView(sessionId, view);

      var bumpPair = react.useState(0);
      var bump = bumpPair[1];
      // 手动起草的状态机：idle → pending → done（可复制）/ error。
      // ⚠️ 必须在下面那个 `if (!visible) return null` **之前**调用 —— 否则 hook 顺序会随可见性变化。
      var draftPair = react.useState({ status: "idle", doc: "", message: "" });
      var draft = draftPair[0];
      var setDraft = draftPair[1];
      var copiedPair = react.useState("");
      var copied = copiedPair[0];
      var setCopied = copiedPair[1];
      // 档位与冷却一律来自宿主投影（客户端没有第二套判定，见 `guardView`）。
      // v0.4.6：宿主还停在 `none`、而官方 `contextPressure` 已过线时，按**宿主下发的阈值**兜底显示
      // —— 恢复出来的历史会话在页面加载那一刻没有事件驱动，这是「启动基线」缺口（§37.4/§37.5）。
      var reading = readOccupancy(pressure);
      var level = displayLevel(view, reading);
      var ratio = view && typeof view.ratio === "number" ? view.ratio : reading.known ? reading.ratio : 0;
      /**
       * v0.4.7：**出过声就不消失**。压缩会把水位压下阈值（`displayLevel` 回 `none`），
       * 而 banner 里正摆着「①/② 可复制交接」—— 面板不能因为一次压缩就跟着蒸发。
       * 所以显示档位取「当前档位，掉回 none 时沿用出过声的那一档」，并把它记进 `bannerFired`。
       */
      var fired = sessionId !== null ? bannerFired.get(sessionId) : undefined;
      // v0.6.3：只有 hard 会出声；45% 的 warn 只静默起草（见 lib/policy.mjs 的 shownBannerLevel）。
      var shownLevel = shownBannerLevel(level, fired ? fired.level : "none");
      var compacted = level === "none" && fired !== undefined;
      if (sessionId !== null && level === "hard" && (fired === undefined || fired.level !== "hard")) {
        if (bannerFired.size > BANNER_FIRED_MAX) bannerFired.clear();
        bannerFired.set(sessionId, { level: level, ratio: ratio });
      }
      var key = sessionId !== null ? sessionId + "|" + shownLevel : null;
      var seen = key !== null ? bannerSeen.get(key) : undefined;
      /**
       * 只在「本会话这一档位还没出过声」时才显示。
       * ⚠️ 不再有 `cfg.enabled` 这一项：总开关由**宿主**执行（关掉后宿主压根不会武装、不会给档位），
       * 客户端再判一次就是第二套语义。客户端只剩「同一档位只响一次」这条**纯 UI** 记忆。
       */
      var visible = shownLevel !== "none" && key !== null && seen === undefined;

      if (!visible) return null;

      try {
        return renderBanner(props, {
          sessionId: sessionId,
          level: shownLevel,
          compacted: compacted,
          // v0.5.0（P1）：压缩回执只在「宿主真的写了账本行」时才有值（三个 null 表示没有）。
          receipt:
            view && typeof view.receiptPercent === "number" && typeof view.receiptRow === "number"
              ? { percent: view.receiptPercent, row: view.receiptRow }
              : null,
          // v0.6.1：宿主按 DSH 公式推算的「自动压缩点」（百分比）；未知就是 null。
          // v0.6.10：先用客户端实时读数重算（宿主缓存的窗口可能落后），缺参数才回落到宿主值。
          compactPercent:
            liveCompactPercent(reading, view) !== null
              ? liveCompactPercent(reading, view)
              : view && typeof view.compactPercent === "number"
                ? view.compactPercent
                : null,
          // v0.6.2：这个数字凭什么 —— config（精确）/ default（推算）/ off（不压）/ none（算不出）
          compactBasis: view && typeof view.compactBasis === "string" ? view.compactBasis : "none",
          reading: reading,
          ratio: ratio,
          key: key,
          bump: bump,
          draft: draft,
          setDraft: setDraft,
          copied: copied,
          setCopied: setCopied,
        });
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
      var level = ctxBag.level;
      var reading = ctxBag.reading;
      var ratio = ctxBag.ratio;
      var key = ctxBag.key;
      var bump = ctxBag.bump;
      var draftView = ctxBag.draft || { status: "idle", doc: "", message: "" };
      var setDraft = ctxBag.setDraft;
      var copied = ctxBag.copied === true;
      var setCopied = ctxBag.setCopied;

      var tr = store.t;
      var described = ctxBag.compacted === true
        ? {
            title: tr("banner.title.compacted", { percent: Math.round(ratio * 100) }),
            body: tr("banner.body.compacted", {}),
          }
        : guardDescribe(
            {
              kind: "enter",
              level: level,
              ratio: ratio,
              projectedTokens: reading ? reading.projectedTokens : null,
              contextWindow: reading ? reading.contextWindow : null,
              // `compactionDrop` 与跨会话趋势都是**宿主**的面（不进 wire 载荷，见 lib/engine.mjs 的
              // 镜像注释）：正文里那两句解释性话现在只出现在宿主日志里。
              compactionDrop: false,
              // v0.6.1：自动压缩点（宿主按 DSH 公式推算；未知则不写数字）
              compactPercent: typeof ctxBag.compactPercent === "number" ? ctxBag.compactPercent : undefined,
              // v0.6.2：config ⇒ 精确措辞；default ⇒ 带「约/推算」；off ⇒ 换整段正文；none ⇒ 不写数字
              compactBasis: ctxBag.compactBasis,
            },
            { lang: store.locale() },
          );
      var colors = ctxBag.compacted === true ? COLORS.none : COLORS[level] || COLORS.warn;
      var receipt = ctxBag.receipt || null;

      var close = function (kind) {
        /**
         * ⚠️ v0.4.3：这里原来还有一句 `store.settleTurn(sessionId)` —— 那是「点按钮就在客户端推进一轮、
         * 衰减一次冷却」的入口（P1-5 的一半：UI 动作能改变判定状态）。现在轮次与冷却**只**由宿主的
         * `turn/end` 推进，客户端关掉 banner 就只是关掉它。
         */
        bannerSeen.set(key, { kind: kind, at: Date.now(), level: level, ratio: ratio });
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

      // —— 手动起草（第二个选择）：点下去让宿主**立刻**写一次，然后把可复制的开场文本摆出来。
      //    与「知道了」的分工：后者纯关闭、无附带动作；前者产生一个文件 + 一段文本。
      var draftText = tr("banner.draft.text", { doc: draftView.doc || "HANDOVER.md" });
      var draftBusy = draftView.status === "pending";

      var startDraft = function () {
        if (draftBusy || typeof setDraft !== "function") return;
        setDraft({ status: "pending", doc: "", message: "" });
        var url = DRAFT_ROUTE + "?sessionId=" + encodeURIComponent(String(sessionId));
        fetch(url, {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        })
          .then(function (res) {
            return res.json();
          })
          .then(function (data) {
            if (data && data.ok === true && data.doc) {
              setDraft({ status: "done", doc: String(data.doc), message: "", todoFilled: data.todoFilled === true });
            } else {
              setDraft({ status: "error", doc: "", message: draftReason(tr, data && data.reason) });
            }
          })
          .catch(function () {
            setDraft({ status: "error", doc: "", message: draftReason(tr, "network") });
          });
      };

      // v0.4.0：两段可复制文本 —— ① 贴**回本会话**让旧 agent 写结论（它有完整上下文）
      //         ② 贴到**新会话**开场。顺序固定：先补结论，再开新会话，保真最好。
      var step1Text = tr("banner.draft.step1.text", { doc: draftView.doc || "HANDOVER.md" });

      var doCopy = function (text, tag) {
        if (typeof setCopied !== "function") return;
        copyText(text).then(function (ok) {
          setCopied(ok === true ? tag : "");
        });
      };

      var codeStyle = {
        display: "block",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        background: "rgba(128,128,128,.12)",
        padding: "4px 6px",
        borderRadius: "5px",
        marginTop: "2px",
      };
      var stepTitleStyle = { opacity: 0.85, marginTop: "6px" };
      var smallButtonStyle = Object.assign({}, buttonStyle, { marginTop: "3px" });

      var draftPanel =
        draftView.status === "done"
          ? react.createElement(
              "div",
              {
                "data-dsh-context-guard": "draft",
                style: { marginTop: "6px", paddingTop: "6px", borderTop: "1px dashed " + colors.dot },
              },
              react.createElement(
                "div",
                { style: { opacity: 0.85, marginBottom: "2px" } },
                tr("banner.draft.done", { doc: draftView.doc }) +
                  " · " +
                  (draftView.todoFilled === true ? tr("banner.draft.todo.filled") : tr("banner.draft.todo.empty")),
              ),
              react.createElement("div", { style: stepTitleStyle }, tr("banner.draft.step1.title")),
              react.createElement("code", { style: codeStyle }, step1Text),
              react.createElement(
                "button",
                { type: "button", onClick: function () { doCopy(step1Text, "1"); }, style: smallButtonStyle },
                copied === "1" ? tr("banner.draft.copied") : tr("banner.draft.copy"),
              ),
              react.createElement("div", { style: stepTitleStyle }, tr("banner.draft.step2.title")),
              react.createElement("code", { style: codeStyle }, draftText),
              react.createElement(
                "button",
                { type: "button", onClick: function () { doCopy(draftText, "2"); }, style: smallButtonStyle },
                copied === "2" ? tr("banner.draft.copied") : tr("banner.draft.copy"),
              ),
            )
          : draftView.status === "error"
            ? react.createElement(
                "div",
                { "data-dsh-context-guard": "draft-error", style: { marginTop: "4px", opacity: 0.9 } },
                tr("banner.draft.failed", { reason: draftView.message }),
              )
            : null;

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
          // v0.5.0（P1）：压缩回执 —— 只对「刚刚压缩过」的降级态显示，数据来自宿主账本的最后一行。
          receipt && ctxBag.compacted === true
            ? react.createElement(
                "div",
                { "data-dsh-context-guard": "receipt", style: { marginTop: "3px", opacity: 0.85 } },
                tr("banner.receipt", {
                  pre: receipt.percent.toFixed(1),
                  n: receipt.row,
                  post: Math.round(ratio * 100),
                }),
              )
            : null,
          draftPanel,
        ),
        react.createElement(
          "div",
          { style: { display: "flex", gap: "6px", flex: "0 0 auto" } },
          react.createElement(
            "button",
            {
              type: "button",
              onClick: startDraft,
              disabled: draftBusy,
              title: tr("banner.draft.tip"),
              "data-dsh-context-guard": "draft-button",
              style: draftBusy ? Object.assign({}, buttonStyle, { opacity: 0.6, cursor: "default" }) : buttonStyle,
            },
            draftBusy ? tr("banner.draft.pending") : tr("banner.button.draft"),
          ),
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

      // v0.4.3：这里原来有一次 `syncFromHost()`（`GET STATE_ROUTE` 抄宿主阈值）。
      // 现在浏览器半边不需要阈值了 —— 档位/冷却由宿主投影直接给（见 `guardView`），
      // 于是页面加载时**一个请求都不发**（上下文税/网络税都回到 0）。`/state` 路由仍在，
      // 但那是**只读调试镜像**（`curl` 用），不是这条 UI 的数据通路。

      // 排障把手：验证脚本与操作者都能在 Console 里一眼看到「注册了几次、挂上几次、
      // 宿主说了什么档位」。**只读**：v0.4.3 起没有 `override()` / `hostConfig()` / `syncFromHost()`
      // 了 —— 客户端不再拥有任何判定状态，也就没有能改判定的入口（那正是要消灭的漂移）。
      try {
        if (typeof window !== "undefined") {
          var existing = window.__DSH_CONTEXT_GUARD__ || {};
          existing.plugin = "dsh-context-guard";
          existing.calls = calls;
          existing.store = store;
          existing.hasSlots = !!(ctx && ctx.slots);
          // ⚠️ 这两个只服务于**本机验收脚本**（在真机上就地试挂一个席位）。
          //    它们不提升任何权限 —— 这段代码本来就跑在 DSH Web 页面里，页面内任何脚本都已持有同等能力。
          existing.ctx = ctx;
          existing.react = react;
          existing.Badge = Badge;
          existing.Banner = Banner;
          // `config` 是**活的** getter（Console 里看到的永远是当前值）：现在它只报
          // 「值从哪来 + 本半边的语言」，不再报阈值 —— 阈值只有宿主知道。
          Object.defineProperty(existing, "config", {
            configurable: true,
            enumerable: true,
            get: function () {
              return store.config();
            },
          });
          // 宿主判定的观测面：`viewOf(sessionId)` 给最近一次读到的投影值（排障用）。
          existing.viewOf = function (sessionId) {
            return sessionId === undefined ? store.dump() : store.dump()[String(sessionId)] ?? null;
          };
          // 固定住这个全局：可读，但不能被整体替换（防止页面里别的脚本把把手换成假的）。
          // 语言逃生阀仍可在加载前用 `addInitScript` 预置 `{ config: { locale: 'en' } }`。
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
