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
__POLICY__
      //#endregion

      //#region UI
__UI__
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
