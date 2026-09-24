import { describe, it, expect } from 'vitest';
import { buildAliases, mergeAliases } from '../lib/translation/alias';
import type { Paragraph } from '../lib/extraction/paragraphs';

function p(id: string, text: string): Paragraph {
  return { id, element: document.createElement('p'), text };
}

describe('buildAliases / mergeAliases', () => {
  it('同文本归为一组，保持入组顺序', () => {
    const m = buildAliases([p('a', 'hello'), p('b', 'world'), p('c', 'hello')]);
    expect(m.get('hello')).toEqual(['a', 'c']);
    expect(m.get('world')).toEqual(['b']);
  });

  it('mergeAliases：并入既有组且 id 去重', () => {
    const m = buildAliases([p('a', 'hello')]);
    mergeAliases(m, [p('a', 'hello'), p('b', 'hello'), p('c', 'new')]);
    expect(m.get('hello')).toEqual(['a', 'b']);
    expect(m.get('new')).toEqual(['c']);
  });
});