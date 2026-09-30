/**
 * 文案表（`lib/i18n.mjs`）的机械护栏 —— §19.6「插件双语文案」的验收主件。
 *
 * 为什么必须机械核：文案表是**两张手写的表**，最容易出的错不是「翻得不好」，而是
 *   · 只加了 zh 忘了加 en（真机上表现为用户看到 `log.push.ready` 这种 key 名）；
 *   · en 版顺手抄了中文标点或整句中文（混排，英文用户一眼看出是残次品）；
 *   · `pickLocale` 的优先级被后来的人「顺手简化」掉（默认语言悄悄变了，没人发现）。
 * 这三条都不是靠读一遍代码能守住的，所以逐 key、逐语言地跑一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, STRINGS, makeT, pickLocale, hasHan } from '../lib/i18n.mjs';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 汉字 + CJK 标点（「」、。）+ 全角形式（，：（））—— en 版里一个都不许有。 */
const CJK_OR_FULLWIDTH = /[\u3000-\u303f\uff00-\uffef\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

/**
 * 假参数：任何属性访问都返回一个占位串。
 *
 * 这样不必为 60 多个 key 各写一份 fixture —— 文案函数只做拼接，占位串足够证明
 * 「这个 key 两版都有实现、都能跑出非空字符串」。`v.ratio * 100` 之类会得到 NaN，
 * `NaN.toFixed()` 不抛，仍然返回字符串（这正是我们要的：不因为占位值爆炸）。
 */
const fakeVars = () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => (typeof prop === 'symbol' ? undefined : `«${String(prop)}»`),
      has: () => true,
    },
  );

test('LOCALES 与 STRINGS 的表集合对齐', () => {
  assert.deepEqual([...LOCALES].sort(), Object.keys(STRINGS).sort());
});

test('zh / en 两版的键集合完全一致（防漂移的唯一机械护栏）', () => {
  const zh = Object.keys(STRINGS.zh).sort();
  const en = Object.keys(STRINGS.en).sort();
  assert.deepEqual(en, zh, '有一版多了或少了 key —— 新文案必须两版同时加');
  assert.ok(zh.length >= 50, `键数明显偏少（${zh.length}）—— 是不是有人把整段文案搬漏了`);
});

test('每个 key 在两版都返回非空字符串，且 en 版不许混中文或全角标点', () => {
  for (const [locale, table] of Object.entries(STRINGS)) {
    const t = makeT(locale);
    for (const key of Object.keys(table)) {
      const text = t(key, fakeVars());
      assert.equal(typeof text, 'string', `${locale}/${key} 不是字符串`);
      assert.ok(text.trim() !== '', `${locale}/${key} 返回空串`);
      if (locale === 'en') {
        assert.doesNotMatch(text, CJK_OR_FULLWIDTH, `en/${key} 混进了中文或全角标点：${text}`);
      }
    }
  }
});

/**
 * 记录型假参数：与 `fakeVars` 一样对任何属性返回占位串，但**记下被访问过的变量名**。
 * 用来抓「某语言漏插一个变量」（信息静默变少）与「变量名拼错」（会渲染成 `«persent»`）。
 */
const trackingVars = (seen) =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === 'symbol') return undefined;
        seen.add(String(prop));
        return `«${String(prop)}»`;
      },
      has: () => true,
    },
  );

test('zh / en 每个 key 用到的变量名集合一致（防漏插 / 防拼错）', () => {
  const mismatched = [];
  for (const key of Object.keys(STRINGS.zh)) {
    const zhSeen = new Set();
    const enSeen = new Set();
    STRINGS.zh[key](trackingVars(zhSeen), makeT('zh'));
    STRINGS.en[key](trackingVars(enSeen), makeT('en'));
    const zhVars = [...zhSeen].sort().join(',');
    const enVars = [...enSeen].sort().join(',');
    if (zhVars !== enVars) mismatched.push(`${key} → zh[${zhVars}] vs en[${enVars}]`);
  }
  assert.deepEqual(mismatched, [], '两版用到的变量必须一致，否则某一版会静默少印或印错内容');
});

test('makeT：未知 key 原样返回（fail-soft），未知语言退回默认语言', () => {
  assert.equal(makeT('zh')('nope.key'), 'nope.key');
  assert.equal(makeT('en')('nope.key'), 'nope.key');
  assert.equal(makeT('de')('push.title'), STRINGS.zh['push.title']({}, makeT('zh')));
  assert.notEqual(makeT('en')('push.title'), makeT('zh')('push.title'));
});

test('hasHan：认得汉字，不误判英文与符号', () => {
  assert.equal(hasHan('帮我看一下这个仓库'), true);
  assert.equal(hasHan('hello world'), false);
  assert.equal(hasHan(''), false);
  assert.equal(hasHan(null), false);
  assert.equal(hasHan('§0 · HANDOVER.md — 3 sessions'), false);
});

test('pickLocale：显式 > navigator > 会话首条输入 > 环境变量 > 兜底 zh', () => {
  // ① 显式设置压倒一切线索
  assert.equal(pickLocale('zh', { navigatorLanguage: 'en-US', sampleText: 'hello' }), 'zh');
  assert.equal(pickLocale('en', { navigatorLanguage: 'zh-CN', sampleText: '你好' }), 'en');
  // ② client 半边的线索
  assert.equal(pickLocale('auto', { navigatorLanguage: 'zh-CN' }), 'zh');
  assert.equal(pickLocale('auto', { navigatorLanguage: 'ZH-Hans-CN' }), 'zh');
  assert.equal(pickLocale('auto', { navigatorLanguage: 'en-US' }), 'en');
  assert.equal(pickLocale('auto', { navigatorLanguage: 'ja-JP' }), 'en', '只认 zh 前缀，其余一律 en');
  // ③ host 半边的线索（会话首条用户输入）
  assert.equal(pickLocale('auto', { sampleText: '帮我把阈值调一下' }), 'zh');
  assert.equal(pickLocale('auto', { sampleText: 'explain how this works' }), 'en');
  assert.equal(pickLocale('auto', { sampleText: 'hello 你好' }), 'zh', '只要含汉字就算中文会话');
  // ④ 逃生阀与兜底
  assert.equal(pickLocale('auto', { env: 'en' }), 'en');
  assert.equal(pickLocale('auto', { env: 'de' }), 'zh', '环境变量只认 zh/en，其余当没给');
  assert.equal(pickLocale('auto', {}), 'zh', '拿不到任何线索 ⇒ 兜底 zh（不惊动现有用户）');
  assert.equal(pickLocale(undefined, { sampleText: 'hello' }), 'en', '缺 pref 等同于 auto');
  assert.equal(pickLocale('fr', { sampleText: 'bonjour' }), 'en', '不认识的取值按 auto 处理');
  // navigator 优先于 sampleText（两半边各自只传一条线索，但同时给了就按这个顺序）
  assert.equal(pickLocale('auto', { navigatorLanguage: 'en-US', sampleText: '你好' }), 'en');
});
