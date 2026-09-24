import { describe, it, expect } from 'vitest';
import { ensureHost, setHostState, removeAllHosts, HOST_ATTR } from '../lib/renderer/host';

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');
}

describe('ensureHost', () => {
  it('普通段落：作为兄弟节点插到元素之后', () => {
    const d = doc('<div><p>text</p></div>');
    const p = d.querySelector('p')!;
    const host = ensureHost(p, 'h1');
    expect(p.nextSibling).toBe(host);
    expect(host.getAttribute(HOST_ATTR)).toBe('h1');
    expect(host.shadowRoot).not.toBeNull();
  });

  it('li：插到 li 内部末尾', () => {
    const d = doc('<ul><li>item</li></ul>');
    const li = d.querySelector('li')!;
    const host = ensureHost(li, 'h2');
    expect(host.parentElement).toBe(li);
  });

  it('td/th：插到单元格内部末尾（单元格内换行显示）', () => {
    const d = doc('<table><tr><td>cell text</td><th>head text</th></tr></table>');
    const td = d.querySelector('td')!;
    const th = d.querySelector('th')!;
    const hostTd = ensureHost(td, 't1');
    const hostTh = ensureHost(th, 't2');
    expect(hostTd.parentElement).toBe(td);
    expect(hostTh.parentElement).toBe(th);
    // 行内不产生额外块：tr 的直接子元素仍只有两个单元格
    expect(d.querySelectorAll('tr > *')).toHaveLength(2);
  });

  it('grid 父容器：host 独占整行 (gridColumn: 1 / -1)', () => {
    const d = doc('<div style="display:grid"><p>text</p></div>');
    const p = d.querySelector('p')!;
    const host = ensureHost(p, 'g1');
    expect(host.style.gridColumn).toBe('1 / -1');
  });

  it('flex 父容器（可换行）：host 独占整行 (flexShrink: 0)', () => {
    const d = doc('<div style="display:flex;flex-wrap:wrap"><p>text</p></div>');
    const p = d.querySelector('p')!;
    const host = ensureHost(p, 'f1');
    expect(host.style.flexBasis).toBe('100%');
    expect(host.style.width).toBe('100%');
    expect(host.style.flexShrink).toBe('0');
  });

  it('单行横排 flex 父容器：host 挂到容器之后，避免挤垮同行原文', () => {
    const d = doc('<section><div style="display:flex"><span>author</span><p>text</p></div></section>');
    const p = d.querySelector('p')!;
    const bar = d.querySelector('section > div')!;
    const host = ensureHost(p, 'f2');
    expect(host.parentElement).toBe(d.querySelector('section'));
    expect(bar.nextSibling).toBe(host);
    expect(host.style.flexBasis).toBe('');
  });

  it('纵排 flex 父容器：仍插在容器内并独占整行', () => {
    const d = doc('<div style="display:flex;flex-direction:column"><p>text</p></div>');
    const p = d.querySelector('p')!;
    const host = ensureHost(p, 'f3');
    expect(host.parentElement).toBe(p.parentElement);
    expect(host.style.flexBasis).toBe('100%');
  });

  it('重复调用同 id 返回已有 host，不重复插入', () => {
    const d = doc('<div><p>text</p></div>');
    const p = d.querySelector('p')!;
    const a = ensureHost(p, 'h3');
    const b = ensureHost(p, 'h3');
    expect(a).toBe(b);
    expect(d.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(1);
  });
});

describe('setHostState', () => {
  it('done 态写入译文，error 态含重试按钮', () => {
    const d = doc('<div><p>text</p></div>');
    const host = ensureHost(d.querySelector('p')!, 'h4');
    setHostState(host, 'done', '译文内容');
    expect(host.shadowRoot!.textContent).toContain('译文内容');
    setHostState(host, 'error');
    expect(host.shadowRoot!.querySelector('[data-retry]')).not.toBeNull();
  });

  it('loading 态含三点脉动，文案不含三点文本', () => {
    const d = doc('<div><p>text</p></div>');
    const host = ensureHost(d.querySelector('p')!, 'h5');
    setHostState(host, 'loading');
    const body = host.shadowRoot!.querySelector('.body')!;
    expect(body.textContent).toBe('翻译中…');
    expect(body.querySelectorAll('.dots i')).toHaveLength(3);
  });

  it('streaming 态：正文为累积译文，带 streaming 类（光标由 ::after 画）', () => {
    const d = doc('<div><p>text</p></div>');
    const host = ensureHost(d.querySelector('p')!, 'h6');
    setHostState(host, 'streaming', '半截译文');
    const body = host.shadowRoot!.querySelector('.body')!;
    expect(body.className).toBe('body streaming');
    expect(body.textContent).toBe('半截译文');
  });

  it('streaming → done 覆盖为权威文本，且不留三点', () => {
    const d = doc('<div><p>text</p></div>');
    const host = ensureHost(d.querySelector('p')!, 'h7');
    setHostState(host, 'streaming', '半截');
    setHostState(host, 'done', '完整译文');
    const body = host.shadowRoot!.querySelector('.body')!;
    expect(body.className).toBe('body done');
    expect(body.textContent).toBe('完整译文');
    expect(body.querySelector('.dots')).toBeNull();
  });
});

describe('removeAllHosts', () => {
  it('移除全部 host', () => {
    const d = doc('<div><p>a</p><p>b</p></div>');
    ensureHost(d.querySelectorAll('p')[0]!, 'x1');
    ensureHost(d.querySelectorAll('p')[1]!, 'x2');
    removeAllHosts(d);
    expect(d.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(0);
  });
});
