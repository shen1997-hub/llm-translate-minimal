export interface Paragraph { id: string; element: Element; text: string }
export interface ExtractOptions { minLength: number; cjkRatioThreshold: number }
export type IsVisibleFn = (el: Element) => boolean;

export const CANDIDATE_SELECTOR = 'p, li, h1, h2, h3, h4, blockquote, td, th, dd, dt, figcaption';
const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/g;

export function cjkRatio(text: string): number {
  const nonSpace = text.replace(/\s/g, '');
  if (nonSpace.length === 0) return 0;
  const cjk = (nonSpace.match(CJK_RE) ?? []).length;
  return cjk / nonSpace.length;
}

function isNestedDuplicate(el: Element): boolean {
  const total = (el.textContent ?? '').length;
  if (total === 0) return false;
  let inner = 0;
  for (const child of el.querySelectorAll(CANDIDATE_SELECTOR)) {
    inner += (child.textContent ?? '').length;
  }
  return inner > 0 && inner / total >= 0.7;
}

export function extractParagraphs(root: Element, opts: ExtractOptions, isVisible: IsVisibleFn): Paragraph[] {
  const result: Paragraph[] = [];
  let seq = 0;
  for (const el of root.querySelectorAll(CANDIDATE_SELECTOR)) {
    if (isNestedDuplicate(el)) continue;
    if (el.closest('pre, code')) continue;
    if (!isVisible(el)) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < opts.minLength) continue;
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
