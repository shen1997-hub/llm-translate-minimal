import {
  nextCatState, dockPoint, jumpKeyframes,
  type CatState, type CatEvent,
} from './cat-state';

const ALERT_MS = 300;
const HAPPY_MS = 600;
const IDLE_MS = 20_000;
const JUMP_MS = 420;
const RETURN_MS = 360;

const CAT_SVG = `
<svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
  <path class="tail" d="M33 31 q9 -2 7 -11" fill="none" stroke-width="3" stroke-linecap="round"/>
  <ellipse class="fur" cx="22" cy="31" rx="12" ry="9.5"/>
  <path class="fur ear-l" d="M13 15 l2.5 -7 l5.5 4 z"/>
  <path class="fur ear-r" d="M31 15 l-2.5 -7 l-5.5 4 z"/>
  <circle class="fur head" cx="22" cy="18" r="10"/>
  <circle class="eye eye-l" cx="18" cy="17" r="1.6"/>
  <circle class="eye eye-r" cx="26" cy="17" r="1.6"/>
  <circle class="blush" cx="14.5" cy="21" r="2"/>
  <circle class="blush" cx="29.5" cy="21" r="2"/>
  <path class="mouth" d="M20 21.5 q2 2 4 0" fill="none" stroke-width="1.2"/>
  <path class="scarf" d="M13.5 26 q8.5 4.5 17 0 l-2 5.5 q-6.5 3 -13 0 z"/>
  <ellipse class="fur paw" cx="30" cy="35" rx="4" ry="3"/>
  <text class="zzz" x="34" y="8" font-size="8">z</text>
</svg>
<span class="bubble">译？</span>`;

const CAT_CSS = `
.cat {
  position: fixed; left: 0; top: 0; width: 44px; height: 44px;
  border: none; background: none; padding: 0; margin: 0; cursor: pointer;
  pointer-events: auto; font: 12px/1.4 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.cat[hidden] { display: none; }
.cat svg { display: block; width: 44px; height: 44px; overflow: visible; }
.cat .fur { fill: #ffffff; stroke: #1f2328; stroke-width: 1.5; }
.cat .tail { stroke: #1f2328; transform-origin: 33px 31px; animation: cat-tail 2.4s ease-in-out infinite; }
.cat .eye { fill: #1f2328; transform-origin: center; transform-box: fill-box; animation: cat-blink 2.8s infinite; }
.cat .blush { fill: #fdeef4; }
.cat .mouth { stroke: #1f2328; }
.cat .scarf { fill: #e91e63; }
.cat .paw { transform-origin: 30px 35px; }
.cat .ear-l { transform-origin: 16px 12px; }
.cat .ear-r { transform-origin: 28px 12px; }
.cat .zzz { fill: #6a737d; opacity: 0; }
.bubble {
  position: absolute; left: 50%; top: -20px; transform: translateX(-50%);
  background: #fff; color: #c2185b; border: 1px solid #e4e7eb; border-radius: 8px;
  padding: 1px 7px; opacity: 0; pointer-events: none; white-space: nowrap;
}
.cat[data-state="beckon"] .bubble { opacity: 1; }
.cat[data-state="beckon"] .paw { animation: cat-paw 0.9s ease-in-out infinite; }
.cat[data-state="alert"] .ear-l { transform: rotate(-10deg); }
.cat[data-state="alert"] .ear-r { transform: rotate(10deg); }
.cat[data-state="happy"] .tail { animation-duration: 0.6s; }
.cat[data-state="sleep"] .eye { animation: none; transform: scaleY(0.12); }
.cat[data-state="sleep"] .zzz { opacity: 1; }
.cat[data-state="sleep"] .tail { animation-play-state: paused; }
@keyframes cat-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
@keyframes cat-tail { 0%, 100% { transform: rotate(-6deg); } 50% { transform: rotate(10deg); } }
@keyframes cat-paw { 0%, 100% { transform: rotate(0); } 50% { transform: rotate(-14deg); } }
@media (prefers-color-scheme: dark) {
  .cat .fur { fill: #e6e1e4; }
  .cat .tail, .cat .eye, .cat .mouth { stroke: #1f2328; }
  .cat .eye { fill: #1f2328; }
  .bubble { background: #1f2328; color: #f0a8c0; border-color: #343a40; }
  .cat .zzz { fill: #9aa2ab; }
}
@media (prefers-reduced-motion: reduce) {
  .cat .eye, .cat .tail, .cat .paw { animation: none; }
  .cat[data-state="beckon"] .bubble { opacity: 1; }
}
@media print {
  .cat { display: none; }
}
`;

export interface CatController {
  el: HTMLButtonElement;
  readonly state: CatState;
  send(e: CatEvent): void;
  dockNow(vw: number, vh: number): void;
  jumpTo(x: number, y: number): void;
  returnToDock(vw: number, vh: number): void;
  perchAt(x: number, y: number): void;
  destroy(): void;
}

export function createCat(doc: Document, opts: { reducedMotion: boolean; onClick(): void }): CatController {
  const el = doc.createElement('button');
  el.type = 'button';
  el.className = 'cat';
  el.setAttribute('aria-label', '翻译选中文字');
  el.innerHTML = CAT_SVG;
  const style = doc.createElement('style');
  style.textContent = CAT_CSS;
  el.prepend(style);

  let state: CatState = 'dock';
  let point = { x: 0, y: 0 };
  let alertTimer: ReturnType<typeof setTimeout> | null = null;
  let happyTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  function clearTimers(): void {
    if (alertTimer !== null) { clearTimeout(alertTimer); alertTimer = null; }
    if (happyTimer !== null) { clearTimeout(happyTimer); happyTimer = null; }
  }

  function armIdle(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!destroyed) api.send('idle-timeout'); }, IDLE_MS);
  }

  function apply(next: CatState): void {
    state = next;
    el.dataset.state = next;
    clearTimers();
    if (next === 'alert') alertTimer = setTimeout(() => { if (!destroyed) api.send('alert-done'); }, ALERT_MS);
    if (next === 'happy') happyTimer = setTimeout(() => { if (!destroyed) api.send('happy-done'); }, HAPPY_MS);
    armIdle();
  }

  function setPoint(p: { x: number; y: number }): void {
    point = p;
    el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  function canAnimate(): boolean {
    return !opts.reducedMotion && typeof el.animate === 'function';
  }

  function move(p: { x: number; y: number }, ms: number, frames: { transform: string; offset?: number }[], done: CatEvent): void {
    if (!canAnimate()) {
      setPoint(p);
      apply(nextCatState(state, done));
      return;
    }
    el.animate(frames, { duration: ms, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' });
    setPoint(p);
    const t = setTimeout(() => { if (!destroyed) apply(nextCatState(state, done)); }, ms);
    // 动画期间状态已切到 jump/return，done 事件由定时器在结束时派发
    void t;
  }

  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('pointerenter', () => {
    if (!destroyed && state === 'sleep') api.send('wake');
  });
  el.addEventListener('click', () => {
    if (destroyed) return;
    if (state === 'sleep') api.send('wake');
    api.send('click');
  });

  const api: CatController = {
    el,
    get state() { return state; },
    send(e) {
      if (destroyed) return;
      if (e === 'click') opts.onClick();
      const next = nextCatState(state, e);
      if (next === state && e !== 'wake') return;
      apply(next);
    },
    dockNow(vw, vh) {
      if (destroyed) return;
      setPoint(dockPoint(vw, vh));
      apply('dock');
    },
    jumpTo(x, y) {
      if (destroyed) return;
      apply('jump');
      move({ x, y }, JUMP_MS, jumpKeyframes(point, { x, y }), 'landed');
    },
    returnToDock(vw, vh) {
      if (destroyed) return;
      const target = dockPoint(vw, vh);
      apply('return');
      move(target, RETURN_MS, jumpKeyframes(point, target), 'return-done');
    },
    perchAt(x, y) {
      if (destroyed) return;
      setPoint({ x, y });
    },
    destroy() {
      destroyed = true;
      clearTimers();
      if (idleTimer !== null) clearTimeout(idleTimer);
      el.remove();
    },
  };
  apply('dock');
  return api;
}
