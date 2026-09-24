import { isExcludedContainer, EXCLUDED_ANCESTOR_SELECTOR } from './scoring';
import type { SiteRule } from './site-rules';

export interface Paragraph { id: string; element: Element; text: string }
export interface ExtractOptions { minLength: number; cjkRatioThreshold: number }
export type IsVisibleFn = (el: Element) => boolean;

export const CANDIDATE_SELECTOR = 'p, li, h1, h2, h3, h4, blockquote, td, th, dd, dt, figcaption';
const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/g;

// 通用块级文本识别：只含这些内联子元素（或无子元素）的 div 视为文本块
const INLINE_TAGS = new Set([
  'A', 'SPAN', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'BR', 'U', 'S', 'SUB', 'SUP',
  'MARK', 'TIME', 'ABBR', 'Q', 'CITE', 'CODE', 'KBD', 'SAMP', 'VAR', 'WBR',
  'BDI', 'BDO', 'DATA', 'DFN', 'INS', 'DEL',
]);
// div 候选用更严的长度阈值，避免抓到卡片/按钮等碎文本
const DIV_MIN_LENGTH = 60;

export function cjkRatio(text: string): number {
  const nonSpace = text.replace(/\s/g, '');
  if (nonSpace.length === 0) return 0;
  const cjk = (nonSpace.match(CJK_RE) ?? []).length;
  return cjk / nonSpace.length;
}

function isNestedDuplicate(el: Element, selector: string): boolean {
  const total = (el.textContent ?? '').length;
  if (total === 0) return false;
  let inner = 0;
  for (const child of el.querySelectorAll(selector)) {
    inner += (child.textContent ?? '').length;
  }
  return inner > 0 && inner / total >= 0.7;
}

function isTextBlockDiv(el: Element, candidateSelector: string): boolean {
  if (el.tagName !== 'DIV') return false;
  if (el.querySelector(candidateSelector)) return false;
  for (const child of el.children) {
    if (!INLINE_TAGS.has(child.tagName)) return false;
  }
  return true;
}

export function extractParagraphs(
  root: Element,
  opts: ExtractOptions,
  isVisible: IsVisibleFn,
  rule?: SiteRule,
): Paragraph[] {
  const candidateSelector = rule?.extraCandidates
    ? `${CANDIDATE_SELECTOR}, ${rule.extraCandidates}`
    : CANDIDATE_SELECTOR;
  const excludedAncestors = rule?.extraExcludes
    ? `${EXCLUDED_ANCESTOR_SELECTOR}, ${rule.extraExcludes}`
    : EXCLUDED_ANCESTOR_SELECTOR;

  const result: Paragraph[] = [];
  let seq = 0;
  for (const el of root.querySelectorAll(`${candidateSelector}, div`)) {
    // 站点规则显式包含的区域（如 GitHub 侧栏 About）跳过通用排除
    const included = rule?.extraIncludes ? el.closest(rule.extraIncludes) !== null : false;
    if (!included && (isExcludedContainer(el) || el.closest(excludedAncestors))) continue;
    if (isNestedDuplicate(el, candidateSelector)) continue;
    if (el.closest('pre, code')) continue;
    if (!isVisible(el)) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const isSemanticCandidate = el.matches(candidateSelector);
    if (!isSemanticCandidate && !isTextBlockDiv(el, candidateSelector)) continue;
    const minLength = isSemanticCandidate ? opts.minLength : Math.max(opts.minLength, DIV_MIN_LENGTH);
    if (text.length < minLength) continue;
    if (cjkRatio(text) > opts.cjkRatioThreshold) continue;
    if (!/[a-zA-Z]/.test(text)) continue;
    result.push({ id: `p${seq++}`, element: el, text });
  }
  // isNestedDuplicate 只统计候选后代，候选祖先（如 td/li）与其内层的文本块 div
  // 可能同时入选。此处收尾去重：存在包含关系时只保留内层，避免同一文本渲染两份译文。
  return result.filter(p => !result.some(q => q !== p && p.element.contains(q.element)));
}

// sr-only 惯用裁剪：clip: rect(0, 0, 0, 0)
const CLIP_ZERO_RE = /^rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)$/;

export function browserIsVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (style.position === 'fixed') return true;
  if (style.opacity === '0') return false;
  if (style.fontSize === '0px') return false;
  // clip / clip-path 裁剪隐藏（屏幕阅读器专用文本的惯用手法）
  if (CLIP_ZERO_RE.test(style.clip)) return false;
  if (style.clipPath.startsWith('inset(')) return false;
  // 收缩到 1px 以下的绝对定位溢出隐藏（如 GitHub 的 .sr-only / .visually-hidden）
  if (style.position === 'absolute' && style.overflow === 'hidden') {
    const w = parseFloat(style.width);
    const h = parseFloat(style.height);
    if ((w > 0 && w <= 1) || (h > 0 && h <= 1)) return false;
  }
  return (el as HTMLElement).offsetParent !== null;
}
