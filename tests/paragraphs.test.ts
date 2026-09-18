import { describe, it, expect } from 'vitest';
import { extractParagraphs, cjkRatio } from '../lib/extraction/paragraphs';

const OPTS = { minLength: 20, cjkRatioThreshold: 0.3 };
const visible = () => true;
const LONG = 'This is a sufficiently long English paragraph used for unit testing purposes.';

function root(html: string): Element {
  const d = new DOMParser().parseFromString(`<html><body><main>${html}</main></body></html>`, 'text/html');
  return d.querySelector('main')!;
}

describe('extractParagraphs', () => {
  it('提取合格段落并保留 DOM 顺序', () => {
    const r = root(`<p>${LONG}</p><h2>A long enough english heading for test</h2><p>${LONG}</p>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps.map(p => p.id)).toEqual(['p0', 'p1', 'p2']);
    expect(ps[1].element.tagName).toBe('H2');
  });

  it('嵌套候选去重：blockquote>p 与 li>p 只提取一次（取内层）', () => {
    const r = root(`<blockquote><p>${LONG}</p></blockquote><ul><li><p>${LONG}</p></li></ul>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps).toHaveLength(2);
    expect(ps.every(p => p.element.tagName === 'P')).toBe(true);
  });

  it('过滤：短文本', () => {
    const r = root(`<p>Too short.</p><p>${LONG}</p>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('过滤：中文占比超阈值', () => {
    const r = root(`<p>这是一段中文为主 mixed english words 的段落内容足够长</p><p>${LONG}</p>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('过滤：pre/code 内的段落', () => {
    const r = root(`<pre><p>${LONG}</p></pre><p>${LONG}</p>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('过滤：无拉丁字母（纯数字/符号）', () => {
    const r = root(`<p>123 456 7890 —— +++ === 纯数字符号段落占位</p><p>${LONG}</p>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('过滤：不可见元素（isVisible 注入）', () => {
    const r = root(`<p style="display:none">${LONG}</p><p>${LONG}</p>`);
    const ps = extractParagraphs(r, OPTS, (el) => (el as HTMLElement).style.display !== 'none');
    expect(ps).toHaveLength(1);
  });

  it('textContent 空白折叠', () => {
    const r = root(`<p>This  is   a\n\n long   enough   english   paragraph   with   weird   spacing.</p>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps[0].text).toBe('This is a long enough english paragraph with weird spacing.');
  });
});

describe('cjkRatio', () => {
  it('纯英文为 0，纯中文为 1', () => {
    expect(cjkRatio('hello world')).toBe(0);
    expect(cjkRatio('你好世界')).toBe(1);
  });
});
