import { describe, it, expect } from 'vitest';
import { buildLookupMessages, parseLookupResponse } from '../lib/translation/prompt';

describe('buildLookupMessages', () => {
  it('系统提示含目标语言与 JSON 结构要求，用户消息含单词与句子', () => {
    const m = buildLookupMessages('raise', 'Please raise your hand.', '中文');
    expect(m[0]!.role).toBe('system');
    expect(m[0]!.content).toContain('中文');
    expect(m[0]!.content).toContain('"senses"');
    expect(m[0]!.content).toContain('"contextual"');
    expect(m[1]!.role).toBe('user');
    expect(m[1]!.content).toContain('raise');
    expect(m[1]!.content).toContain('Please raise your hand.');
  });
});

describe('parseLookupResponse', () => {
  it('正常解析完整词条', () => {
    const r = parseLookupResponse('{"word":"raise","phonetic":"/reɪz/","senses":[{"pos":"v.","meaning":"举起"}],"related":[{"word":"lift","note":"syn. 举起"}],"contextual":"本句中指举起手"}');
    expect(r).toEqual({
      word: 'raise',
      phonetic: '/reɪz/',
      senses: [{ pos: 'v.', meaning: '举起' }],
      related: [{ word: 'lift', note: 'syn. 举起' }],
      contextual: '本句中指举起手',
    });
  });
  it('容忍 ```json 围栏', () => {
    const r = parseLookupResponse('```json\n{"word":"a","senses":[{"pos":"n.","meaning":"甲"}],"related":[],"contextual":"x"}\n```');
    expect(r?.word).toBe('a');
  });
  it('phonetic 为空串时归一为 undefined', () => {
    const r = parseLookupResponse('{"word":"a","phonetic":"","senses":[{"pos":"n.","meaning":"甲"}],"related":[],"contextual":"x"}');
    expect(r?.phonetic).toBeUndefined();
  });
  it('义项/关联词里的非法条目被过滤', () => {
    const r = parseLookupResponse('{"word":"a","senses":[{"pos":"n.","meaning":"甲"},{"pos":1}],"related":[{"word":"b"},{"word":"c","note":"syn. 丙"}],"contextual":"x"}');
    expect(r?.senses).toEqual([{ pos: 'n.', meaning: '甲' }]);
    expect(r?.related).toEqual([{ word: 'c', note: 'syn. 丙' }]);
  });
  it('义项与语境解释同时缺失时返回 null', () => {
    expect(parseLookupResponse('{"word":"a","senses":[],"related":[]}')).toBeNull();
  });
  it('非 JSON / 非对象返回 null', () => {
    expect(parseLookupResponse('not json')).toBeNull();
    expect(parseLookupResponse('[1,2]')).toBeNull();
  });
});
