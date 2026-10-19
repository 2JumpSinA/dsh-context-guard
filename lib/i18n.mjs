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
    // v0.6.0（P3「说真话」）：正文按档位分开。
    // v0.7.0（文案审定）：每段只回答一个问题，且每句都能被用户核对。
    //   · 「静默」→「不问你」（可核）；「拿不回来」→「不再进入上下文」（可核）；
    //   · 删掉账本尾巴（那句与本产品「压缩账会抢存一行」自相矛盾，且是免责声明不是信息）；
    //   · 「建议」→ 祈使（60% 是唯一提醒档，不该是商量语气）。
    'banner.body.hard': (v) =>
      `本会话下一次请求将携带 ≈${v.projected} / ${v.window} 上下文（${v.percent}%）${v.compaction}。\n` +
      `平台会在${v.point}自动压缩，不问你；被压掉的部分不再进入上下文。\n` +
      `这一轮做完：先写交接（点右边，或写进 \`${v.doc}\`），再开新会话。`,
    // v0.6.2：压缩点三态 —— exact 来自 DSH 解析后的配置，estimated 来自出厂常量
    'banner.body.hard.point.exact': (v) => ` ${v.percent}% 处`,
    'banner.body.hard.point.estimated': (v) => ` ≈${v.percent}%（推算）处`,
    'banner.body.hard.off': (v) =>
      `本会话下一次请求将携带 ≈${v.projected} / ${v.window} 上下文（${v.percent}%）${v.compaction}。\n` +
      `这个会话的自动压缩是关掉的 —— 撞上窗口，请求会直接报错。\n` +
      `这一轮做完：先写交接（点右边，或写进 \`${v.doc}\`），再开新会话。`,
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
    'badge.title.host': (v) => `宿主判定：第 ${v.turn} 轮`,
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
    // v0.7.0 (copy pass): one question per sentence, every claim checkable.
    // "silently" → "without asking"; "is gone" → "no longer enters the context"; drop the ledger tail.
    'banner.body.hard': (v) =>
      `This session's next request will carry ≈${v.projected} / ${v.window} of context (${v.percent}%)${v.compaction}.\n` +
      `The platform compacts automatically at${v.point} without asking you; what it drops no longer enters the context.\n` +
      `After this turn: write the handoff (the button, or \`${v.doc}\`), then open a new session.`,
    'banner.body.hard.point.exact': (v) => ` ${v.percent}%`,
    'banner.body.hard.point.estimated': (v) => ` ≈${v.percent}% (estimated)`,
    'banner.body.hard.off': (v) =>
      `This session's next request will carry ≈${v.projected} / ${v.window} of context (${v.percent}%)${v.compaction}.\n` +
      `Automatic compaction is off for this session — a request that overflows the window fails outright.\n` +
      `After this turn: write the handoff (the button, or \`${v.doc}\`), then open a new session.`,
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
    'badge.title.host': (v) => `host decision: turn ${v.turn}`,
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
