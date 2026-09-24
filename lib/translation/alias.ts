import type { Paragraph } from '../extraction/paragraphs';

export function buildAliases(ps: Paragraph[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  mergeAliases(m, ps);
  return m;
}

export function mergeAliases(target: Map<string, string[]>, ps: Paragraph[]): void {
  for (const p of ps) {
    const ids = target.get(p.text);
    if (ids) {
      if (!ids.includes(p.id)) ids.push(p.id);
    } else {
      target.set(p.text, [p.id]);
    }
  }
}