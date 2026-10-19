/**
 * `@deepseek-ai/schemastery` 的**最小桩**（只给 `test/wiring.test.mjs` 用）。
 *
 * 为什么需要它：`lib/index.js` 顶层 `import Schema from '@deepseek-ai/schemastery'` —— 那是
 * **宿主提供的依赖**，而 CI 刻意不跑 `npm install`（见 `.github/workflows/ci.yml`）。
 * 但 D1/D2 两条缺陷的根因都在 `apply()` 里的**生产接线**（`onChanged → observe` 的实参、
 * `compaction/end` 的载荷解析），只用纯引擎测不到；所以这里用 `module.registerHooks()`
 * 把这个裸说明符指到本桩，让测试能 import **真实的 `apply()`** 而不需要任何已安装依赖。
 *
 * 桩只需要支持 `Config` 那一串**链式调用**（`Schema.boolean().default().description().volatile()` …）；
 * `apply()` 本身完全不碰 `Schema`，所以不需要任何校验/落盘语义。
 */
const node = () => {
  const self = {};
  for (const method of [
    'default',
    'description',
    'min',
    'max',
    'step',
    'volatile',
    'required',
    'hidden',
    'role',
    'pattern',
    'deprecated',
  ]) {
    self[method] = () => self;
  }
  return self;
};

/** `Schema.boolean() / number() / union() / object() / string()` 一律返回可继续链式的空节点。 */
const Schema = new Proxy(function StubSchema() {}, {
  get: () => () => node(),
  apply: () => node(),
});

/** 证伪用：测试断言拿到的确实是桩，而不是本机 node_modules 里的真包。 */
export const __STUB__ = true;

export default Schema;
