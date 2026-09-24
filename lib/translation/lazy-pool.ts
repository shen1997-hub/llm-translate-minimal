import type { Paragraph } from '../extraction/paragraphs';

export interface RectLike { top: number; bottom: number }

const DEFAULT_MARGIN = 200;

export class LazyPool {
  private items = new Map<string, Paragraph>();

  add(p: Paragraph): void {
    if (!this.items.has(p.id)) this.items.set(p.id, p);
  }

  addAll(ps: Paragraph[]): void {
    for (const p of ps) this.add(p);
  }

  takeVisible(getRect: (el: Element) => RectLike, viewportHeight: number, margin = DEFAULT_MARGIN): Paragraph[] {
    const taken: Paragraph[] = [];
    for (const [id, p] of this.items) {
      const r = getRect(p.element);
      if (r.bottom >= -margin && r.top <= viewportHeight + margin) {
        taken.push(p);
        this.items.delete(id);
      }
    }
    return taken;
  }

  removeMany(ids: string[]): Paragraph[] {
    const removed: Paragraph[] = [];
    for (const id of ids) {
      const p = this.items.get(id);
      if (p) {
        removed.push(p);
        this.items.delete(id);
      }
    }
    return removed;
  }

  prune(): number {
    let n = 0;
    for (const [id, p] of this.items) {
      if (!p.element.isConnected) {
        this.items.delete(id);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}
