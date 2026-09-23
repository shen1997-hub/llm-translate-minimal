import { describe, it, expect } from 'vitest';
import { formatWordEntryText } from '../lib/renderer/selection';

const base = {
  word: 'raise',
  phonetic: '/reɪz/' as string | undefined,
  senses: [{ pos: 'v.', meaning: '举起；提升' }, { pos: 'n.', meaning: '加薪' }],
  related: [{ word: 'lift', note: 'syn. 举起' }, { word: 'lower', note: 'ant. 降低' }],
  contextual: '本句中指举起手',
};

describe('formatWordEntryText', () => {
  it('完整词条：单词+音标+义项+关联词+语境逐行输出', () => {
    const text = formatWordEntryText(base);
    expect(text).toBe([
      'raise /reɪz/',
      'v. 举起；提升',
      'n. 加薪',
      '关联词：lift(syn. 举起)，lower(ant. 降低)',
      '本句中：本句中指举起手',
    ].join('\n'));
  });
  it('无音标/无关联词/无语境时对应行省略', () => {
    const text = formatWordEntryText({ word: 'the', phonetic: undefined, senses: [{ pos: 'art.', meaning: '定冠词' }], related: [], contextual: '' });
    expect(text).toBe(['the', 'art. 定冠词'].join('\n'));
  });
});
