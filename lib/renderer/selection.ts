import { MOTION_CSS, replayPop, setLoading } from './motion';
import type { WordEntry } from '../translation/prompt';

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
  /** 词典模式：结构化渲染单词卡片（音标/义项/关联词/语境） */
  showWordCard(entry: WordEntry): void;
  hidePanel(): void;
  isPinned(): boolean;
  pathInside(path: EventTarget[]): boolean;
  /** 节点是否属于本 UI（含 Shadow DOM 内部）：用于忽略浮窗内的选区变化 */
  containsNode(node: Node | null): boolean;
  destroy(): void;
}

/** 词典卡片的复制纯文本：单词+音标+义项+关联词+语境逐行 */
export function formatWordEntryText(entry: WordEntry): string {
  const lines: string[] = [];
  lines.push(entry.phonetic ? `${entry.word} ${entry.phonetic}` : entry.word);
  for (const s of entry.senses) lines.push(`${s.pos} ${s.meaning}`);
  if (entry.related.length > 0) lines.push(`关联词：${entry.related.map(r => `${r.word}(${r.note})`).join('，')}`);
  if (entry.contextual !== '') lines.push(`本句中：${entry.contextual}`);
  return lines.join('\n');
}

export function clampPosition(x: number, y: number, w: number, h: number, vw: number, vh: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, vw - w - 8)),
    y: Math.max(8, Math.min(y, vh - h - 8)),
  };
}

// 注意：.dot/.panel 的 display 会覆盖 UA 的 [hidden]{display:none}，必须显式补 [hidden] 规则
const SHADOW_CSS = `
/* 宿主元素自身也要让开鼠标：面板设了 pointer-events:none 只挡住它自己，
   host 是覆盖同一块区域的可见元素，命中测试仍会落到 host 上——实测 elementFromPoint
   返回的就是 host，于是「从浮窗上方起手拖拽」依旧选不中正文。 */
:host { position: absolute; left: 0; top: 0; z-index: 2147483647; pointer-events: none; }
.dot[hidden], .panel[hidden] { display: none; }
.dot {
  pointer-events: auto;
  width: 26px; height: 26px; border-radius: 50%; border: none; cursor: pointer; padding: 0;
  background: #e91e63; color: #fff; font-size: 13px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 10px rgba(233, 30, 99, 0.35);
}
.panel {
  width: 340px; border-radius: 10px; background: #fff; color: #1f2328;
  box-shadow: 0 8px 24px rgba(31, 35, 40, 0.16);
  font: 13.5px/1.6 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  overflow: hidden; pointer-events: none;
}
.panel button { pointer-events: auto; }
.header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #e4e7eb; }
.logo { width: 20px; height: 20px; border-radius: 6px; background: #e91e63; color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
.model { flex: 1; font-size: 12px; color: #6a737d; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header button { border: none; background: none; cursor: pointer; font-size: 13px; color: #6a737d; padding: 2px 4px; }
.header button.active { color: #c2185b; }
.body { padding: 10px 12px; min-height: 24px; max-height: 240px; overflow-y: auto; white-space: pre-wrap; }
.body.loading { color: #6a737d; }
.body.error { color: #c62828; }
/* 长译文溢出时才恢复滚动：短译文完全让开鼠标 */
.body.scrollable { pointer-events: auto; }
.body button[data-sel-retry] { margin-left: 8px; cursor: pointer; border: 1px solid #c62828;
  background: transparent; color: #c62828; border-radius: 6px; padding: 1px 8px; font-size: 12px; }
.word-head { display: flex; align-items: baseline; gap: 8px; padding-bottom: 4px; }
.word-head .w { font-size: 17px; font-weight: 700; }
.word-head .phonetic { color: #6a737d; font-size: 12.5px; }
.word-section { padding: 4px 0; }
.word-section + .word-section { border-top: 1px solid #e4e7eb; }
.sec-title { font-size: 11.5px; color: #6a737d; margin-bottom: 2px; }
.sense { display: flex; gap: 6px; }
.sense .pos { color: #c2185b; font-style: italic; min-width: 32px; }
.related-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { background: #fdeef4; color: #c2185b; border-radius: 8px; padding: 1px 8px; font-size: 12px; }
.contextual { background: #fdf3f7; border-radius: 8px; padding: 6px 8px; }
.footer { display: flex; gap: 4px; padding: 6px 10px; border-top: 1px solid #e4e7eb; }
.footer button { border: none; background: none; cursor: pointer; font-size: 14px; padding: 2px 6px; opacity: 0.7; }
.footer button.active { opacity: 1; }
${MOTION_CSS}
@media (prefers-color-scheme: dark) {
  .panel { background: #1f2328; color: #e6e1e4; }
  .header, .footer { border-color: #343a40; }
  .word-section + .word-section { border-color: #343a40; }
  .model, .header button, .body.loading, .sec-title, .word-head .phonetic { color: #9aa2ab; }
  .chip { background: #33262c; color: #f0a8c0; }
  .contextual { background: #2a2026; }
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
  let speakText = ''; // 词典卡片朗读单词本身；为空则朗读 lastText
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
  panel.querySelector('.speak')!.addEventListener('click', () => cbs.onSpeak(speakText || lastText));
  upBtn.addEventListener('click', () => { upBtn.classList.toggle('active'); downBtn.classList.remove('active'); });
  downBtn.addEventListener('click', () => { downBtn.classList.toggle('active'); upBtn.classList.remove('active'); });

  // 调用方传入的是文档坐标（含滚动偏移），而夹取边界是视口尺寸：
  // 先换算成视口坐标夹取，再折算回文档坐标，否则页面滚动后会被错误地夹回页面顶部
  function clampToViewport(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const win = doc.defaultView;
    const sx = win?.scrollX ?? 0;
    const sy = win?.scrollY ?? 0;
    const p = clampPosition(x - sx, y - sy, w, h, win?.innerWidth ?? 1024, win?.innerHeight ?? 768);
    return { x: p.x + sx, y: p.y + sy };
  }

  function clampPanel(x: number, y: number): { x: number; y: number } {
    return clampToViewport(x, y, panel.offsetWidth || 340, panel.offsetHeight || 160);
  }

  function hidePanel(): void {
    panel.hidden = true;
    pinned = false;
    streaming = false;
    lastText = '';
    speakText = '';
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
      const p = clampToViewport(x, y, 26, 26);
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
      speakText = '';
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
    showWordCard(entry) {
      streaming = false;
      lastText = formatWordEntryText(entry);
      speakText = entry.word;
      bodyEl.className = 'body';
      bodyEl.textContent = '';
      const head = doc.createElement('div');
      head.className = 'word-head';
      const w = doc.createElement('span');
      w.className = 'w';
      w.textContent = entry.word;
      head.appendChild(w);
      if (entry.phonetic) {
        const p = doc.createElement('span');
        p.className = 'phonetic';
        p.textContent = entry.phonetic;
        head.appendChild(p);
      }
      bodyEl.appendChild(head);
      if (entry.senses.length > 0) {
        const sec = doc.createElement('div');
        sec.className = 'word-section';
        for (const s of entry.senses) {
          const row = doc.createElement('div');
          row.className = 'sense';
          const pos = doc.createElement('span');
          pos.className = 'pos';
          pos.textContent = s.pos;
          const meaning = doc.createElement('span');
          meaning.textContent = s.meaning;
          row.append(pos, meaning);
          sec.appendChild(row);
        }
        bodyEl.appendChild(sec);
      }
      if (entry.related.length > 0) {
        const sec = doc.createElement('div');
        sec.className = 'word-section';
        const title = doc.createElement('div');
        title.className = 'sec-title';
        title.textContent = '关联词';
        const chips = doc.createElement('div');
        chips.className = 'related-chips';
        for (const r of entry.related) {
          const chip = doc.createElement('span');
          chip.className = 'chip';
          chip.textContent = `${r.word} ${r.note}`;
          chips.appendChild(chip);
        }
        sec.append(title, chips);
        bodyEl.appendChild(sec);
      }
      if (entry.contextual !== '') {
        const sec = doc.createElement('div');
        sec.className = 'word-section';
        const title = doc.createElement('div');
        title.className = 'sec-title';
        title.textContent = '本句中';
        const box = doc.createElement('div');
        box.className = 'contextual';
        box.textContent = entry.contextual;
        sec.append(title, box);
        bodyEl.appendChild(sec);
      }
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
