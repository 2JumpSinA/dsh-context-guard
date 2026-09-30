/**
 * client bundle 与源码同源校验。
 *
 * 为什么值得单独一条测试：client 半边是**手写单文件 bundle、没有构建链**，
 * 但阈值策略必须与 host 半边共用同一份 —— 一旦有人只改了 `policy.mjs` 忘了重新生成
 * `lib/client.js`，本插件就会出现「宿主日志说 80%、网页徽标却按别的线判定」这种
 * **静默不一致**。这里重新生成一遍逐字节比对，把这条路堵死。
 *
 * 另外校验三条只能静态证明、上线才会炸的契约：
 *   1. bundle 里不许出现 ESM 语法（经典 script 加载，`import`/`export` 会直接语法错误）；
 *   2. `__ModuleLoader__.load` 的 id 必须等于包名（图行 id，写错=整行加载失败）；
 *   3. 只允许 require 官方 9 个基线说明符，别的一律要写 `dsh.client.external`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../scripts/build-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('lib/client.js 与 policy.mjs + client-source.js 逐字节同源', () => {
  const generated = generate();
  const onDisk = read('lib/client.js');
  assert.equal(
    onDisk,
    generated,
    'lib/client.js 与源码不一致 —— 跑 `node scripts/build-client.mjs` 重新生成',
  );
});

test('bundle 里没有 ESM 语法（经典 script 会直接语法错误）', () => {
  const bundle = read('lib/client.js');
  const body = bundle.replace(/^\s*\/\/.*$/gm, ''); // 注释里提到 import/export 是允许的
  assert.doesNotMatch(body, /^\s*import\s/m, '顶层 import 不允许');
  assert.doesNotMatch(body, /^\s*export\s/m, '顶层 export 不允许');
  assert.doesNotMatch(body, /import\.meta/, 'import.meta 在经典 script 里不存在');
  assert.doesNotMatch(body, /\bawait\b/, '顶层 await 不允许');
});

/** 收集 bundle 顶层用到的「自由标识符」里那些既没声明、也不是 JS 内建/全局的名字。 */
function undefinedFreeIdentifiers(bundle) {
  const declared = new Set();
  for (const m of bundle.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  // 类声明 + 类体内的方法名：`class X { m() {} }` 里的 m 是成员，不是自由标识符。
  // 用括号计数找类体结束位置 —— 正则的 `[\s\S]*?\n\s*}` 会被方法体里第一个 `}` 骗到。
  for (const m of bundle.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g)) {
    declared.add(m[1]);
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < bundle.length && depth > 0) {
      const ch = bundle[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    const body = bundle.slice(m.index + m[0].length, i - 1);
    for (const method of body.matchAll(/(?:^|[\s;{(,])([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(method[1]);
  }
  for (const m of bundle.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of bundle.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[=\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  const known = new Set([
    'Object', 'Array', 'Map', 'Set', 'Math', 'JSON', 'Number', 'String', 'Boolean', 'Date', 'Error', 'TypeError',
    'ReferenceError', 'Promise', 'RegExp', 'isFinite', 'parseInt', 'queueMicrotask', 'setTimeout', 'clearTimeout',
    'fetch', // 浏览器全局：client 半边读宿主状态路由用的就是它（§14.5「宿主机设置接到 client」）
    'require', 'rgba', // CSS 颜色函数会以字符串形式出现在内联样式里
    'constructor', 'context', // 类构造器名与策略里的 `(context = defaultConfig())` 默认参数
    'return', 'var', 'let', 'const', 'if', 'for', 'while', 'switch', 'catch', 'typeof', 'new', 'function', 'do',
    'in', 'of', 'else', 'try', 'finally', 'throw', 'delete', 'void', 'instanceof', 'case', 'break', 'continue',
  ]);
  const used = new Set();
  const code = bundle.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of code.matchAll(/(^|[^.\w$'"])([A-Za-z_$][\w$]*)\s*\(/g)) used.add(m[2]);
  const missing = [];
  for (const name of used) {
    if (declared.has(name) || known.has(name)) continue;
    // 对象字面量的方法简写（形如 `note(args) {`）也不算自由标识符调用
    if (new RegExp(`(?:^|[\\s,{])\\s*${name}\\s*\\([^)]*\\)\\s*\\{`, 'm').test(code)) continue;
    missing.push(name);
  }
  return missing.sort();
}

test('bundle 里没有「引用了但没声明」的标识符（内联重命名事故的护栏）', () => {
  const bundle = read('lib/client.js');
  const missing = undefinedFreeIdentifiers(bundle);
  assert.deepEqual(
    missing,
    [],
    `bundle 顶层调用了这些既没声明也不认识的函数：${missing.join(', ')} —— 内联共享代码时改名不一致就会这样（真事故：describe → 半边别名 describeSignal）`,
  );
});

test('内联后的策略函数名与 client 半边调用名一致', () => {
  const bundle = read('lib/client.js');
  assert.match(bundle, /function guardDescribe\(/, '策略的措辞函数应被改名为 guardDescribe');
  assert.doesNotMatch(bundle, /describeSignal/, 'client 半边不许再引用 describeSignal 这个只存在于 host import 别名里的名字');
});

test('注册 id 等于包名，且只 require 基线说明符', () => {
  const bundle = read('lib/client.js');
  const pkg = JSON.parse(read('package.json'));
  assert.match(bundle, new RegExp(`id:\\s*"${pkg.name}"`), 'id 必须等于包名（图行 id）');

  const baseline = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ]);
  const required = [...bundle.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
  assert.ok(required.length > 0, '一个 require 都没有？');
  for (const spec of required) {
    assert.ok(baseline.has(spec), `require("${spec}") 不在基线里 —— 要写进 package.json 的 dsh.client.external`);
  }
});

test('不注册 model-facing 工具、不注入 prompt（上下文税 = 0 的静态护栏）', () => {
  const host = read('lib/index.js');
  const client = read('lib/client.js');
  /** 只看真代码：注释里「不碰 llm/stream」这种声明式句子不该被当成违规。 */
  const code = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  for (const [label, source] of [
    ['host', host],
    ['client', client],
  ]) {
    const body = code(source);
    assert.doesNotMatch(body, /\btools\s*\.\s*register\b/, `${label} 半边不许注册 agent 工具`);
    assert.doesNotMatch(body, /\bsystemPrompt\s*\.\s*(register|section|push)\b/, `${label} 半边不许注入系统提示段落`);
    assert.doesNotMatch(body, /["'`]llm\/stream["'`]/, `${label} 半边不许碰 llm/stream`);
    assert.doesNotMatch(body, /\bmessages\s*\.\s*(push|splice|unshift)\b/, `${label} 半边不许改 messages`);
  }
});

test('设置字段全部 volatile（否则 dsh-settings 不生成设置页）', () => {
  const host = read('lib/index.js');
  const schemaBlock = host.slice(host.indexOf('export const Config'), host.indexOf('export function normalizeConfig'));
  assert.ok(schemaBlock.length > 0, '找不到 Config');
  const fields = [...schemaBlock.matchAll(/^\s{2}(\w+):\s*Schema\.(boolean|number|string)\(/gm)].map((m) => m[1]);
  assert.ok(fields.length >= 8, `只解析出 ${fields.length} 个字段，是不是 schema 结构改了`);
  for (const field of fields) {
    const fieldBlock = schemaBlock.slice(schemaBlock.indexOf(`  ${field}:`));
    const nextField = fieldBlock.slice(1).search(/^\s{2}\w+:\s*Schema\./m);
    const chunk = nextField === -1 ? fieldBlock : fieldBlock.slice(0, nextField + 1);
    assert.match(chunk, /\.volatile\(\)/, `字段 ${field} 没写 .volatile() —— 设置页会整个不生成`);
  }
});
