/**
 * 判定引擎（2026-10-17 从 `index.js` 抽出）。
 *
 * 为什么抽出来：`index.js` 顶层 `import Schema from '@deepseek-ai/schemastery'` —— 那是**宿主提供的依赖**，
 * 而 CI 的 `ci.yml` 刻意**不跑 npm install**（「测试本身也不需要任何依赖」）。
 * 引擎只依赖 `policy.mjs`，单独成模块后 `test/engine.test.mjs` 在无依赖的 CI 里也能 import。
 *
 * ⚠️ 本模块**不得** import 任何 `@deepseek-ai/*`（否则 CI 会再次红）。
 */
import {
  describe as describeSignal,
  defaultConfig,
  initialState,
  nextTurn,
  readOccupancy,
  reduce,
  TrendTracker,
} from './policy.mjs';

export function createGuardEngine(config = defaultConfig()) {
  /** @type {Map<string, object>} */
  const states = new Map();
  const trend = new TrendTracker(config);
  /** @type {object[]} */
  const log = [];

  const stateOf = (sessionId) => {
    let s = states.get(sessionId);
    if (s === undefined) {
      s = initialState();
      states.set(sessionId, s);
    }
    return s;
  };

  const engine = {
    config,
    trend,
    /**
     * 换一份生效配置（**运行期**，不重挂）。设置页写完之后下一轮就要按新阈值判断，
     * 所以 `apply` 每次入口都调它一次；`config` 一律从 `engine.config` 读，不缓存进闭包。
     */
    setConfig(next) {
      engine.config = next;
      trend.cfg = next;
      return next;
    },
    /** 最近若干条判定（倒序），给排障与将来的 client 半边用。 */
    recent: (limit = 20) => log.slice(-limit).reverse(),
    /** 某会话的当前档位与占用率。 */
    snapshotOf(sessionId) {
      const s = states.get(sessionId);
      return {
        level: s?.level ?? 'none',
        armed: s?.armed ?? false,
        turn: s?.turn ?? 0,
        cooldown: s?.cooldown ?? 0,
        compactionDrop: s?.compactionDrop ?? false,
        occupancy: s?.occupancy ?? null,
      };
    },
    /**
     * 吸收一次投影变化。返回提示信号（无提示时 null）。
     * @param {string} sessionId
     * @param {unknown} pressure
     * @param {{atTurnBoundary?: boolean, justCompacted?: boolean, locale?: 'zh'|'en'}} [options]
     *        `locale` 由宿主半边按会话解析（见 `localeOf`）；不给 ⇒ `zh`（与加双语之前一致）。
     */
    observe(sessionId, pressure, options = {}) {
      const reading = readOccupancy(pressure);
      const stateBefore = stateOf(sessionId);
      const out = reduce(stateBefore, reading, {
        config: engine.config,
        atTurnBoundary: options.atTurnBoundary === true,
        justCompacted: options.justCompacted === true,
      });
      states.set(sessionId, out.state);
      if (out.signal === null) return null;
      if (!engine.config.enabled) return null;
      /**
       * 冷却闸门（P0-1 修）：**绝不能吞掉 `escalate`。**
       *
       * 历史 bug：`cooldownTurns` 默认 5。45% 首次 `enter` 后冷却 5 轮，而 45%→60% 只需 15pp
       * （实测常常 3–8 轮就到了）。此时 `reduce` 已经给出 `escalate/hard`，但这里一律丢弃
       * 非 `enter` 信号 —— 而 `states` 在上面那行**已经是 `level: 'hard'`**。于是此后同档
       * 不再 escalate ⇒ 宿主**永久漏报**「该换会话了」：不记日志、不外推、trend 不计数；
       * 而客户端徽标照常显示 hard ⇒ 宿主说没发生、界面上已经在喊，两边不一致。
       *
       * 现在的规矩：`enter` / `escalate` 都是**边沿信号**（每个武装周期各最多一次），一律放行；
       * 只有将来新增的其它信号类型才受冷却约束，且**丢弃时必须回滚 `level`**，
       * 否则状态会声称一个从未播报过的档位（正是上面那个 bug 的形状）。
       */
      const kind = out.signal.kind;
      const isEdgeSignal = kind === 'enter' || kind === 'escalate';
      if (!isEdgeSignal && (out.state.cooldown ?? 0) > 0) {
        states.set(sessionId, { ...out.state, level: stateBefore.level });
        return null;
      }
      const described = describeSignal(out.signal, {
        trend: engine.config.crossSessionTrend ? trend.summary() : undefined,
        lang: options.locale === 'en' ? 'en' : 'zh',
      });
      const record = {
        at: Date.now(),
        sessionId,
        level: out.signal.level,
        kind: out.signal.kind,
        ratioPercent: described.ratioPercent,
        title: described.title,
        body: described.body,
      };
      log.push(record);
      if (log.length > 200) log.splice(0, log.length - 200);
      if (engine.config.crossSessionTrend) trend.note(sessionId, out.signal.level);
      return { signal: out.signal, described, trend: trend.summary() };
    },
    /** 一轮结束：推进轮计数、清压缩标记、消耗冷却。 */
    endTurn(sessionId) {
      const next = nextTurn(stateOf(sessionId), engine.config);
      states.set(sessionId, next);
      return {
        turn: next.turn,
        level: next.level,
        cooldown: next.cooldown,
        occupancy: next.occupancy,
      };
    },
    /** 压缩结束 ⇒ 记一笔「水位刚被压过」，供 respectCompaction 与 UI 说明用。 */
    noteCompaction(sessionId, hadError) {
      if (hadError) return;
      const s = stateOf(sessionId);
      s.compactionDrop = true;
      states.set(sessionId, s);
    },
    /**
     * 解除武装：切模型/换路由之后调用。
     *
     * 理由：官方三个字段是 **last-wins、不是一个原子观测**，切模型后会出现
     * 「新窗口配旧压力」。解除武装意味着「要重新跨越 warn 才再响一次」——
     * 宁可晚一轮提示，也不要拿错配的数字喊「该换会话了」。
     * @returns {boolean} 之前是否处于已武装状态（供日志判断值不值得提一句）
     */
    resetArming(sessionId) {
      const s = stateOf(sessionId);
      const was = s.armed === true || s.level !== 'none';
      s.armed = false;
      s.level = 'none';
      s.cooldown = 0;
      states.set(sessionId, s);
      return was;
    },
    /**
     * 会话打开/恢复：§10.4 说这才是「跨会话」的实质 ——
     * 点进一个已经 85% 的历史会话，进去之前没人告诉你。
     * @param {string} sessionId
     * @param {unknown} pressure
     * @param {{locale?: 'zh'|'en'}} [options]
     */
    onResume(sessionId, pressure, options = {}) {
      if (!engine.config.onResume) return null;
      const reading = readOccupancy(pressure);
      if (reading.known !== true) return null;
      if (reading.ratio < engine.config.hardRatio) return null;
      const described = describeSignal(
        {
          kind: 'enter',
          level: 'hard',
          ratio: reading.ratio,
          projectedTokens: reading.projectedTokens,
          contextWindow: reading.contextWindow,
          compactionDrop: false,
        },
        {
          trend: engine.config.crossSessionTrend ? trend.summary() : undefined,
          lang: options.locale === 'en' ? 'en' : 'zh',
        },
      );
      return { signal: { kind: 'resume', level: 'hard', ratio: reading.ratio }, described };
    },
  };
  return engine;
}
