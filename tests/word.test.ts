import { describe, it, expect } from 'vitest';
import { isWordLike, extractSentence } from '../lib/extraction/word';

describe('isWordLike', () => {
  it('单个词判定为单词', () => {
    expect(isWordLike('apple')).toBe(true);
  });
  it('连字符复合词判定为单词', () => {
    expect(isWordLike('well-known')).toBe(true);
  });
  it('2-3 个词的词组判定为单词', () => {
    expect(isWordLike('take care')).toBe(true);
    expect(isWordLike('take care of')).toBe(true);
  });
  it('超过 3 个词不判定为单词', () => {
    expect(isWordLike('this is a sentence')).toBe(false);
  });
  it('含句读符号不判定为单词', () => {
    expect(isWordLike('hello.')).toBe(false);
    expect(isWordLike('什么？')).toBe(false);
  });
  it('含逗号/顿号/冒号不判定为单词', () => {
    expect(isWordLike('yes, please')).toBe(false);
    expect(isWordLike('你好，世界')).toBe(false);
    expect(isWordLike('注：')).toBe(false);
  });
  it('空白与超长输入不判定为单词', () => {
    expect(isWordLike('   ')).toBe(false);
    expect(isWordLike('x'.repeat(61))).toBe(false);
  });
  it('单个中文词判定为单词', () => {
    expect(isWordLike('翻译')).toBe(true);
  });
});

function makeRange(text: string, word: string): Range {
  const div = document.createElement('div');
  div.textContent = text;
  const node = div.firstChild as Text;
  const start = text.indexOf(word);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + word.length);
  return range;
}

describe('extractSentence', () => {
  it('句中选词：返回完整句子', () => {
    const r = makeRange('The quick brown fox jumps over the lazy dog. Next sentence here.', 'brown');
    expect(extractSentence(r)).toBe('The quick brown fox jumps over the lazy dog.');
  });
  it('不串到相邻句', () => {
    const r = makeRange('First one. Second one. Third one.', 'Second');
    expect(extractSentence(r)).toBe('Second one.');
  });
  it('中文句读边界', () => {
    const r = makeRange('今天天气很好。我们去公园散步。明天再说。', '公园');
    expect(extractSentence(r)).toBe('我们去公园散步。');
  });
  it('选区起点在元素节点：退化为选中文本', () => {
    const div = document.createElement('div');
    div.innerHTML = '<b>hello</b> world';
    const range = document.createRange();
    range.selectNodeContents(div);
    expect(extractSentence(range)).toBe('hello world');
  });
  it('超长句子以选词为中心截断到 300 字符', () => {
    const text = `${'a'.repeat(200)} TARGET ${'b'.repeat(200)}`;
    const r = makeRange(text, 'TARGET');
    const s = extractSentence(r);
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).toContain('TARGET');
  });
});
