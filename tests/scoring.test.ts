import { describe, it, expect } from 'vitest';
import { findContentRoot, isExcludedContainer } from '../lib/extraction/scoring';

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');
}

const LONG = 'This is a sufficiently long paragraph of English text used for testing purposes. '.repeat(3);

describe('findContentRoot', () => {
  it('选择 article 而非 nav/sidebar/footer', () => {
    const d = doc(`
      <nav><ul><li><a href="#">Home link here</a></li></ul></nav>
      <article><p>${LONG}</p><p>${LONG}</p></article>
      <aside class="sidebar"><p>${LONG}</p></aside>
      <footer><p>Copyright text that is long enough to pass the filter rules here.</p></footer>
    `);
    expect(findContentRoot(d).tagName).toBe('ARTICLE');
  });

  it('链接密度 > 50% 的容器被丢弃', () => {
    const d = doc(`
      <div class="links"><a href="#">${LONG}</a></div>
      <main><p>${LONG}</p><p>${LONG}</p></main>
    `);
    expect(findContentRoot(d).tagName).toBe('MAIN');
  });

  it('无合格容器时退化到 body', () => {
    const d = doc(`<nav><ul><li><a href="#">only nav links here</a></li></ul></nav>`);
    expect(findContentRoot(d)).toBe(d.body);
  });

  it('站点规则的 rootSelector 命中时直接选它（跳过评分）', () => {
    const d = doc(`
      <main><p>${LONG}</p><p>${LONG}</p></main>
      <div data-testid="primaryColumn"><p>short</p></div>
    `);
    const root = findContentRoot(d, { rootSelector: '[data-testid="primaryColumn"]' });
    expect(root.getAttribute('data-testid')).toBe('primaryColumn');
  });

  it('站点规则的 rootSelector 未命中时退回评分逻辑', () => {
    const d = doc(`<article><p>${LONG}</p><p>${LONG}</p></article>`);
    expect(findContentRoot(d, { rootSelector: '[data-testid="primaryColumn"]' }).tagName).toBe('ARTICLE');
  });
});

describe('isExcludedContainer', () => {
  it('按标签排除', () => {
    const d = doc('<nav><p>x</p></nav>');
    expect(isExcludedContainer(d.querySelector('nav')!)).toBe(true);
  });
  it('按负向 class 排除', () => {
    const d = doc('<div class="cookie-banner"><p>x</p></div>');
    expect(isExcludedContainer(d.querySelector('div')!)).toBe(true);
  });
  it('按 aria-hidden 排除', () => {
    const d = doc('<div aria-hidden="true"><p>x</p></div>');
    expect(isExcludedContainer(d.querySelector('div')!)).toBe(true);
  });
  it('普通容器不排除', () => {
    const d = doc('<article><p>x</p></article>');
    expect(isExcludedContainer(d.querySelector('article')!)).toBe(false);
  });
});
