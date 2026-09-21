import { describe, it, expect } from 'vitest';
import { createMarkerDemux } from '../lib/translation/marker-demux';
import { parsePlainResponse } from '../lib/translation/prompt';

function collectDeltas(chunks: string[], expected: number) {
  const deltas: [number, string][] = [];
  const demux = createMarkerDemux(expected, (i, t) => deltas.push([i, t]));
  for (const c of chunks) demux.push(c);
  return { deltas, text: demux.finish() };
}

describe('createMarkerDemux', () => {
  it('单块：按标记归属并立即吐出', () => {
    expect(collectDeltas(['[0] 甲\n\n[1] 乙'], 2).deltas).toEqual([[0, '甲'], [1, '乙']]);
  });

  it('标记被拆到三次 push（[ / 1 / ]）也不吐出半截标记', () => {
    const { deltas } = collectDeltas(['[', '1', '] 甲'], 2);
    expect(deltas).toEqual([[1, '甲']]);
  });

  it('首个标记之前的引言丢弃', () => {
    expect(collectDeltas(['好的，以下是译文：\n[0] 甲'], 1).deltas).toEqual([[0, '甲']]);
  });

  it('越界标记不认，原样留在上一段正文里', () => {
    const { deltas } = collectDeltas(['[0] 甲\n[7] 乙\n[1] 丙'], 2);
    expect(deltas).toEqual([[0, '甲\n[7] 乙'], [1, '丙']]);
  });

  it('跨块文本按到达顺序吐出（贪心）', () => {
    const { deltas } = collectDeltas(['[0] 甲', '乙', '丙'], 1);
    expect(deltas).toEqual([[0, '甲'], [0, '乙'], [0, '丙']]);
  });

  it('尾部半截标记挂起，后续字符到达后才吐', () => {
    const { deltas } = collectDeltas(['[0] 甲', '\n\n[1'], 2);
    expect(deltas).toEqual([[0, '甲']]); // 此时 [1 还挂起，没有归属
    expect(deltas.flat().join('')).not.toContain('[1');
  });

  it('finish() 返回全文，可交 parsePlainResponse 权威解析', () => {
    const { text } = collectDeltas(['[0] 甲', '\n\n[', '1] 乙'], 2);
    expect(parsePlainResponse(text, 2)).toEqual(['甲', '乙']);
  });
});