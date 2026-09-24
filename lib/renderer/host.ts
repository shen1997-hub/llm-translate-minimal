import { MOTION_CSS, setLoading } from './motion';

export const HOST_ATTR = 'data-llm-translate-host';

const SHADOW_CSS = `
:host { display: block; }
.body { margin: 4px 0 12px; padding: 6px 10px; border-left: 3px solid #7aa2f7;
  color: #333; background: #f6f8fc; font-size: 0.95em; line-height: 1.6; }
.body.loading { color: #999; }
.body.error { border-left-color: #e06c75; color: #e06c75; }
button[data-retry] { margin-left: 8px; cursor: pointer; }
${MOTION_CSS}
@media (prefers-color-scheme: dark) {
  .body { color: #ddd; background: #1e2430; border-left-color: #4a6da7; }
  .body.loading { color: #777; }
}`;

export function ensureHost(after: Element, hostId: string): HTMLElement {
  const doc = after.ownerDocument;
  const existing = doc.querySelector(`[${HOST_ATTR}="${hostId}"]`);
  if (existing) return existing as HTMLElement;

  const host = doc.createElement('div');
  host.setAttribute(HOST_ATTR, hostId);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = SHADOW_CSS;
  const body = doc.createElement('div');
  body.className = 'body loading';
  setLoading(doc, body);
  shadow.append(style, body);

  // li 与表格单元格：宿主块插进元素内部，译文在原文下方换行显示，
  // 避免插到 tr/ul 层级破坏行布局
  if (after.tagName === 'LI' || after.tagName === 'TD' || after.tagName === 'TH') {
    after.appendChild(host);
  } else {
    const parent = after.parentElement;
    if (parent) {
      const style = getComputedStyle(parent);
      const display = style.display;
      // 单行横排 flex（工具栏、提交信息栏等）：块级宿主独占整行的样式会挤垮同行原文，
      // 改挂到 flex 容器之后，避免遮罩原文
      if (display.includes('flex') && !style.flexDirection.startsWith('column') && style.flexWrap === 'nowrap' && parent.parentElement) {
        parent.parentElement.insertBefore(host, parent.nextSibling);
        return host;
      }
      if (display.includes('grid')) {
        host.style.gridColumn = '1 / -1';
      }
      if (display.includes('flex')) {
        host.style.flexBasis = '100%';
        host.style.width = '100%';
        host.style.flexShrink = '0';
      }
      parent.insertBefore(host, after.nextSibling);
    }
  }
  return host;
}

export function setHostState(
  host: HTMLElement,
  state: 'loading' | 'streaming' | 'done' | 'error',
  text?: string,
): void {
  const body = host.shadowRoot?.querySelector<HTMLElement>('.body');
  if (!body) return;
  const doc = host.ownerDocument;
  body.className = `body ${state}`;
  if (state === 'loading') {
    setLoading(doc, body);
  } else {
    // streaming：textContent 保证译文里的尖括号/表情不被当 HTML 解析
    body.textContent = state === 'error' ? '翻译失败' : (text ?? '');
  }
  if (state === 'error') {
    const btn = doc.createElement('button');
    btn.setAttribute('data-retry', '');
    btn.textContent = '重试';
    body.appendChild(btn);
  }
}

export function removeAllHosts(root: ParentNode): void {
  for (const host of root.querySelectorAll(`[${HOST_ATTR}]`)) host.remove();
}
