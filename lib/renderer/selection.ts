import { MOTION_CSS, replayPop, setLoading } from './motion';

export const SEL_HOST_ATTR = 'data-llm-translate-sel';

export interface SelUICallbacks {
  onDotClick(): void;
  onClose(): void;
  onRetry(): void;
  onCopy(text: string): void;
  onSpeak(text: string): void;
}

export interface SelUI {
  host: HTMLElement;
  showDot(x: number, y: number): void;
  hideDot(): void;
  isDotVisible(): boolean;
  showPanel(x: number, y: number, model: string): void;
  setPanelState(state: 'loading' | 'done' | 'error', text?: string): void;
  /** 流式增量：切到流式态并追加到面板正文尾部 */
  appendPanelText(text: string): void;
  hidePanel(): void;
  isPinned(): boolean;
  pathInside(path: EventTarget[]): boolean;
  /** 节点是否属于本 UI（含 Shadow DOM 内部）：用于忽略浮窗内的选区变化 */
  containsNode(node: Node | null): boolean;
  destroy(): void;
}

export function clampPosition(x: number, y: number, w: number, h: number, vw: number, vh: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, vw - w - 8)),
    y: Math.max(8, Math.min(y, vh - h - 8)),
  };
}

// 注意：.dot/.panel 的 display 会覆盖 UA 的 [hidden]{display:none}，必须显式补 [hidden] 规则
const SHADOW_CSS = `
:host { position: absolute; left: 0; top: 0; z-index: 2147483647; }
.dot[hidden], .panel[hidden] { display: none; }
.dot {
  width: 26px; height: 26px; border-radius: 50%; border: none; cursor: pointer; padding: 0;
  background: #e91e63; color: #fff; font-size: 13px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}
.panel {
  width: 300px; border-radius: 12px; background: #fff; color: #333;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  font: 13.5px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  overflow: hidden; pointer-events: none;
}
.panel button { pointer-events: auto; }
.header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #f0f0f0; }
.logo { width: 20px; height: 20px; border-radius: 6px; background: #e91e63; color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
.model { flex: 1; font-size: 12px; color: #999; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header button { border: none; background: none; cursor: pointer; font-size: 13px; color: #999; padding: 2px 4px; }
.header button.active { color: #e91e63; }
.body { padding: 10px 12px; min-height: 24px; max-height: 240px; overflow-y: auto; white-space: pre-wrap; }
.body.loading { color: #999; }
.body.error { color: #e06c75; }
/* 长译文溢出时才恢复滚动：短译文完全让开鼠标 */
.body.scrollable { pointer-events: auto; }
.body button[data-sel-retry] { margin-left: 8px; cursor: pointer; border: 1px solid #e06c75;
  background: transparent; color: #e06c75; border-radius: 6px; padding: 1px 8px; font-size: 12px; }
.footer { display: flex; gap: 4px; padding: 6px 10px; border-top: 1px solid #f0f0f0; }
.footer button { border: none; background: none; cursor: pointer; font-size: 14px; padding: 2px 6px; opacity: 0.7; }
.footer button.active { opacity: 1; }
${MOTION_CSS}
@media (prefers-color-scheme: dark) {
  .panel { background: #23272f; color: #ddd; }
  .header, .footer { border-color: #383c44; }
}`;

export function createSelectionUI(doc: Document, cbs: SelUICallbacks): SelUI {
  const host = doc.createElement('div');
  host.setAttribute(SEL_HOST_ATTR, '');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = SHADOW_CSS;

  const dot = doc.createElement('button');
  dot.className = 'dot';
  dot.type = 'button';
  dot.textContent = '译';
  dot.hidden = true;

  const panel = doc.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;
  panel.innerHTML = [
    '<div class="header">',
    '<span class="logo">译</span><span class="model"></span>',
    '<button type="button" class="pin" title="固定">📌</button>',
    '<button type="button" class="close" title="关闭">✕</button>',
    '</div>',
    '<div class="body loading">翻译中…</div>',
    '<div class="footer">',
    '<button type="button" class="speak" title="朗读">🔊</button>',
    '<button type="button" class="copy" title="复制">📋</button>',
    '<button type="button" class="thumb-up" title="好">👍</button>',
    '<button type="button" class="thumb-down" title="差">👎</button>',
    '</div>',
  ].join('');
  shadow.append(style, dot, panel);
  (doc.body ?? doc.documentElement).appendChild(host);

  const modelEl = panel.querySelector('.model')!;
  const bodyEl = panel.querySelector<HTMLElement>('.body')!;
  const pinBtn = panel.querySelector<HTMLButtonElement>('.pin')!;
  const copyBtn = panel.querySelector<HTMLButtonElement>('.copy')!;
  const upBtn = panel.querySelector<HTMLButtonElement>('.thumb-up')!;
  const downBtn = panel.querySelector<HTMLButtonElement>('.thumb-down')!;

  let pinned = false;
  let streaming = false; // 处于流式追加态：正文里是「累积的增量」而非权威文本
  let lastText = '';
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  // 溢出才恢复滚动：短译文保持 pointer-events:none，彻底让开下方正文
  function toggleScrollable(): void {
    bodyEl.classList.toggle('scrollable', bodyEl.scrollHeight > bodyEl.clientHeight);
  }

  // mousedown preventDefault：保住页面选区不被点击圆钮清空
  dot.addEventListener('mousedown', (e) => e.preventDefault());
  dot.addEventListener('click', () => cbs.onDotClick());
  panel.querySelector('.close')!.addEventListener('click', () => cbs.onClose());
  pinBtn.addEventListener('click', () => {
    pinned = !pinned;
    pinBtn.classList.toggle('active', pinned);
  });
  copyBtn.addEventListener('click', () => {
    cbs.onCopy(lastText);
    copyBtn.textContent = '✓';
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyBtn.textContent = '📋'; copyTimer = null; }, 1500);
  });
  panel.querySelector('.speak')!.addEventListener('click', () => cbs.onSpeak(lastText));
  upBtn.addEventListener('click', () => { upBtn.classList.toggle('active'); downBtn.classList.remove('active'); });
  downBtn.addEventListener('click', () => { downBtn.classList.toggle('active'); upBtn.classList.remove('active'); });

  function clampPanel(x: number, y: number): { x: number; y: number } {
    const win = doc.defaultView;
    return clampPosition(x, y, panel.offsetWidth || 300, panel.offsetHeight || 160,
      win?.innerWidth ?? 1024, win?.innerHeight ?? 768);
  }

  function hidePanel(): void {
    panel.hidden = true;
    pinned = false;
    streaming = false;
    lastText = '';
    pinBtn.classList.remove('active');
    upBtn.classList.remove('active');
    downBtn.classList.remove('active');
    copyBtn.textContent = '📋';
    if (copyTimer !== null) { clearTimeout(copyTimer); copyTimer = null; }
  }

  return {
    host,
    showDot(x, y) {
      hidePanel();
      // 圆钮贴选区尾，可能落到视口外：夹一下，避免出现在屏幕外
      const win = doc.defaultView;
      const p = clampPosition(x, y, 26, 26, win?.innerWidth ?? 1024, win?.innerHeight ?? 768);
      host.style.left = `${p.x}px`;
      host.style.top = `${p.y}px`;
      dot.hidden = false;
      replayPop(dot);
    },
    hideDot() { dot.hidden = true; },
    isDotVisible: () => !dot.hidden,
    showPanel(x, y, model) {
      dot.hidden = true;
      streaming = false;
      modelEl.textContent = model;
      panel.hidden = false;
      const p = clampPanel(x, y);
      host.style.left = `${p.x}px`;
      host.style.top = `${p.y}px`;
      replayPop(panel);
    },
    setPanelState(state, text) {
      streaming = false;
      bodyEl.className = `body ${state}`;
      if (state === 'loading') {
        setLoading(doc, bodyEl);
      } else if (state === 'done') {
        lastText = text ?? '';
        bodyEl.textContent = lastText;
      } else {
        bodyEl.textContent = text ?? '翻译失败';
        const btn = doc.createElement('button');
        btn.setAttribute('data-sel-retry', '');
        btn.type = 'button';
        btn.textContent = '重试';
        btn.addEventListener('click', () => cbs.onRetry());
        bodyEl.appendChild(btn);
      }
      toggleScrollable();
    },
    appendPanelText(text) {
      if (panel.hidden || text === '') return;
      if (!streaming) {
        streaming = true;
        lastText = '';
        bodyEl.className = 'body streaming';
      }
      lastText += text;
      bodyEl.textContent = lastText;
      toggleScrollable();
    },
    hidePanel,
    isPinned: () => pinned,
    pathInside: (path) => path.includes(host),
    containsNode: (n) =>
      n !== null && (n === host || host.contains(n) || (host.shadowRoot?.contains(n) ?? false)),
    destroy() { if (copyTimer !== null) clearTimeout(copyTimer); host.remove(); },
  };
}
