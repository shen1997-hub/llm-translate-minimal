const EXCLUDE_TAGS = new Set(['NAV', 'ASIDE', 'FOOTER', 'HEADER']);
const EXCLUDE_ROLES = new Set(['navigation', 'complementary', 'banner']);
const NEGATIVE_RE = /nav|menu|sidebar|footer|comment|promo|banner|cookie|related|share/i;
const POSITIVE_SELECTOR = 'article, main, [role="main"], [itemprop="articleBody"]';
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, blockquote, td, th, dd, dt, figcaption';

export function isExcludedContainer(el: Element): boolean {
  if (EXCLUDE_TAGS.has(el.tagName)) return true;
  if (EXCLUDE_ROLES.has(el.getAttribute('role') ?? '')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const ident = `${el.id} ${el.getAttribute('class') ?? ''}`;
  return NEGATIVE_RE.test(ident);
}

function linkDensity(el: Element, textLen: number): number {
  if (textLen === 0) return 1;
  let linkLen = 0;
  for (const a of el.querySelectorAll('a')) linkLen += (a.textContent ?? '').length;
  return linkLen / textLen;
}

function score(el: Element): number {
  const textLen = (el.textContent ?? '').trim().length;
  if (textLen < 100) return 0;
  if (linkDensity(el, textLen) > 0.5) return 0;
  const blocks = el.querySelectorAll(BLOCK_SELECTOR).length;
  const nodeCount = Math.max(el.querySelectorAll('*').length, 1);
  const textDensity = textLen / nodeCount;
  return blocks * 100 + textDensity;
}

export function findContentRoot(doc: Document): Element {
  const candidates = new Set<Element>();
  for (const el of doc.querySelectorAll(POSITIVE_SELECTOR)) candidates.add(el);
  if (candidates.size === 0) {
    for (const el of doc.body.querySelectorAll('div, section')) candidates.add(el);
  }
  let best: Element | null = null;
  let bestScore = 0;
  for (const el of candidates) {
    if (isExcludedContainer(el) || el.closest('nav, aside, footer, header')) continue;
    const s = score(el);
    if (s > bestScore) { bestScore = s; best = el; }
  }
  return best ?? doc.body;
}
