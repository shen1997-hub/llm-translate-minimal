import { describe, it, expect } from 'vitest';
import { extractParagraphs, cjkRatio } from '../lib/extraction/paragraphs';
import { siteRuleFor } from '../lib/extraction/site-rules';

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
    expect(ps[1]!.element.tagName).toBe('H2');
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
    expect(ps[0]!.text).toBe('This is a long enough english paragraph with weird spacing.');
  });

  it('排除：nav/aside 内部的段落（即使根容器包含它们）', () => {
    const r = root(`<nav><p>${LONG}</p></nav><p>${LONG}</p><aside><p>${LONG}</p></aside>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.element.closest('nav, aside')).toBeNull();
  });

  it('排除：role=complementary 与 aria-hidden 容器内部的段落', () => {
    const r = root(`<div role="complementary"><p>${LONG}</p></div><div aria-hidden="true"><p>${LONG}</p></div><p>${LONG}</p>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('排除：候选元素自身命中负向 class', () => {
    const r = root(`<p class="cookie-banner">${LONG}</p><p>${LONG}</p>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('站点规则 extraCandidates 捕获 div+span 结构的推文正文', () => {
    const r = root(
      `<div data-testid="tweetText"><span>This is a tweet written in English that should be translated.</span></div>`,
    );
    const ps = extractParagraphs(r, OPTS, visible, { extraCandidates: '[data-testid="tweetText"]' });
    expect(ps).toHaveLength(1);
    expect(ps[0]!.text).toContain('tweet written in English');
  });

  it('站点规则 extraExcludes 排除指定祖先内的段落', () => {
    const r = root(`<div data-testid="sidebarColumn"><p>${LONG}</p></div><p>${LONG}</p>`);
    const ps = extractParagraphs(r, OPTS, visible, { extraExcludes: '[data-testid="sidebarColumn"]' });
    expect(ps).toHaveLength(1);
  });

  const LONG_BLOCK = 'This is a fairly long block of English text living inside a plain div element.';

  it('通用块级文本：只含内联子元素的 div 被提取', () => {
    const r = root(`<div><span>${LONG_BLOCK}</span></div>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.element.tagName).toBe('DIV');
  });

  it('通用块级文本：纯文本 div（无子元素）也被提取', () => {
    const r = root(`<div>${LONG_BLOCK}</div>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('通用块级文本：含候选后代的 div 不重复提取', () => {
    const r = root(`<div><p>${LONG}</p></div>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.element.tagName).toBe('P');
  });

  it('通用块级文本：div 适用更严的长度阈值（60），p 不受影响', () => {
    const mid = 'This div text is between twenty and sixty chars.'; // 48 字符
    const r = root(`<div><span>${mid}</span></div><p>${mid}</p>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.element.tagName).toBe('P');
  });

  it('通用块级文本：含块级子元素的 div 不提取', () => {
    const r = root(`<div><ul><li>${LONG_BLOCK}</li></ul></div>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps.every(p => p.element.tagName !== 'DIV')).toBe(true);
  });

  it('GitHub 规则：翻译 About，不翻译文件树 commit 列与最新提交栏', () => {
    const rule = siteRuleFor('github.com');
    const r = root(`
      <div class="Layout">
        <div class="Layout-main">
          <div class="react-directory-row-commit-cell"><a href="/x/commit/abc">${LONG}</a></div>
          <div data-testid="latest-commit"><a href="/x">author</a><span>${LONG}</span></div>
          <p>${LONG}</p>
        </div>
        <aside class="Layout-sidebar"><p>${LONG_BLOCK}</p></aside>
      </div>`);
    const ps = extractParagraphs(r, OPTS, visible, rule);
    expect(ps).toHaveLength(2);
    expect(ps.some(p => p.element.closest('.react-directory-row-commit-cell'))).toBe(false);
    expect(ps.some(p => p.element.closest('[data-testid="latest-commit"]'))).toBe(false);
    expect(ps.some(p => p.element.closest('.Layout-sidebar'))).toBe(true);
  });

  it('GitHub 规则：无规则时 aside 内的 About 会被通用排除拦下', () => {
    const r = root(`<aside class="Layout-sidebar"><p>${LONG_BLOCK}</p></aside><p>${LONG}</p>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps).toHaveLength(1);
  });
});

describe('cjkRatio', () => {
  it('纯英文为 0，纯中文为 1', () => {
    expect(cjkRatio('hello world')).toBe(0);
    expect(cjkRatio('你好世界')).toBe(1);
  });
});
