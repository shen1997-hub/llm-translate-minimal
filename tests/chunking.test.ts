import { describe, it, expect } from 'vitest';
import { buildChunks, splitIntoSlices } from '../lib/translation/chunking';

describe('buildChunks', () => {
  it('短段落合并进一块，不超 maxChars', () => {
    const ps = [
      { id: 'p0', text: 'a'.repeat(80) },
      { id: 'p1', text: 'b'.repeat(80) },
      { id: 'p2', text: 'c'.repeat(80) },
    ];
    const chunks = buildChunks(ps, 200);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].units.map(u => u.paragraphId)).toEqual(['p0', 'p1']);
    expect(chunks[1].units.map(u => u.paragraphId)).toEqual(['p2']);
    for (const c of chunks) expect(c.charCount).toBeLessThanOrEqual(200);
  });

  it('保持 DOM 顺序连续，不打乱', () => {
    const ps = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, text: 'x'.repeat(100) }));
    const chunks = buildChunks(ps, 250);
    const order = chunks.flatMap(c => c.units.map(u => u.paragraphId));
    expect(order).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('空文本段落不产生任何 unit', () => {
    const chunks = buildChunks([{ id: 'p0', text: '' }, { id: 'p1', text: 'hello' }], 100);
    const units = chunks.flatMap(c => c.units);
    expect(units).toHaveLength(1);
    expect(units[0].paragraphId).toBe('p1');
    expect(units.every(u => u.text.length > 0)).toBe(true);
  });

  it('超长段落按句子边界分片，共享 paragraphId 与 sliceTotal', () => {
    const sentence = 'This is one complete sentence. ';
    const long = sentence.repeat(10); // 310 字符
    const chunks = buildChunks([{ id: 'p0', text: long }], 100);
    const units = chunks.flatMap(c => c.units);
    expect(units.length).toBeGreaterThan(1);
    expect(units.every(u => u.paragraphId === 'p0')).toBe(true);
    expect(units.every(u => u.sliceTotal === units.length)).toBe(true);
    expect(units.map(u => u.sliceIndex)).toEqual(units.map((_, i) => i));
    expect(units.map(u => u.text).join('')).toBe(long);
    for (const u of units) expect(u.text.endsWith('. ') || u === units[units.length - 1]).toBe(true);
  });
});

describe('splitIntoSlices', () => {
  it('短于上限直接返回整段', () => {
    expect(splitIntoSlices('short text', 100)).toEqual(['short text']);
  });
  it('无句子边界时硬切', () => {
    const slices = splitIntoSlices('x'.repeat(250), 100);
    expect(slices.map(s => s.length)).toEqual([100, 100, 50]);
  });
  it('首个句子边界超过 maxChars 时硬切且不爆栈', () => {
    const text = 'a'.repeat(200) + '. ';
    const slices = splitIntoSlices(text, 100);
    expect(slices.map(s => s.length)).toEqual([100, 100, 2]);
    expect(slices.join('')).toBe(text);
  });
});
