// 两个渲染器（整页 host、划词浮窗）各自持有 Shadow CSS，这里提供共享的关键帧与 DOM 助手，
// 避免同一套动画在两处各写一遍、日后改一处漏一处。
export const MOTION_CSS = `
.dots { display: inline-flex; gap: 3px; margin-left: 3px; vertical-align: middle; }
.dots i { display: block; width: 4px; height: 4px; border-radius: 50%; background: currentColor;
  animation: dots-pulse 1s ease-in-out infinite; }
.dots i:nth-child(2) { animation-delay: 0.2s; }
.dots i:nth-child(3) { animation-delay: 0.4s; }
@keyframes dots-pulse {
  0%, 60%, 100% { opacity: 0.25; transform: scale(0.75); }
  30% { opacity: 1; transform: scale(1); }
}
.body.streaming::after { content: ''; display: inline-block; width: 2px; height: 1em; margin-left: 2px;
  vertical-align: -0.15em; background: currentColor; animation: caret-blink 1s steps(1) infinite; }
@keyframes caret-blink { 50% { opacity: 0; } }
.pop { animation: pop-in 120ms ease-out; }
@keyframes pop-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .dots i, .body.streaming::after, .pop { animation: none; }
  .dots i { opacity: 0.6; }
}`;

export function createDots(doc: Document): HTMLElement {
  const wrap = doc.createElement('span');
  wrap.className = 'dots';
  for (let i = 0; i < 3; i++) wrap.appendChild(doc.createElement('i'));
  return wrap;
}

/** 等待态内容：文案 + 三点。三点自身无文本，textContent 仍是纯文案 */
export function setLoading(doc: Document, body: HTMLElement, label = '翻译中…'): void {
  body.textContent = label;
  body.appendChild(createDots(doc));
}

/** 重播入场动画：CSS 动画只在类名从无到有时跑一次，必须先摘掉并强制回流 */
export function replayPop(el: HTMLElement): void {
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}