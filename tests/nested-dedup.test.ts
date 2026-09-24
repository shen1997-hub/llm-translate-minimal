import { describe, it, expect } from 'vitest';
import { extractParagraphs } from '../lib/extraction/paragraphs';

const OPTS = { minLength: 20, cjkRatioThreshold: 0.3 };
const visible = () => true;
const LONG = 'Add theme toggle functionality and language options to the popup window.';

function root(html: string): Element {
  const d = new DOMParser().parseFromString(`<html><body><main>${html}</main></body></html>`, 'text/html');
  return d.querySelector('main')!;
}

describe('复现：GitHub commit message 单元格译文重复', () => {
  it('td 内只有 a/span/time 的 div 不应与 td 同时被提取', () => {
    const r = root(
      `<table><tr><td><div><a href="/x">${LONG}</a></div></td></tr></table>`,
    );
    const ps = extractParagraphs(r, OPTS, visible);
    console.log('提取到', ps.length, '段:', ps.map(p => `${p.element.tagName}: "${p.text.slice(0, 40)}..."`));
    expect(ps).toHaveLength(1);
  });

  it('li 内的文本块 div 不应与 li 同时被提取', () => {
    const r = root(`<ul><li><div><span>${LONG}</span></div></li></ul>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps).toHaveLength(1);
  });
});
