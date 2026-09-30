/**
 * 把两半合成手写 client bundle：`lib/client.template.js` 的骨架 + `lib/policy.mjs` 的策略
 * + `lib/client-source.js` 的 UI ⇒ `lib/client.js`。
 *
 * 为什么要有这一步：client 半边**没有构建链**（手写单文件 bundle，见 README 里的理由），
 * 但阈值策略必须与 host 半边共用**同一份**代码 —— 否则「两边各写一份、慢慢漂移」是迟早的事。
 * 生成 + `test/client-sync.test.mjs` 的逐字节复算把这条路堵死。
 *
 * 跑法：`node scripts/build-client.mjs`（`--check` 只校验不写，退出码即结论）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * policy 是纯 ESM；内联前把所有导出降级成同作用域声明，其余逐字保留。
 *
 * 只动**行首**的导出关键字（`export const|function|class` 与尾部的 `export {…}`），
 * 不去碰注释与字符串里出现的 "export" 字样 —— 这正是下面那道自检要拦住的东西。
 */
function policySource() {
  const raw = read('lib/policy.mjs');
  let stripped = raw.replace(/^export (?=(?:const|let|var|function|class|async)\b)/gm, '');
  stripped = stripped.replace(/^export \{[^}]*\};\s*$/gm, '');
  if (/^export /m.test(stripped)) {
    throw new Error('policy.mjs 里还有没被处理的 import/export —— 内联进 client 会直接语法错误');
  }
  if (/^import /m.test(stripped)) {
    throw new Error('policy.mjs 不许有 import —— 它必须保持零依赖，才能同时供两边内联');
  }
  const renamed = renameCollisions(stripped);
  return renamed.replace(/^\s+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * ⚠️ 内联时会撞名的标识符，逐字改名后再注入。
 *
 * 首轮实测的真事故：策略里的措辞函数叫 `describe`，而 client 半边（照官方 bundle 的写法）
 * 有一行 `var module = { exports: {} };` —— `describe` 竟然是 `module.exports` 的保留别名？
 * 不是。真正的坑是 **`describe` 这个短名在 bundle 顶层极易与别的东西撞**，
 * host 半边 import 时用了 `describe as describeSignal` 的别名，而内联路径没有 import，
 * 别名不存在 ⇒ 渲染期 `ReferenceError: describeSignal is not defined`，
 * 而 React 把它吞成一条 console 错误，表现是「banner 就是不出现」。
 *
 * 教训写在这里：**内联共享代码时，凡是被重命名的导出都要在两边用同一个名字。**
 * 统一改叫 `guardDescribe`，并且 `test/client-sync.test.mjs` 会真跑一遍 factory，
 * 再出现「引用了不存在的符号」会立刻红。
 */
const RENAMES = [['describe', 'guardDescribe']];

function renameCollisions(source) {
  let out = source;
  for (const [from, to] of RENAMES) {
    out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }
  return out;
}

/** 缩进：模板里的占位符 `__POLICY__` 在 0 列，所以按 4 空格整体推进保持可读。 */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n');
}

export function generate() {
  const template = read('lib/client.template.js');
  const ui = read('lib/client-source.js')
    .replace(/^\s*\/\*\*[\s\S]*?\*\/\s*(?=\n*(?:function|var|const))/g, (m) => m) // 保留文档注释
    .trimEnd();
  const out = template
    .replace('__POLICY__', indent(policySource(), 4))
    .replace('__UI__', indent(ui, 4));
  if (out.includes('__POLICY__') || out.includes('__UI__')) {
    throw new Error('模板占位符没被替换干净');
  }
  return out;
}

const target = join(ROOT, 'lib/client.js');
const generated = generate();

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = '';
  }
  if (current !== generated) {
    console.log('FAIL: lib/client.js 与源码不一致 —— 跑 node scripts/build-client.mjs 重新生成');
    process.exit(1);
  }
  console.log(`OK: lib/client.js 与 policy/UI 源一致（${generated.length} 字节）`);
  process.exit(0);
}

writeFileSync(target, generated, 'utf8');
console.log(`OK: 已生成 lib/client.js（${generated.length} 字节）`);
