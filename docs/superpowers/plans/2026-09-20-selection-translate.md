# 划词翻译浮窗 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户选中网页文本后出现小圆钮，点击弹出翻译浮窗（译文/朗读/复制/重试），复用现有 Port + scheduler 翻译通道。

**Architecture:** 协议层给 `TranslateRequest` 加可选 `targetLang`（双语向覆盖）；scheduler 用它覆盖 `settings.targetLang`；新建 `lib/renderer/selection.ts`（Shadow DOM 圆钮 + 浮窗，主色 #e91e63）；content script 监听 mouseup/mousedown/Esc 并复用 `postToPort` 发 `sel-` 前缀请求，响应按 taskId 前缀分流；popup 加「划词翻译」开关。background 零改动。

**Tech Stack:** TypeScript + WXT + Vitest(jsdom) + Playwright。无新依赖、无 manifest 变更。

## Global Constraints

- `verbatimModuleSyntax`：类型导入必须写 `import type` 或 `import { type X }`；值导入与类型导入不能混写在无 `type` 修饰的同一语句。
- `noUncheckedIndexedAccess`：数组/Record 下标访问结果为 `T | undefined`，必要时用 `!` 或先判空。
- 不新增依赖、不改 `wxt.config.ts`/manifest、不动 `entrypoints/background.ts`（消息透传已支持）。
- `entrypoints/content.ts` 与 `entrypoints/background.ts` 中带 `// [diag]` 标记的临时日志**保留不动**。
- 浮窗主色沿用 popup 的 `#e91e63`；全部样式封在 Shadow DOM 内。
- 验证命令：`npm test`、`npm run typecheck`、`npm run build`、`npm run e2e`（E2E 前先 build）。
- 现有基线：91 单测 + 4 E2E 全绿，任何任务不得破坏。

## File Structure

- `lib/messaging/protocol.ts`（修改）：`TranslateRequest` 增加 `targetLang?: string`
- `lib/settings.ts`（修改）：`Settings` 增加 `selectionTranslate: boolean`，默认 `true`
- `lib/translation/scheduler.ts`（修改）：`const targetLang = req.targetLang ?? settings.targetLang`，cacheKey 与 translate 均使用
- `lib/renderer/selection.ts`（新建）：圆钮 + 浮窗 Shadow DOM 渲染器，导出 `SEL_HOST_ATTR` / `SelUICallbacks` / `SelUI` / `createSelectionUI` / `clampPosition`
- `entrypoints/content.ts`（修改）：选区监听、请求构造与响应分流、isSelfMutation/clearAll 适配
- `entrypoints/popup/index.html` + `entrypoints/popup/main.ts`（修改）：「划词翻译」开关行
- `tests/settings.test.ts`（修改）：默认值断言
- `tests/scheduler.test.ts`（修改）：targetLang 覆盖与回退
- `tests/selection.test.ts`（新建）：渲染器单测
- `e2e/translate.spec.ts`（修改）：追加划词 E2E

---

### Task 1: 协议 targetLang 字段 + settings.selectionTranslate

**Files:**
- Modify: `lib/messaging/protocol.ts:8-13`
- Modify: `lib/settings.ts:10-26`（接口）、`lib/settings.ts:33-46`（DEFAULT_SETTINGS）
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `TranslateRequest.targetLang?: string`（逐请求目标语言覆盖；Task 2/4 使用）
  - `Settings.selectionTranslate: boolean`（Task 4 读取、Task 5 读写）
  - `DEFAULT_SETTINGS.selectionTranslate === true`

- [ ] **Step 1: 写失败测试**

在 `tests/settings.test.ts` 的 `describe('默认值与读写')` 内追加：

```ts
  it('默认 selectionTranslate 为 true，且可读写', async () => {
    const s = await getSettings();
    expect(s.selectionTranslate).toBe(true);
    await saveSettings({ selectionTranslate: false });
    expect((await getSettings()).selectionTranslate).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL —— `selectionTranslate` 为 undefined / TS 报错（属性不存在）

- [ ] **Step 3: 最小实现**

`lib/settings.ts` 接口 `Settings` 中，在 `cjkRatioThreshold: number;` 之后加一行：

```ts
  selectionTranslate: boolean;
```

`DEFAULT_SETTINGS` 中在 `cjkRatioThreshold: 0.3,` 之后加一行：

```ts
  selectionTranslate: true,
```

`lib/messaging/protocol.ts` 的 `TranslateRequest` 改为：

```ts
export interface TranslateRequest {
  kind: 'translate';
  taskId: string;
  chunkId: string;
  units: UnitPayload[];
  /** 逐请求目标语言覆盖（划词双语向）；缺省用 settings.targetLang */
  targetLang?: string;
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run tests/settings.test.ts && npm run typecheck`
Expected: PASS。注意：`tests/scheduler.test.ts` 的 `makeDeps` 用 `as unknown as SchedulerDeps` 强转，缺新字段不报错；若 typecheck 报其他文件缺 `selectionTranslate`，在对应字面量补 `selectionTranslate: true`。

- [ ] **Step 5: 全量单测 + Commit**

Run: `npm test`
Expected: 全绿

```bash
git add lib/messaging/protocol.ts lib/settings.ts tests/settings.test.ts
git commit -m "feat: 协议 targetLang 覆盖字段与 selectionTranslate 设置项"
```

---

### Task 2: scheduler 支持 targetLang 覆盖

**Files:**
- Modify: `lib/translation/scheduler.ts:16-41`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `TranslateRequest.targetLang?: string`（Task 1）
- Produces: `handleTranslateRequest` 行为变更——cacheKey 与 `translate` 调用的 targetLang 均为 `req.targetLang ?? settings.targetLang`（Task 4 的划词请求依赖 English 方向与默认方向缓存分离）

- [ ] **Step 1: 写失败测试**

在 `tests/scheduler.test.ts` 的 `describe('handleTranslateRequest')` 末尾追加：

```ts
  it('req.targetLang 覆盖：translate 与 cacheKey 均用覆盖值', async () => {
    const deps = makeDeps();
    await handleTranslateRequest({ ...REQ, targetLang: 'English' }, deps);
    const call = (deps.translate as any).mock.calls[0];
    expect(call[2].targetLang).toBe('English');
    const { cacheKey } = await import('../lib/cache/store');
    const { PROMPT_VERSION } = await import('../lib/translation/prompt');
    expect(deps.getCached).toHaveBeenCalledWith(cacheKey('Hello world.', PROMPT_VERSION, 'm1', 'English'));
  });

  it('缺省 targetLang 回退 settings.targetLang', async () => {
    const deps = makeDeps();
    await handleTranslateRequest(REQ, deps);
    const call = (deps.translate as any).mock.calls[0];
    expect(call[2].targetLang).toBe('中文');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: FAIL —— 第一条断言 `call[2].targetLang` 实际为 `'中文'`

- [ ] **Step 3: 最小实现**

`lib/translation/scheduler.ts`：在 `const cfg: LlmConfig = ...` 之后、`const texts = ...` 之前插入一行，并改两处引用：

```ts
  const targetLang = req.targetLang ?? settings.targetLang;
```

```ts
  const keys = texts.map(t => cacheKey(t, PROMPT_VERSION, cfg.model, targetLang));
```

translate 调用的参数对象里 `targetLang: settings.targetLang,` 改为：

```ts
        targetLang,
```

（其余行不动。）

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run tests/scheduler.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/translation/scheduler.ts tests/scheduler.test.ts
git commit -m "feat: scheduler 支持逐请求 targetLang 覆盖（缓存按方向分离）"
```

---

### Task 3: selection.ts 划词浮窗渲染器

**Files:**
- Create: `lib/renderer/selection.ts`
- Test: `tests/selection.test.ts`（新建）

**Interfaces:**
- Consumes: 无（纯 DOM，jsdom 可测）
- Produces（Task 4 依赖，签名逐字如下）:

```ts
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
  showPanel(x: number, y: number, model: string): void;
  setPanelState(state: 'loading' | 'done' | 'error', text?: string): void;
  hidePanel(): void;
  isPinned(): boolean;
  pathInside(path: EventTarget[]): boolean;
  destroy(): void;
}

export function createSelectionUI(doc: Document, cbs: SelUICallbacks): SelUI;
export function clampPosition(x: number, y: number, w: number, h: number, vw: number, vh: number): { x: number; y: number };
```

- [ ] **Step 1: 写失败测试（新建 tests/selection.test.ts）**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSelectionUI, clampPosition, SEL_HOST_ATTR } from '../lib/renderer/selection';
import type { SelUI, SelUICallbacks } from '../lib/renderer/selection';

function makeUI(): { ui: SelUI; cbs: Record<keyof SelUICallbacks, ReturnType<typeof vi.fn>> } {
  const cbs = {
    onDotClick: vi.fn(), onClose: vi.fn(), onRetry: vi.fn(),
    onCopy: vi.fn(), onSpeak: vi.fn(),
  };
  return { ui: createSelectionUI(document, cbs), cbs };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('clampPosition', () => {
  it('右/下边缘内收 8px，最小 8px', () => {
    expect(clampPosition(100, 100, 300, 160, 1024, 768)).toEqual({ x: 100, y: 100 });
    expect(clampPosition(1000, 700, 300, 160, 1024, 768)).toEqual({ x: 716, y: 600 });
    expect(clampPosition(0, 0, 300, 160, 1024, 768)).toEqual({ x: 8, y: 8 });
    expect(clampPosition(50, 50, 2000, 2000, 1024, 768)).toEqual({ x: 8, y: 8 });
  });
});

describe('createSelectionUI', () => {
  it('初始圆钮与浮窗均隐藏，host 挂在 body 且带 SEL_HOST_ATTR', () => {
    const { ui } = makeUI();
    expect(ui.host.hasAttribute(SEL_HOST_ATTR)).toBe(true);
    expect(ui.host.parentElement).toBe(document.body);
    const dot = ui.host.shadowRoot!.querySelector('.dot') as HTMLElement;
    const panel = ui.host.shadowRoot!.querySelector('.panel') as HTMLElement;
    expect(dot.hidden).toBe(true);
    expect(panel.hidden).toBe(true);
  });

  it('showDot 定位并显示圆钮；showPanel 显示浮窗并设置模型名', () => {
    const { ui } = makeUI();
    ui.showDot(120, 340);
    const dot = ui.host.shadowRoot!.querySelector('.dot') as HTMLElement;
    expect(dot.hidden).toBe(false);
    expect(ui.host.style.left).toBe('120px');
    expect(ui.host.style.top).toBe('340px');
    ui.showPanel(10, 10, 'DeepSeek · deepseek-chat');
    const panel = ui.host.shadowRoot!.querySelector('.panel') as HTMLElement;
    expect(panel.hidden).toBe(false);
    expect(dot.hidden).toBe(true);
    expect(ui.host.shadowRoot!.querySelector('.model')!.textContent).toBe('DeepSeek · deepseek-chat');
  });

  it('setPanelState 三态：loading / done / error（含重试按钮）', () => {
    const { ui } = makeUI();
    ui.showPanel(10, 10, 'm');
    const body = () => ui.host.shadowRoot!.querySelector('.body') as HTMLElement;
    ui.setPanelState('loading');
    expect(body().textContent).toBe('翻译中…');
    ui.setPanelState('done', '你好世界');
    expect(body().textContent).toBe('你好世界');
    ui.setPanelState('error', 'API Key 无效');
    expect(body().textContent).toContain('API Key 无效');
    expect(body().querySelector('[data-sel-retry]')).not.toBeNull();
  });

  it('回调：圆钮点击 / 关闭 / 重试 / 复制(带 done 文本) / 朗读', () => {
    const { ui, cbs } = makeUI();
    const root = ui.host.shadowRoot!;
    (root.querySelector('.dot') as HTMLButtonElement).click();
    expect(cbs.onDotClick).toHaveBeenCalled();
    ui.showPanel(10, 10, 'm');
    ui.setPanelState('done', '译文内容');
    (root.querySelector('.close') as HTMLButtonElement).click();
    expect(cbs.onClose).toHaveBeenCalled();
    ui.setPanelState('error');
    (root.querySelector('[data-sel-retry]') as HTMLButtonElement).click();
    expect(cbs.onRetry).toHaveBeenCalled();
    (root.querySelector('.copy') as HTMLButtonElement).click();
    expect(cbs.onCopy).toHaveBeenCalledWith('译文内容');
    (root.querySelector('.speak') as HTMLButtonElement).click();
    expect(cbs.onSpeak).toHaveBeenCalledWith('译文内容');
  });

  it('图钉切换 isPinned；pathInside 判定 host 内/外', () => {
    const { ui } = makeUI();
    const root = ui.host.shadowRoot!;
    expect(ui.isPinned()).toBe(false);
    (root.querySelector('.pin') as HTMLButtonElement).click();
    expect(ui.isPinned()).toBe(true);
    expect(ui.pathInside([ui.host])).toBe(true);
    expect(ui.pathInside([document.body])).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/selection.test.ts`
Expected: FAIL —— 模块 `../lib/renderer/selection` 不存在

- [ ] **Step 3: 实现 lib/renderer/selection.ts（完整文件）**

```ts
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
  showPanel(x: number, y: number, model: string): void;
  setPanelState(state: 'loading' | 'done' | 'error', text?: string): void;
  hidePanel(): void;
  isPinned(): boolean;
  pathInside(path: EventTarget[]): boolean;
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
  overflow: hidden;
}
.header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #f0f0f0; }
.logo { width: 20px; height: 20px; border-radius: 6px; background: #e91e63; color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
.model { flex: 1; font-size: 12px; color: #999; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header button { border: none; background: none; cursor: pointer; font-size: 13px; color: #999; padding: 2px 4px; }
.header button.active { color: #e91e63; }
.body { padding: 10px 12px; min-height: 24px; max-height: 240px; overflow-y: auto; white-space: pre-wrap; }
.body.loading { color: #999; }
.body.error { color: #e06c75; }
.body button[data-sel-retry] { margin-left: 8px; cursor: pointer; border: 1px solid #e06c75;
  background: transparent; color: #e06c75; border-radius: 6px; padding: 1px 8px; font-size: 12px; }
.footer { display: flex; gap: 4px; padding: 6px 10px; border-top: 1px solid #f0f0f0; }
.footer button { border: none; background: none; cursor: pointer; font-size: 14px; padding: 2px 6px; opacity: 0.7; }
.footer button.active { opacity: 1; }
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
  const bodyEl = panel.querySelector('.body')!;
  const pinBtn = panel.querySelector<HTMLButtonElement>('.pin')!;
  const copyBtn = panel.querySelector<HTMLButtonElement>('.copy')!;
  const upBtn = panel.querySelector<HTMLButtonElement>('.thumb-up')!;
  const downBtn = panel.querySelector<HTMLButtonElement>('.thumb-down')!;

  let pinned = false;
  let lastText = '';
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

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

  return {
    host,
    showDot(x, y) {
      panel.hidden = true;
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      dot.hidden = false;
    },
    hideDot() { dot.hidden = true; },
    showPanel(x, y, model) {
      dot.hidden = true;
      modelEl.textContent = model;
      panel.hidden = false;
      const p = clampPanel(x, y);
      host.style.left = `${p.x}px`;
      host.style.top = `${p.y}px`;
    },
    setPanelState(state, text) {
      bodyEl.className = `body ${state}`;
      if (state === 'loading') {
        bodyEl.textContent = '翻译中…';
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
    },
    hidePanel() {
      panel.hidden = true;
      pinned = false;
      pinBtn.classList.remove('active');
      upBtn.classList.remove('active');
      downBtn.classList.remove('active');
    },
    isPinned: () => pinned,
    pathInside: (path) => path.includes(host),
    destroy() { if (copyTimer !== null) clearTimeout(copyTimer); host.remove(); },
  };
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run tests/selection.test.ts && npm run typecheck`
Expected: PASS（6 个用例）。若 jsdom 报 `attachShadow` 相关错误，确认 vitest 环境为 jsdom（`vitest.config.ts` 已配置）。

- [ ] **Step 5: Commit**

```bash
git add lib/renderer/selection.ts tests/selection.test.ts
git commit -m "feat: 划词浮窗渲染器（圆钮 + Shadow DOM 面板）"
```

---

### Task 4: content script 集成划词翻译

**Files:**
- Modify: `entrypoints/content.ts`

**Interfaces:**
- Consumes:
  - `createSelectionUI(doc, cbs): SelUI`、`SEL_HOST_ATTR`（Task 3，签名见 Task 3 Interfaces）
  - `TranslateRequest.targetLang?: string`（Task 1）
  - 已存在：`getSettings` / `getActiveProvider` / `resolveModel`（`lib/settings.ts`）、`cjkRatio(text: string): number`（`lib/extraction/paragraphs.ts:20`）、`postToPort(req)` / `onChunkResponse(msg)`（content.ts 内部）
- Produces: 无（对外行为：划词圆钮与浮窗；E2E 用 `[data-llm-translate-sel] .dot` / `.panel` 断言）

本任务无单测（DOM 事件集成），验证靠 typecheck + build；E2E 在 Task 5。

- [ ] **Step 1: 修改 entrypoints/content.ts**

导入区追加（注意 verbatimModuleSyntax）：

```ts
import { cjkRatio } from '../lib/extraction/paragraphs';
import { createSelectionUI, SEL_HOST_ATTR } from '../lib/renderer/selection';
import type { SelUI } from '../lib/renderer/selection';
import { getSettings, getActiveProvider, resolveModel } from '../lib/settings';
```

（原有 `import { getSettings } from '../lib/settings';` 一行删除，并入上面这行；`import { extractParagraphs, browserIsVisible } from '../lib/extraction/paragraphs';` 一行把 `cjkRatio` 并入也可，二选一保持不重复导入同一模块。）

模块级状态（放在 `let port` 附近）：

```ts
let selUI: SelUI | null = null;
let selReq: TranslateRequest | null = null; // 最后一次划词请求，供重试重发
let speaking = false;
```

`main()` 内 `watchSpaNavigation();` 之前加一行：

```ts
    initSelectionTranslate();
```

在文件末尾追加以下函数：

```ts
function initSelectionTranslate(): void {
  selUI = createSelectionUI(document, {
    onDotClick: () => void onSelDotClick(),
    onClose: () => selUI?.hidePanel(),
    onRetry: () => {
      if (!selReq) return;
      selUI?.setPanelState('loading');
      postToPort(selReq);
    },
    onCopy: (text) => { void navigator.clipboard.writeText(text).catch(() => {}); },
    onSpeak: (text) => {
      if (!text) return;
      if (speaking) { speechSynthesis.cancel(); speaking = false; return; }
      const u = new SpeechSynthesisUtterance(text);
      u.onend = () => { speaking = false; };
      speaking = true;
      speechSynthesis.speak(u);
    },
  });

  document.addEventListener('mouseup', (e) => {
    void (async () => {
      const s = await getSettings();
      if (!s.selectionTranslate) return;
      if (await currentHostBlacklisted()) return;
      const text = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
      if (text.length < 2) return;
      selUI?.showDot(e.pageX + 8, e.pageY + 8);
    })();
  });

  document.addEventListener('mousedown', (e) => {
    if (!selUI || selUI.pathInside(e.composedPath())) return;
    selUI.hideDot();
    if (!selUI.isPinned()) selUI.hidePanel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !selUI) return;
    selUI.hideDot();
    if (!selUI.isPinned()) selUI.hidePanel();
  });
}

async function onSelDotClick(): Promise<void> {
  if (!selUI) return;
  const text = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
  selUI.hideDot();
  if (text.length < 2) return; // 选区已取消：不发请求
  const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
  const s = await getSettings();
  const provider = getActiveProvider(s);
  const model = provider ? `${provider.name} · ${resolveModel(provider)}` : '';
  selUI.showPanel(rect.left + window.scrollX, rect.bottom + window.scrollY + 6, model);
  selUI.setPanelState('loading');
  selReq = {
    kind: 'translate',
    taskId: `sel-${Date.now()}`,
    chunkId: 'c0',
    units: [{ paragraphId: 'sel', text, sliceIndex: 0, sliceTotal: 1 }],
    targetLang: cjkRatio(text) > 0.5 ? 'English' : s.targetLang,
  };
  postToPort(selReq);
}
```

`onChunkResponse` 开头（`// [diag]` 日志行之后、`if (!task || msg.taskId !== task.id ...)` 守卫**之前**）插入分流：

```ts
  if (msg.taskId.startsWith('sel-')) {
    if (selUI) {
      if (msg.kind === 'error') selUI.setPanelState('error', msg.message);
      else selUI.setPanelState('done', msg.translations[0]?.text ?? '');
    }
    return;
  }
```

`isSelfMutation` 整函数替换为：

```ts
function isSelfMutation(m: MutationRecord): boolean {
  if (m.target instanceof Element && m.target.closest(`[${HOST_ATTR}],[${SEL_HOST_ATTR}]`)) return true;
  const added = Array.from(m.addedNodes);
  return added.length > 0 && added.every(n =>
    n instanceof Element && (n.hasAttribute(HOST_ATTR) || n.hasAttribute(SEL_HOST_ATTR)
      || n.querySelector(`[${HOST_ATTR}],[${SEL_HOST_ATTR}]`) !== null));
}
```

`clearAll` 在 `cancelTask();` 之后加：

```ts
  selUI?.hideDot();
  selUI?.hidePanel();
  if (speaking) { speechSynthesis.cancel(); speaking = false; }
```

- [ ] **Step 2: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 均通过

- [ ] **Step 3: 全量单测（确认无回归）+ Commit**

Run: `npm test`
Expected: 全绿

```bash
git add entrypoints/content.ts
git commit -m "feat: content script 集成划词翻译（圆钮触发 + sel- 通道分流）"
```

---

### Task 5: popup 划词开关 + E2E + 全量回归

**Files:**
- Modify: `entrypoints/popup/index.html:102-105`（site-toggle 行之后）
- Modify: `entrypoints/popup/main.ts:33-35`（refresh 内）、`entrypoints/popup/main.ts:140-149`（site-toggle 监听之后）
- Modify: `e2e/translate.spec.ts`（文件末尾追加）

**Interfaces:**
- Consumes: `Settings.selectionTranslate`（Task 1）；页面上的 `[data-llm-translate-sel]` host、shadow 内 `.dot` / `.panel`（Task 3/4）
- Produces: popup 开关立即可用；E2E 用例守护划词主链路

- [ ] **Step 1: popup/index.html 加开关行**

在「在此站点启用」那个 `.row` 之后、`</div>`（卡片收尾）之前加：

```html
    <div class="row">
      <span>划词翻译</span>
      <label class="switch"><input type="checkbox" id="sel-toggle" checked><span class="slider"></span></label>
    </div>
```

- [ ] **Step 2: popup/main.ts 接线**

`refresh()` 内 `($('site-toggle') as HTMLInputElement).checked = !disabled;` 之后加一行：

```ts
  ($('sel-toggle') as HTMLInputElement).checked = s.selectionTranslate;
```

`$('site-toggle').addEventListener(...)` 整段之后加：

```ts
$('sel-toggle').addEventListener('change', async (e) => {
  await saveSettings({ selectionTranslate: (e.target as HTMLInputElement).checked });
});
```

- [ ] **Step 3: e2e/translate.spec.ts 追加用例**

文件顶部常量区（`const HOST = ...` 后）加：

```ts
const SEL = '[data-llm-translate-sel]';
```

文件末尾追加：

```ts
test('划词翻译：选中文本出现圆钮，点击弹出浮窗显示译文', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  // 构造真实选区并派发 mouseup（Playwright 的 css 选择器可穿透 Shadow DOM）
  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 }));
  });

  const dot = page.locator(`${SEL} .dot`);
  await expect(dot).toBeVisible({ timeout: 10_000 });

  await dot.click();
  const panel = page.locator(`${SEL} .panel`);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('译文', { timeout: 15_000 });
});
```

- [ ] **Step 4: build + E2E**

Run: `npm run build && npm run e2e`
Expected: 5 条 E2E 全绿（旧 4 条 + 新 1 条）

- [ ] **Step 5: 全量回归 + Commit**

Run: `npm test && npm run typecheck`
Expected: 全绿

```bash
git add entrypoints/popup/index.html entrypoints/popup/main.ts e2e/translate.spec.ts
git commit -m "feat: popup 划词翻译开关与划词 E2E 用例"
```
