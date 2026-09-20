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
    if (isExcludedContainer(el) || el.closest(excludedAncestors)) continue;
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
  return result;
}

export function browserIsVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (style.position === 'fixed') return true;
  return (el as HTMLElement).offsetParent !== null;
}
