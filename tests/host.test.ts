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
