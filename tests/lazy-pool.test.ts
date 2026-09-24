import { describe, it, expect } from 'vitest';
import { LazyPool, type RectLike } from '../lib/translation/lazy-pool';
import type { Paragraph } from '../lib/extraction/paragraphs';

function p(id: string, top: number, bottom = top + 20): Paragraph {
  const el = document.createElement('p');
  el.textContent = `paragraph ${id}`;
  document.body.appendChild(el);
  el.setAttribute('data-top', String(top));
  el.setAttribute('data-bottom', String(bottom));
  return { id, element: el, text: `paragraph ${id}` };
}

const rectOf = (el: Element): RectLike => ({
  top: Number(el.getAttribute('data-top')),
  bottom: Number(el.getAttribute('data-bottom')),
});

describe('LazyPool', () => {
  it('takeVisible：只取出视口（含 margin）内的段落并移出池', () => {
    const pool = new LazyPool();
    pool.addAll([p('a', 0), p('b', 500), p('c', 900), p('d', 1300)]);
    const taken = pool.takeVisible(rectOf, 800, 200);
    expect(taken.map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(pool.size).toBe(1);
  });

  it('add：同 id 去重', () => {
    const pool = new LazyPool();
    const a = p('a', 0);
    pool.add(a);
    pool.add(a);
    expect(pool.size).toBe(1);
  });

  it('removeMany：返回被移除段落，未命中静默', () => {
    const pool = new LazyPool();
    pool.addAll([p('a', 0), p('b', 10), p('c', 20)]);
    const removed = pool.removeMany(['a', 'c', 'zzz']);
    expect(removed.map(x => x.id)).toEqual(['a', 'c']);
    expect(pool.size).toBe(1);
  });

  it('prune：剔除已断开节点，返回剔除数', () => {
    const pool = new LazyPool();
    const gone = p('gone', 0);
    pool.addAll([gone, p('stay', 0)]);
    gone.element.remove();
    expect(pool.prune()).toBe(1);
    expect(pool.size).toBe(1);
  });

  it('clear：清空', () => {
    const pool = new LazyPool();
    pool.addAll([p('a', 0), p('b', 0)]);
    pool.clear();
    expect(pool.size).toBe(0);
  });
});
