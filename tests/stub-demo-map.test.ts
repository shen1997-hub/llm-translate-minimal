import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_TRANSLATIONS, matchDemoTranslation } from '../e2e/stub-server';

// 护栏：e2e/stub-server.ts 的演示译文映射表与 e2e/demo-page.html 是手工同步的，
// 演示页文案一改就会静默失配（录像里悄悄退回占位串「译文i」，没有任何用例会报警），
// 这个单测把那份依赖钉死。

// 正文提取阈值：设置项 minLength 默认 20，短于此的段落不会进翻译队列，故只要求 ≥20 的段落命中
const MIN_LENGTH = 20;

// 演示页与测试页都是手写的扁平 HTML（h1/h2/p 内没有内联标签），正则取文本足够，无需 DOM
function segmentTexts(file: string): string[] {
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  return [...html.matchAll(/<(h1|h2|p)>([\s\S]*?)<\/\1>/g)]
    .map((m) => m[2]!.replace(/\s+/g, ' ').trim());
}

describe('演示页译文映射表', () => {
  it('演示页每个达到 minLength 的段落都被映射表前缀命中', () => {
    const segments = segmentTexts('e2e/demo-page.html').filter((t) => t.length >= MIN_LENGTH);
    // 先钉住基数：正则若失效会退化成空数组，不先炸掉的话下面这个循环会静默通过
    expect(segments).toHaveLength(10); // h1 + 2 个 h2 + 7 个 p

    const missed = segments.filter((t) => !matchDemoTranslation(t));
    expect(missed, `以下演示页段落未命中映射表：${missed.map((t) => t.slice(0, 40)).join(' | ')}`).toEqual([]);
  });

  it('回归测试页的段落一律不命中，未命中段落仍走 `译文i` 原逻辑', () => {
    const segments = segmentTexts('e2e/test-page.html').filter((t) => t.length >= MIN_LENGTH);
    expect(segments.length).toBeGreaterThan(0); // translate.spec.ts 的断言依赖这些段落

    // 一旦命中，stub 会改返回中文，translate.spec.ts 里 toHaveText('译文0') 之类的断言立刻红
    for (const text of segments) {
      expect(matchDemoTranslation(text), `测试页段落误命中映射表：${text.slice(0, 40)}`).toBeUndefined();
    }
  });

  it('映射表自身健全：译文非空、前缀之间不互为前缀（匹配结果与遍历顺序无关）', () => {
    for (const [prefix, translation] of DEMO_TRANSLATIONS) {
      expect(prefix.length, `空前缀：${translation}`).toBeGreaterThan(0);
      expect(translation.trim(), `空译文：${prefix}`).not.toBe('');
    }

    for (const [a] of DEMO_TRANSLATIONS) {
      const nested = DEMO_TRANSLATIONS.filter(([b]) => b !== a && b.startsWith(a)).map(([b]) => b);
      expect(nested, `前缀「${a}」被更长的前缀覆盖：${nested.join(' | ')}`).toEqual([]);
    }
  });
});