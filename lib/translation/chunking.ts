export interface ChunkUnit { paragraphId: string; text: string; sliceIndex: number; sliceTotal: number }
export interface Chunk { units: ChunkUnit[]; charCount: number }

const SENTENCE_END_RE = /[.!?;]\s/g;

function hardCut(text: string, maxChars: number): string[] {
  const slices: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) slices.push(text.slice(i, i + maxChars));
  return slices;
}

export function splitIntoSlices(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const boundaries: number[] = [];
  for (const m of text.matchAll(SENTENCE_END_RE)) boundaries.push(m.index! + m[0].length);
  if (boundaries.length === 0) return hardCut(text, maxChars);
  const slices: string[] = [];
  let start = 0;
  let lastBoundary = 0;
  for (const b of boundaries) {
    if (b - start > maxChars && lastBoundary > start) {
      slices.push(text.slice(start, lastBoundary));
      start = lastBoundary;
    }
    lastBoundary = b;
  }
  if (start < text.length) slices.push(text.slice(start));
  // 单片仍超限时硬切
  return slices.flatMap(s => (s.length <= maxChars ? [s] : hardCut(s, maxChars)));
}

export function buildChunks(paragraphs: { id: string; text: string }[], maxChars = 1500): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk = { units: [], charCount: 0 };
  for (const p of paragraphs) {
    if (p.text.length === 0) continue;
    const slices = splitIntoSlices(p.text, maxChars);
    for (let s = 0; s < slices.length; s++) {
      const unit: ChunkUnit = { paragraphId: p.id, text: slices[s], sliceIndex: s, sliceTotal: slices.length };
      if (current.units.length > 0 && current.charCount + unit.text.length > maxChars) {
        chunks.push(current);
        current = { units: [], charCount: 0 };
      }
      current.units.push(unit);
      current.charCount += unit.text.length;
    }
  }
  if (current.units.length > 0) chunks.push(current);
  return chunks;
}
