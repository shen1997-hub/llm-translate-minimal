# 侧缘猫咪助手 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 划词入口由圆钮升级为停靠视口右缘的动画猫咪：选中文字时猫跳到选区末位提示点击，点击打开现有翻译面板/词卡，设置可关回圆钮。

**Architecture:** 状态机抽为纯函数模块 `lib/renderer/cat-state.ts`；渲染与动画控制器在 `lib/renderer/cat.ts`（内联 SVG + shadow CSS + WAAPI，jsdom 无 WAAPI 时退化为直接定位，兼作 reduced-motion 路径）；`lib/renderer/selection.ts` 在 shadow 内挂载猫并按 `catMode` 路由 `showDot/hideDot/isDotVisible` 契约，`entrypoints/content.ts` 零结构改动（仅传入 catMode）。

**Tech Stack:** TypeScript、WXT、vitest（jsdom）、Playwright e2e、Web Animations API。

**Spec:** `docs/superpowers/specs/2026-09-24-cat-assistant-design.md`

## Global Constraints

- 猫为内联 SVG（约 2KB，无外部资源）；动画仅 `transform` / `opacity`。
- 停靠位 `position: fixed; right` 半露（可见宽约 26px），垂直位置见 Task 3 常量；不占布局、不遮正文。
- `prefers-reduced-motion: reduce`：jump/return 退化为 120ms 位移 + 淡入，无抛物线无 squash；beckon 气泡不循环闪动。
- 视觉令牌：身体奶白 `#ffffff`、描边墨色 `#1f2328` 1.5px、围巾品牌粉 `#e91e63`、腮红 `#fdeef4`；暗色模式身体 `#e6e1e4`、围巾保持品牌粉。
- 尺寸 44×44；`catMode` 默认 `true`；`selectionTranslate=false` 时猫与圆钮都不显示。
- 不改动面板/词卡视觉与行为；e2e 既有划词用例通过 `seedSettings` 基线 `catMode: false` 保持圆钮路径覆盖。
- 测试框架 vitest；命令 `npx vitest run`；e2e `npx playwright test`；构建 `npx wxt build`；类型 `npm run typecheck`。
- 提交信息用中文，格式 `type: 描述`。

---

### Task 1: 设置项 catMode 与设置页开关

**Files:**
- Modify: `lib/settings.ts`（interface 第 23 行附近、DEFAULTS 第 47 行附近）
- Modify: `entrypoints/options/index.html`（翻译偏好卡片内追加一行）
- Modify: `entrypoints/options/main.ts`（loadGlobals 与 save 回调）
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produces: `Settings.catMode: boolean`（默认 `true`）；设置页 `#catMode` checkbox。
- Consumes: 无前置任务产物。

- [ ] **Step 1: 写失败测试**

在 `tests/settings.test.ts` 末尾追加：

```ts
  it('catMode 默认 true 且可持久化往返', async () => {
    const s = await getSettings();
    expect(s.catMode).toBe(true);
    await saveSettings({ catMode: false });
    const s2 = await getSettings();
    expect(s2.catMode).toBe(false);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL（`catMode` 不存在于 Settings 类型 / 值 undefined）。

- [ ] **Step 3: 实现设置项**

`lib/settings.ts` interface 中 `selectionTranslate: boolean;` 一行之后追加：

```ts
  catMode: boolean;
```

DEFAULTS 中 `selectionTranslate: true,` 一行之后追加：

```ts
  catMode: true,
```

- [ ] **Step 4: 设置页开关**

`entrypoints/options/index.html` 的「翻译偏好」卡片内、`.row` div 之后追加：

```html
      <label class="check-row"><input type="checkbox" id="catMode"> 猫咪助手（划词时由猫咪提示点击）</label>
```

同文件 `<style>` 中 `.row { display: flex; gap: 12px; } .row > div { flex: 1; }` 一行之后追加：

```css
  .check-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 13.5px; font-weight: 500; }
  .check-row input { width: auto; height: auto; margin: 0; flex: none; }
```

`entrypoints/options/main.ts` 的 `loadGlobals` 中 `($('blacklist') as HTMLTextAreaElement).value = ...` 一行之前追加：

```ts
  ($('catMode') as HTMLInputElement).checked = s.catMode;
```

同文件 save 回调的对象字面量中 `blacklist: ...` 一行之前追加：

```ts
    catMode: ($('catMode') as HTMLInputElement).checked,
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run tests/settings.test.ts && npm run typecheck`
Expected: PASS；typecheck 无错误。

- [ ] **Step 6: Commit**

```bash
git add lib/settings.ts entrypoints/options/index.html entrypoints/options/main.ts tests/settings.test.ts
git commit -m "feat: 设置新增 catMode 开关（默认开）与设置页复选框"
```

---

### Task 2: 猫状态机纯模块

**Files:**
- Create: `lib/renderer/cat-state.ts`
- Test: `tests/cat-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CatState = 'dock' | 'sleep' | 'alert' | 'jump' | 'beckon' | 'happy' | 'return';
  export type CatEvent = 'select' | 'clear' | 'scroll-out' | 'alert-done' | 'landed'
    | 'click' | 'happy-done' | 'panel-closed' | 'return-done' | 'idle-timeout' | 'wake';
  export function nextCatState(state: CatState, event: CatEvent): CatState;
  export function dockPoint(vw: number, vh: number): { x: number; y: number };   // { x: vw - 26, y: vh - 72 }
  export function selectionAnchor(endX: number, endY: number): { x: number; y: number }; // 右下偏移 8px
  export function jumpKeyframes(from: {x:number;y:number}, to: {x:number;y:number}): { transform: string; offset?: number }[];
  ```

- [ ] **Step 1: 写失败测试**

创建 `tests/cat-state.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { nextCatState, dockPoint, selectionAnchor, jumpKeyframes } from '../lib/renderer/cat-state';

describe('nextCatState', () => {
  it('主路径 dock→alert→jump→beckon→happy→beckon', () => {
    let s = nextCatState('dock', 'select');
    expect(s).toBe('alert');
    s = nextCatState(s, 'alert-done');
    expect(s).toBe('jump');
    s = nextCatState(s, 'landed');
    expect(s).toBe('beckon');
    s = nextCatState(s, 'click');
    expect(s).toBe('happy');
    s = nextCatState(s, 'happy-done');
    expect(s).toBe('beckon');
  });

  it('return 路径：beckon/happy/jump 遇 clear 或 scroll-out 回 dock', () => {
    expect(nextCatState('beckon', 'clear')).toBe('return');
    expect(nextCatState('happy', 'panel-closed')).toBe('return');
    expect(nextCatState('jump', 'scroll-out')).toBe('return');
    expect(nextCatState('return', 'return-done')).toBe('dock');
  });

  it('sleep：idle-timeout 入睡，wake/select 唤醒', () => {
    expect(nextCatState('dock', 'idle-timeout')).toBe('sleep');
    expect(nextCatState('sleep', 'wake')).toBe('dock');
    expect(nextCatState('sleep', 'select')).toBe('alert');
  });

  it('未定义事件保持原态', () => {
    expect(nextCatState('dock', 'click')).toBe('dock');
    expect(nextCatState('beckon', 'wake')).toBe('beckon');
  });
});

describe('定位与关键帧', () => {
  it('dockPoint 停靠右缘底部', () => {
    expect(dockPoint(1280, 720)).toEqual({ x: 1254, y: 648 });
  });

  it('selectionAnchor 选区尾右下偏移 8px', () => {
    expect(selectionAnchor(300, 200)).toEqual({ x: 308, y: 208 });
  });

  it('jumpKeyframes 四帧：起、顶点拉伸、落地压扁、复原', () => {
    const kf = jumpKeyframes({ x: 100, y: 600 }, { x: 300, y: 200 });
    expect(kf).toHaveLength(4);
    expect(kf[0]!.transform).toContain('translate(100px, 600px)');
    expect(kf[1]!.offset).toBe(0.45);
    expect(kf[1]!.transform).toContain('scale(0.94, 1.08)');
    expect(kf[2]!.offset).toBe(0.85);
    expect(kf[2]!.transform).toContain('scale(1.06, 0.92)');
    expect(kf[3]!.transform).toContain('translate(300px, 200px) scale(1, 1)');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/cat-state.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

创建 `lib/renderer/cat-state.ts`：

```ts
export type CatState = 'dock' | 'sleep' | 'alert' | 'jump' | 'beckon' | 'happy' | 'return';

export type CatEvent =
  | 'select' | 'clear' | 'scroll-out' | 'alert-done' | 'landed'
  | 'click' | 'happy-done' | 'panel-closed' | 'return-done'
  | 'idle-timeout' | 'wake';

const TABLE: Record<CatState, Partial<Record<CatEvent, CatState>>> = {
  dock: { select: 'alert', 'idle-timeout': 'sleep' },
  sleep: { select: 'alert', wake: 'dock' },
  alert: { 'alert-done': 'jump', clear: 'dock', 'scroll-out': 'dock' },
  jump: { landed: 'beckon', clear: 'return', 'scroll-out': 'return' },
  beckon: { click: 'happy', clear: 'return', 'scroll-out': 'return' },
  happy: { 'happy-done': 'beckon', 'panel-closed': 'return', clear: 'return', 'scroll-out': 'return' },
  return: { 'return-done': 'dock', select: 'alert' },
};

export function nextCatState(state: CatState, event: CatEvent): CatState {
  return TABLE[state][event] ?? state;
}

// 停靠右缘：44px 宽的猫右移 18px 只露头（可见 26px），垂直贴近视口底部避免遮挡正文拖选
export function dockPoint(vw: number, vh: number): { x: number; y: number } {
  return { x: vw - 26, y: vh - 72 };
}

export function selectionAnchor(endX: number, endY: number): { x: number; y: number } {
  return { x: endX + 8, y: endY + 8 };
}

// 抛物线近似：顶点抬高 60px；起跳拉伸、落地压扁（squash & stretch）
export function jumpKeyframes(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { transform: string; offset?: number }[] {
  const apexY = Math.min(from.y, to.y) - 60;
  return [
    { transform: `translate(${from.x}px, ${from.y}px) scale(1, 1)` },
    { transform: `translate(${Math.round((from.x + to.x) / 2)}px, ${apexY}px) scale(0.94, 1.08)`, offset: 0.45 },
    { transform: `translate(${to.x}px, ${to.y}px) scale(1.06, 0.92)`, offset: 0.85 },
    { transform: `translate(${to.x}px, ${to.y}px) scale(1, 1)` },
  ];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/cat-state.test.ts`
Expected: PASS 7 个用例。

- [ ] **Step 5: Commit**

```bash
git add lib/renderer/cat-state.ts tests/cat-state.test.ts
git commit -m "feat: 猫咪状态机纯模块（五态转移/停靠点/抛物线关键帧）"
```

---

### Task 3: 猫渲染器（SVG + 动画控制器）

**Files:**
- Create: `lib/renderer/cat.ts`
- Test: `tests/cat.test.ts`

**Interfaces:**
- Consumes: `CatState/CatEvent/nextCatState/dockPoint/jumpKeyframes`（Task 2）。
- Produces:
  ```ts
  export interface CatController {
    el: HTMLButtonElement;
    readonly state: CatState;
    send(e: CatEvent): void;          // 外部事件入口：转移状态并应用视觉/定时器
    dockNow(vw: number, vh: number): void;  // 立即落到停靠位（无动画）
    jumpTo(x: number, y: number): void;     // 视口坐标；进入 jump，结束自动 landed
    returnToDock(vw: number, vh: number): void;
    perchAt(x: number, y: number): void;    // 趴到面板顶边（视口坐标，无动画）
    destroy(): void;
  }
  export function createCat(doc: Document, opts: { reducedMotion: boolean; onClick(): void }): CatController;
  ```
- 行为约定：进入 `alert` 后 300ms 自动 `send('alert-done')`；进入 `happy` 后 600ms 自动 `send('happy-done')`；`dock`/`sleep` 态 20s 无事件自动 `idle-timeout`（sleep 由 dock 转入）；任一 `send` 重置 idle 计时。无 `el.animate`（jsdom）或 `reducedMotion` 时：jump/return 直接设置 transform 并同步派发 `landed`/`return-done`。

- [ ] **Step 1: 写失败测试**

创建 `tests/cat.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { createCat } from '../lib/renderer/cat';

function make() {
  const onClick = vi.fn();
  const cat = createCat(document, { reducedMotion: true, onClick });
  return { cat, onClick };
}

describe('createCat', () => {
  it('初始为 dock 态且带品牌围巾 SVG', () => {
    const { cat } = make();
    expect(cat.state).toBe('dock');
    expect(cat.el.tagName).toBe('BUTTON');
    expect(cat.el.dataset.state).toBe('dock');
    expect(cat.el.querySelector('svg .scarf')).not.toBeNull();
  });

  it('reducedMotion 下 jumpTo 同步落地为 beckon 且 transform 到位', () => {
    const { cat } = make();
    cat.dockNow(1280, 720);
    cat.send('select');
    expect(cat.state).toBe('alert');
    cat.jumpTo(300, 200);
    expect(cat.state).toBe('beckon');
    expect(cat.el.style.transform).toContain('translate(300px, 200px)');
  });

  it('click 事件经 onClick 回调且状态进 happy', () => {
    const { cat, onClick } = make();
    cat.send('select');
    cat.jumpTo(10, 10);
    cat.send('click');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(cat.state).toBe('happy');
  });

  it('return 回 dock：reducedMotion 同步完成', () => {
    const { cat } = make();
    cat.send('select');
    cat.jumpTo(10, 10);
    cat.send('clear');
    expect(cat.state).toBe('return');
    cat.returnToDock(1280, 720);
    expect(cat.state).toBe('dock');
  });

  it('destroy 清理定时器且不再响应', () => {
    const { cat } = make();
    cat.destroy();
    expect(() => cat.send('select')).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/cat.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现渲染器**

创建 `lib/renderer/cat.ts`：

```ts
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
  el.addEventListener('click', () => { if (!destroyed) api.send('click'); });

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
```

注意：`move` 中非动画分支直接 `apply(done 后状态)`；动画分支用 setTimeout 在 ms 后派发。`apply('jump')` 会 clearTimers 但不影响 move 的局部 setTimeout（它不是 alert/happy 定时器）。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/cat.test.ts`
Expected: PASS 5 个用例。

- [ ] **Step 5: Commit**

```bash
git add lib/renderer/cat.ts tests/cat.test.ts
git commit -m "feat: 猫咪渲染器（内联 SVG/状态动画控制器/reduced-motion 退化）"
```

---

### Task 4: selection.ts 接入猫（catMode 路由 + 面板趴顶 + 滚出回收）

**Files:**
- Modify: `lib/renderer/selection.ts`
- Test: `tests/selection.test.ts`

**Interfaces:**
- Consumes: `createCat/CatController`（Task 3）、`dockPoint/selectionAnchor`（Task 2）。
- Produces: `SelUI` 新增 `setCatMode(on: boolean): void`；`showDot/hideDot/isDotVisible` 契约不变（catMode 时由猫履行）。

- [ ] **Step 1: 写失败测试**

在 `tests/selection.test.ts` 末尾追加（沿用该文件既有的 `makeUI()` 夹具，返回 `{ ui, cbs }`）：

```ts
  it('catMode：showDot 由猫履行，圆钮保持隐藏', () => {
    const { ui, cbs } = makeUI();
    void cbs;
    ui.setCatMode(true);
    ui.showDot(120, 80);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    const dot = ui.host.shadowRoot!.querySelector<HTMLElement>('.dot')!;
    expect(cat.hidden).toBe(false);
    expect(dot.hidden).toBe(true);
    expect(ui.isDotVisible()).toBe(true);
    expect(cat.dataset.state).not.toBe('dock');
  });

  it('catMode：hideDot 让猫回停靠且 isDotVisible 为 false', () => {
    const { ui } = makeUI();
    ui.setCatMode(true);
    ui.showDot(120, 80);
    ui.hideDot();
    expect(ui.isDotVisible()).toBe(false);
  });

  it('catMode：点击猫触发 onDotClick', () => {
    const { ui, cbs } = makeUI();
    ui.setCatMode(true);
    ui.showDot(120, 80);
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    cat.click();
    expect(cbs.onDotClick).toHaveBeenCalled();
  });

  it('catMode=false：回圆钮路径', () => {
    const { ui } = makeUI();
    ui.setCatMode(false);
    ui.showDot(120, 80);
    const dot = ui.host.shadowRoot!.querySelector<HTMLElement>('.dot')!;
    const cat = ui.host.shadowRoot!.querySelector<HTMLElement>('.cat')!;
    expect(dot.hidden).toBe(false);
    expect(cat.hidden).toBe(true);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/selection.test.ts`
Expected: FAIL（setCatMode 不存在）。

- [ ] **Step 3: 实现接入**

`lib/renderer/selection.ts` 顶部 import 追加：

```ts
import { createCat, type CatController } from './cat';
import { dockPoint, selectionAnchor } from './cat-state';
```

`SelUI` interface 中 `isDotVisible(): boolean;` 之后追加：

```ts
  /** 猫咪助手开关：true 时划词入口由猫履行，false 回简洁圆钮 */
  setCatMode(on: boolean): void;
```

`createSelectionUI` 内 `shadow.append(style, dot, panel);` 一行改为：

```ts
  const cat = createCat(doc, {
    reducedMotion: doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false,
    onClick: () => cbs.onDotClick(),
  });
  cat.el.hidden = true;
  shadow.append(style, dot, cat.el, panel);
```

在 `let copyTimer ...` 声明区追加：

```ts
  let catMode = false;
  let catOut = false;
  let catAnchor = { x: 0, y: 0 }; // 视口坐标，供滚出检测
```

在 `clampToViewport` 函数之后追加：

```ts
  function viewportOf(docX: number, docY: number): { x: number; y: number } {
    const win = doc.defaultView;
    return { x: docX - (win?.scrollX ?? 0), y: docY - (win?.scrollY ?? 0) };
  }

  function catReturn(): void {
    const win = doc.defaultView;
    cat.returnToDock(win?.innerWidth ?? 1024, win?.innerHeight ?? 768);
  }

  // 选区滚出视口：猫回停靠，不追着跑
  function onScroll(): void {
    if (!catMode || !catOut) return;
    const win = doc.defaultView;
    const vw = win?.innerWidth ?? 1024;
    const vh = win?.innerHeight ?? 768;
    if (catAnchor.x < 0 || catAnchor.x > vw || catAnchor.y < 0 || catAnchor.y > vh) {
      catOut = false;
      catReturn();
    }
  }
  doc.addEventListener('scroll', onScroll, { passive: true });
```

修改返回对象中的三个方法并新增 setCatMode：

```ts
    showDot(x, y) {
      hidePanel();
      if (catMode) {
        const p = clampToViewport(x, y, 44, 44);
        const v = viewportOf(p.x, p.y);
        // content 传入坐标已含 +6 入口偏移；selectionAnchor 再 +8 前先扣回，净偏移 8px（spec §2）
        catAnchor = selectionAnchor(v.x - 6, v.y - 6);
        cat.send('select');
        cat.jumpTo(catAnchor.x, catAnchor.y);
        catOut = true;
        cat.el.hidden = false;
        return;
      }
      const p = clampToViewport(x, y, 26, 26);
      host.style.left = `${p.x}px`;
      host.style.top = `${p.y}px`;
      dot.hidden = false;
      replayPop(dot);
    },
    hideDot() {
      dot.hidden = true;
      if (catMode && catOut) {
        catOut = false;
        cat.send('clear');
        catReturn();
      }
    },
    isDotVisible: () => (catMode ? catOut : !dot.hidden),
    setCatMode(on) {
      catMode = on;
      cat.el.hidden = !on;
      if (on) {
        const win = doc.defaultView;
        cat.dockNow(win?.innerWidth ?? 1024, win?.innerHeight ?? 768);
      } else {
        catOut = false;
      }
    },
```

`showPanel` 开头 `dot.hidden = true;` 之后追加：

```ts
      if (catMode && catOut) {
        catOut = false;
        cat.send('panel-closed');
      }
```

并在 `showPanel` 末尾 `replayPop(panel);` 之后追加（猫趴面板顶边右角）：

```ts
      if (catMode) {
        const v = viewportOf(p.x, p.y);
        cat.perchAt(Math.max(8, v.x + (panel.offsetWidth || 340) - 40), Math.max(8, v.y - 30));
        cat.el.hidden = false;
      }
```

`hidePanel` 函数末尾追加：

```ts
    if (catMode) {
      catReturn();
      cat.el.hidden = false;
    }
```

`destroy()` 改为：

```ts
    destroy() {
      if (copyTimer !== null) clearTimeout(copyTimer);
      doc.removeEventListener('scroll', onScroll);
      cat.destroy();
      host.remove();
    },
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/selection.test.ts && npm run typecheck`
Expected: PASS（含既有用例）；typecheck 无错误。

- [ ] **Step 5: Commit**

```bash
git add lib/renderer/selection.ts tests/selection.test.ts
git commit -m "feat: 划词入口接入猫咪（catMode 路由/面板趴顶/滚出回收）"
```

---

### Task 5: content.ts 传入 catMode

**Files:**
- Modify: `entrypoints/content.ts`

**Interfaces:**
- Consumes: `SelUI.setCatMode`（Task 4）、`getSettings`。

- [ ] **Step 1: 接线**

`entrypoints/content.ts` 的 `initSelectionTranslate` 中创建 `selUI` 之后追加：

```ts
  void getSettings().then((s) => selUI?.setCatMode(s.catMode)).catch(() => { /* 上下文失效：忽略 */ });
```

同函数 mouseup 处理中 `if (!s.selectionTranslate) return;` 一行之后追加：

```ts
      selUI.setCatMode(s.catMode);
```

- [ ] **Step 2: 验证**

Run: `npx vitest run && npm run typecheck && npx wxt build`
Expected: 全绿；构建成功。

- [ ] **Step 3: Commit**

```bash
git add entrypoints/content.ts
git commit -m "feat: 内容脚本按设置启用猫咪助手"
```

---

### Task 6: e2e 覆盖猫咪链路

**Files:**
- Modify: `e2e/helpers.ts`（seedSettings 基线加 `catMode: false`）
- Create: `e2e/cat.spec.ts`

**Interfaces:**
- Consumes: 既有 e2e 设施（`openDriver/openTestPage/sendToTestPage/seedSettings`、`SEL`、`HOST`）。

- [ ] **Step 1: 基线保持圆钮**

`e2e/helpers.ts` 的 `seedSettings` 默认设置对象中追加 `catMode: false`（既有划词用例继续覆盖圆钮路径，不被猫替换）。

- [ ] **Step 2: 新增猫咪用例**

创建 `e2e/cat.spec.ts`：

```ts
import { test, expect } from './fixtures';
import { SEL, openDriver, openTestPage, seedSettings, stubControl } from './helpers';

test.beforeEach(async ({ context, extensionId, request }) => {
  await stubControl(request, 'reset=1');
  await seedSettings(context, extensionId, { catMode: true });
});

test('选中文字：猫跳到选区尾，不遮正文', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  const cat = page.locator(`${SEL} .cat`);
  await expect(cat).toBeVisible({ timeout: 10_000 });
  // 落在选区尾附近（jsdom 之外的真实布局：第一段尾约在正文右缘）
  const catBox = (await cat.boundingBox())!;
  const pBox = (await page.locator('article p').first().boundingBox())!;
  expect(catBox.y).toBeGreaterThan(pBox.y - 40);
  expect(catBox.y).toBeLessThan(pBox.y + pBox.height + 60);
  // 不遮正文：猫在正文右缘之外
  const articleBox = (await page.locator('article').boundingBox())!;
  expect(catBox.x).toBeGreaterThan(articleBox.x + articleBox.width - 8);
});

test('点击猫打开翻译面板并显示译文', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  const cat = page.locator(`${SEL} .cat`);
  await expect(cat).toBeVisible({ timeout: 10_000 });
  await cat.click();
  const panel = page.locator(`${SEL} .panel`);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('译文', { timeout: 15_000 });
});

test('catMode=false：回圆钮且行为不变', async ({ context, extensionId }) => {
  await seedSettings(context, extensionId, { catMode: false });
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  const dot = page.locator(`${SEL} .dot`);
  await expect(dot).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`${SEL} .cat`)).toBeHidden();
  await dot.click();
  await expect(page.locator(`${SEL} .panel`)).toContainText('译文', { timeout: 15_000 });
});

test('选区清空后猫回停靠位', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  const cat = page.locator(`${SEL} .cat`);
  await expect(cat).toBeVisible({ timeout: 10_000 });
  const outBox = (await cat.boundingBox())!;

  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await page.mouse.click(640, 60);
  await page.waitForTimeout(800);
  const dockBox = (await cat.boundingBox())!;
  expect(dockBox.x).not.toBe(outBox.x);
  // 停靠位贴近视口右缘
  expect(dockBox.x).toBeGreaterThan(1200);
});
```

- [ ] **Step 3: 运行 e2e**

Run: `npx wxt build && npx playwright test`
Expected: 全部通过（既有 19 + 新增 4）。若猫落点断言因布局抖动失败，允许把 y 范围放宽 ±20px，但"不遮正文"与"停靠右缘"两条断言不得放宽。

- [ ] **Step 4: Commit**

```bash
git add e2e/helpers.ts e2e/cat.spec.ts
git commit -m "test: e2e 覆盖猫咪落点/点击翻译/关猫回圆钮/选区清空回停靠"
```

---

### Task 7: 全量验证与截图自审

**Files:** 无新增。

- [ ] **Step 1: 全量验证**

Run: `npx vitest run && npm run typecheck && npx wxt build && npx playwright test`
Expected: 全绿。

- [ ] **Step 2: 截图自审**

用 Playwright 持久化上下文加载 `.output/chrome-mv3`，在测试页触发选区后对含猫的视口截图（dock 态与 beckon 态各一张），检查：猫不遮正文、围巾为品牌粉、气泡文案为「译？」、暗色模式身体色正确。发现问题当轮修复并重截。

- [ ] **Step 3: 记录**

把截图路径与自审结论写入提交信息正文或 PR 描述；不新增仓库文件。
