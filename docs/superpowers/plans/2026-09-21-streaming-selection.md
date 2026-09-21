# 流式输出 + 划词浮窗跟随选区 + 等待动画 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让划词与整页译文以真 SSE 流式逐字浮现；划词浮窗锚定当前选区且不再遮挡拖拽划词；等待态有过渡动画。

**Architecture:** 新增 `sse.ts`（自己解 SSE 帧，不引依赖）与 `marker-demux.ts`（增量解 `[i]` 标记，流式恒 plain 模式），在 `llm-client → scheduler → background → content` 链路上逐层透传 `onDelta`，新增 `{kind:'delta'}` 端口消息；渲染层把圆钮/浮窗锚点从鼠标坐标改为 `Selection.getRangeAt(0).getClientRects()`，并给浮窗做 `pointer-events` 分层；动画共用 `lib/renderer/motion.ts`。

**Tech Stack:** WXT 0.21 + MV3、TypeScript、vitest/jsdom、Playwright（真 chromium + 本地桩服务）。

**依据 spec:** `docs/superpowers/specs/2026-09-21-streaming-selection-design.md`

---

## Global Constraints

- 不引入任何新依赖；SSE 帧自己解。
- 流式路径**恒 plain 模式**，且**不得写入** `deps.jsonFormatSupported`（保住 `d952590` / `6f7b392` 的语义）。
- 单测：`npm test`（vitest run，include `tests/**/*.test.ts`）；类型检查：`npm run typecheck`。
- 跑 E2E 前必须 `npm run build`（Playwright 从 `.output/chrome-mv3` 加载扩展，global-setup 不负责构建）。
- E2E：`npm run e2e`；playwright workers=1（桩服务的 fail/delay 是全局状态，必须串行）。
- 文案保持中文；注释解释「为什么」，与现有密度一致。
- 所有新增文本一律走 `textContent` / `createElement`，不拼 `innerHTML`。
- 每个 Task 结束都要 commit，message 用 `feat:`/`fix:`/`test:` + 中文描述。

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `lib/translation/sse.ts` | `Response.body` → `data:` 帧回调；只管分帧，不懂业务 |
| `lib/translation/marker-demux.ts` | 把 token 流增量解成「第 i 段的增量」，挂起尾部半截标记 |
| `lib/renderer/motion.ts` | 三点脉动 / 流式光标 / 入场动画的共享 CSS 与 DOM 助手 |
| `tests/sse.test.ts` / `tests/marker-demux.test.ts` / `tests/motion.test.ts` | 对应单测 |

**修改**

| 文件 | 改动 |
|---|---|
| `lib/messaging/protocol.ts` | `TranslateRequest.stream?`；`TranslateResponse` 增 `{kind:'delta'}` |
| `lib/renderer/host.ts` | `setHostState` 增 `'streaming'` 态；loading 接三点动画 |
| `lib/renderer/selection.ts` | `pointer-events` 分层、`appendPanelText`、三点/光标/入场动画、`isDotVisible`、`containsNode`、圆钮位置夹取 |
| `lib/translation/llm-client.ts` | 抽 `buildRequest`；`translateUnits` 增 `onDelta` 走流式 |
| `lib/translation/scheduler.ts` | `handleTranslateRequest(req, deps, onDelta?)`，下标映射回 unit |
| `entrypoints/background.ts` | 把 delta 逐条 `port.postMessage` |
| `entrypoints/content.ts` | 请求带 `stream:true`；处理 delta（整页累积 / 划词追面板）；选区锚定圆钮与浮窗；`selectionchange` 跟随与收起 |
| `e2e/stub-server.ts` | `stream:true` 时返回 SSE 分帧 + `hold`/`release` 控制 |
| `e2e/translate.spec.ts` | 5 个新用例 + 现有划词用例加位置断言 |
| `tests/selection.test.ts` / `tests/host.test.ts` | 跟随新 API 与态 |

---

### Task 1: SSE 帧读取

**Files:**
- Create: `lib/translation/sse.ts`
- Test: `tests/sse.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/sse.test.ts
import { describe, it, expect } from 'vitest';
import { readSse } from '../lib/translation/sse';

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
  return new Response(stream, { status: 200 });
}

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  await readSse(sseResponse(chunks), (d) => out.push(d));
  return out;
}

describe('readSse', () => {
  it('按空行切帧，取 data: 行的内容', async () => {
    expect(await collect(['data: {"a":1}\n\ndata: {"b":2}\n\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('\\r\\n 行结束同样识别', async () => {
    expect(await collect(['data: {"a":1}\r\n\r\n'])).toEqual(['{"a":1}']);
  });

  it('帧被拆到两个 chunk 也能拼回来', async () => {
    expect(await collect(['data: {"a":', '1}\n\n'])).toEqual(['{"a":1}']);
  });

  it('\\r 恰好落在 chunk 边界（\\r\\n 被劈开）仍能切帧', async () => {
    expect(await collect(['data: {"a":1}\r', '\n\r\n'])).toEqual(['{"a":1}']);
  });

  it('多行 data: 以 \\n 拼接；event:/id: 行忽略', async () => {
    expect(await collect(['event: content_block_delta\nid: 1\ndata: ab\ndata: cd\n\n'])).toEqual(['ab\ncd']);
  });

  it('跳过 [DONE] 与空 data 帧', async () => {
    expect(await collect(['data: [DONE]\n\n', 'data: {"a":1}\n\n'])).toEqual(['{"a":1}']);
  });

  it('流结束时没有空行收尾的残帧也交出去', async () => {
    expect(await collect(['data: {"a":1}'])).toEqual(['{"a":1}']);
  });

  it('body 为 null 时不抛错', async () => {
    const out: string[] = [];
    await readSse(new Response(null, { status: 204 }), (d) => out.push(d));
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/sse.test.ts`
Expected: FAIL —— `Failed to resolve import "../lib/translation/sse"`。

- [ ] **Step 3: 实现**

```ts
// lib/translation/sse.ts
// 极简 SSE 读帧：只覆盖本项目用到的子集——忽略 event/id/retry 行，
// 多行 data: 用 \n 拼接，[DONE] 与空 data 帧跳过。
export async function readSse(res: Response, onData: (data: string) => void): Promise<void> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let pendingCr = false; // 上一个 chunk 以 \r 结尾：可能是被劈开的 \r\n

  function feed(frame: string): void {
    const data = frame
      .split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data !== '' && data !== '[DONE]') onData(data);
  }

  function drain(): void {
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      feed(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
    }
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let s = decoder.decode(value, { stream: true });
    if (pendingCr) {
      if (s.startsWith('\n')) s = s.slice(1);
      pendingCr = false;
    }
    if (s.endsWith('\r')) {
      s = s.slice(0, -1);
      pendingCr = true;
    }
    buf += s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    drain();
  }
  // 真实 SSE 都会以空行收尾，这里兜住没有收尾空行的流
  const tail = buf.trim();
  if (tail !== '') feed(tail);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/sse.test.ts`
Expected: PASS（8 项）。

- [ ] **Step 5: Commit**

```bash
git add lib/translation/sse.ts tests/sse.test.ts
git commit -m "feat: 新增 SSE 读帧工具（自解帧，不引依赖）"
```

---

### Task 2: 增量 `[i]` 标记解复用

**Files:**
- Create: `lib/translation/marker-demux.ts`
- Test: `tests/marker-demux.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/marker-demux.test.ts
import { describe, it, expect } from 'vitest';
import { createMarkerDemux } from '../lib/translation/marker-demux';
import { parsePlainResponse } from '../lib/translation/prompt';

function collectDeltas(chunks: string[], expected: number) {
  const deltas: [number, string][] = [];
  const demux = createMarkerDemux(expected, (i, t) => deltas.push([i, t]));
  for (const c of chunks) demux.push(c);
  return { deltas, text: demux.finish() };
}

describe('createMarkerDemux', () => {
  it('单块：按标记归属并立即吐出', () => {
    expect(collectDeltas(['[0] 甲\n\n[1] 乙'], 2).deltas).toEqual([[0, '甲'], [1, '乙']]);
  });

  it('标记被拆到三次 push（[ / 1 / ]）也不吐出半截标记', () => {
    const { deltas } = collectDeltas(['[', '1', '] 甲'], 2);
    expect(deltas).toEqual([[1, '甲']]);
  });

  it('首个标记之前的引言丢弃', () => {
    expect(collectDeltas(['好的，以下是译文：\n[0] 甲'], 1).deltas).toEqual([[0, '甲']]);
  });

  it('越界标记不认，原样留在上一段正文里', () => {
    const { deltas } = collectDeltas(['[0] 甲\n[7] 乙\n[1] 丙'], 2);
    expect(deltas).toEqual([[0, '甲\n[7] 乙'], [1, '丙']]);
  });

  it('跨块文本按到达顺序吐出（贪心）', () => {
    const { deltas } = collectDeltas(['[0] 甲', '乙', '丙'], 1);
    expect(deltas).toEqual([[0, '甲'], [0, '乙'], [0, '丙']]);
  });

  it('尾部半截标记挂起，后续字符到达后才吐', () => {
    const { deltas } = collectDeltas(['[0] 甲', '\n\n[1'], 2);
    expect(deltas).toEqual([[0, '甲']]); // 此时 [1 还挂起，没有归属
    expect(deltas.flat().join('')).not.toContain('[1');
  });

  it('finish() 返回全文，可交 parsePlainResponse 权威解析', () => {
    const { text } = collectDeltas(['[0] 甲', '\n\n[', '1] 乙'], 2);
    expect(parsePlainResponse(text, 2)).toEqual(['甲', '乙']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/marker-demux.test.ts`
Expected: FAIL —— `Failed to resolve import "../lib/translation/marker-demux"`。

- [ ] **Step 3: 实现**

```ts
// lib/translation/marker-demux.ts
// 增量解 [i] 标记流：把逐 token 到达的原始文本切成「第 i 段的增量」。
// JSON 无法增量解复用（{"items":[... 要等闭合才能 parse），所以流式路径恒用 plain 标记格式。
export interface MarkerDemux {
  push(chunk: string): void;
  finish(): string;
}

// 半截标记（形如 "[12"、"[") 必须挂起：立刻吐出会让用户看到闪过的 "[12"，
// 而它其实是标记的一部分，不是正文。
const PARTIAL_MARKER_RE = /\[\d*$/;

export function createMarkerDemux(expected: number, onDelta: (index: number, text: string) => void): MarkerDemux {
  let raw = '';     // 全量累积，finish() 交 parsePlainResponse 权威解析
  let pending = ''; // 尚未归属的尾缓冲
  let current = -1; // 当前归属下标；-1 = 首个合法标记之前（引言，丢弃）

  // 找首个「合法」标记。正则每次新建，避免共享 lastIndex 串状态。
  function findMarker(s: string): { index: number; end: number; i: number } | null {
    const re = /\[(\d+)\]\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const i = Number(m[1]);
      if (i >= 0 && i < expected) return { index: m.index, end: m.index + m[0].length, i };
    }
    return null;
  }

  function emit(text: string): void {
    if (text === '' || current < 0) return;
    onDelta(current, text);
  }

  // 吐到安全边界为止：尾部若可能是半截标记就挂起
  function flush(): void {
    const hit = PARTIAL_MARKER_RE.exec(pending);
    const cut = hit ? hit.index : pending.length;
    if (cut === 0) return;
    emit(pending.slice(0, cut));
    pending = pending.slice(cut);
  }

  function drain(): void {
    for (;;) {
      const hit = findMarker(pending);
      if (!hit) { flush(); return; }
      // 标记前的正文属于上一个下标；标记后的 \s* 已吃掉段间空白，这里只兜尾部残留
      emit(pending.slice(0, hit.index).trimEnd());
      pending = pending.slice(hit.end);
      current = hit.i;
    }
  }

  return {
    push(chunk) { raw += chunk; pending += chunk; drain(); },
    finish() { flush(); return raw; },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/marker-demux.test.ts`
Expected: PASS（7 项）。

- [ ] **Step 5: Commit**

```bash
git add lib/translation/marker-demux.ts tests/marker-demux.test.ts
git commit -m "feat: 增量解 [i] 标记的 demux（尾部半截标记挂起）"
```

---

### Task 3: 协议增流式字段

**Files:**
- Modify: `lib/messaging/protocol.ts`

- [ ] **Step 1: 加 `stream?` 与 `delta` 响应**

把 `lib/messaging/protocol.ts` 改成：

```ts
export interface UnitPayload {
  paragraphId: string;
  text: string;
  sliceIndex: number;
  sliceTotal: number;
}

export interface TranslateRequest {
  kind: 'translate';
  taskId: string;
  chunkId: string;
  units: UnitPayload[];
  /** 逐请求目标语言覆盖（划词双语向）；缺省用 settings.targetLang */
  targetLang?: string;
  /** 流式：响应过程中先发若干 delta，最终仍以 result 收尾。缺省 false = 一次性响应 */
  stream?: boolean;
}

export interface TranslateResultItem {
  paragraphId: string;
  sliceIndex: number;
  sliceTotal: number;
  text: string;
}

export type TranslateResponse =
  | { kind: 'result'; taskId: string; chunkId: string; translations: TranslateResultItem[] }
  | {
      kind: 'delta';
      taskId: string;
      chunkId: string;
      paragraphId: string;
      sliceIndex: number;
      sliceTotal: number;
      /** 该段的增量片段（不是全量），追加到已有文本尾部 */
      text: string;
    }
  | { kind: 'error'; taskId: string; chunkId: string; code: 'auth' | 'failed'; message: string };
```

（`StartTabRequest` / `StartTabResponse` 保持不变。）

- [ ] **Step 2: 给 content 的响应处理器补 delta 早退分支**

联合类型多一支后，`entrypoints/content.ts` 里 `onChunkResponse` 的 `else` 分支不再是 `result`，
`msg.translations` 会变成类型错误。先加一个早退占位（Task 10 / 14 再换成真正的处理）：

在 `function onChunkResponse(msg: TranslateResponse): void {` 之后、`console.log('[llm-tr] chunk response:'...)` 之前插入：

```ts
  if (msg.kind === 'delta') return; // Task 10 起改由 appendDelta 处理
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 4: 跑既有单测确认没破**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add lib/messaging/protocol.ts entrypoints/content.ts
git commit -m "feat: 协议增 stream 请求字段与 delta 响应"
```

---

### Task 4: 共享动画模块

**Files:**
- Create: `lib/renderer/motion.ts`
- Test: `tests/motion.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/motion.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MOTION_CSS, createDots, setLoading, replayPop } from '../lib/renderer/motion';

beforeEach(() => { document.body.innerHTML = ''; });

describe('createDots', () => {
  it('生成 3 个 i（无文本，不污染 textContent）', () => {
    const dots = createDots(document);
    expect(dots.className).toBe('dots');
    expect(dots.querySelectorAll('i')).toHaveLength(3);
    expect(dots.textContent).toBe('');
  });
});

describe('setLoading', () => {
  it('写入文案并追加三点', () => {
    const body = document.createElement('div');
    setLoading(document, body);
    expect(body.textContent).toBe('翻译中…');
    expect(body.querySelectorAll('.dots i')).toHaveLength(3);
  });

  it('重复调用不叠加三点（textContent 先清空）', () => {
    const body = document.createElement('div');
    setLoading(document, body);
    setLoading(document, body);
    expect(body.querySelectorAll('.dots')).toHaveLength(1);
  });
});

describe('replayPop', () => {
  it('摘掉再加回 pop 类以重播动画', () => {
    const el = document.createElement('div');
    el.classList.add('pop');
    replayPop(el);
    expect(el.classList.contains('pop')).toBe(true);
  });
});

describe('MOTION_CSS', () => {
  it('含三点脉动 / 流式光标 / 入场关键帧与 reduced-motion 兜底', () => {
    expect(MOTION_CSS).toContain('@keyframes dots-pulse');
    expect(MOTION_CSS).toContain('@keyframes caret-blink');
    expect(MOTION_CSS).toContain('@keyframes pop-in');
    expect(MOTION_CSS).toContain('prefers-reduced-motion');
    // 三点错峰：2、3 号点有延迟
    expect(MOTION_CSS).toContain('animation-delay: 0.2s');
    expect(MOTION_CSS).toContain('animation-delay: 0.4s');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/motion.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

```ts
// lib/renderer/motion.ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/motion.test.ts`
Expected: PASS（6 项）。

- [ ] **Step 5: Commit**

```bash
git add lib/renderer/motion.ts tests/motion.test.ts
git commit -m "feat: 共享动画模块（三点脉动/流式光标/入场动画）"
```

---

### Task 5: 整页 host 的流式态与等待动画

**Files:**
- Modify: `lib/renderer/host.ts`
- Test: `tests/host.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/host.test.ts` 的 `describe('setHostState', ...)` 里追加：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/host.test.ts`
Expected: FAIL —— `'streaming'` 不在 state 联合类型里 / loading 无 `.dots`。

- [ ] **Step 3: 实现**

`lib/renderer/host.ts` 改为：

```ts
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
```

`ensureHost` 里创建 body 的三行改为：

```ts
  const body = doc.createElement('div');
  body.className = 'body loading';
  setLoading(doc, body);
```

`setHostState` 改为：

```ts
export function setHostState(
  host: HTMLElement,
  state: 'loading' | 'streaming' | 'done' | 'error',
  text?: string,
): void {
  const body = host.shadowRoot?.querySelector('.body');
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/host.test.ts`
Expected: PASS（既有 7 项 + 新增 3 项）。

- [ ] **Step 5: Commit**

```bash
git add lib/renderer/host.ts tests/host.test.ts
git commit -m "feat: host 增流式态，等待态接三点脉动动画"
```

---

### Task 6: llm-client 流式请求

**Files:**
- Modify: `lib/translation/llm-client.ts`
- Test: `tests/llm-client.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/llm-client.test.ts` 末尾追加：

```ts
function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function openaiFrames(text: string, size = 3): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return [
    ...parts.map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`),
    'data: [DONE]\n\n',
  ];
}

describe('translateUnits（流式）', () => {
  it('按 plain 标记流式解析：onDelta 逐段吐出，最终结果与解析一致', async () => {
    const deltas: [number, string][] = [];
    const fetchImpl = vi.fn(async () => sseResponse(openaiFrames('[0] 甲\n\n[1] 乙'))) as any;
    const r = await translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep }, (i, t) => deltas.push([i, t]));
    expect(r.translations).toEqual(['甲', '乙']);
    expect(r.useJsonFormat).toBe(false);
    expect(deltas.filter(([i]) => i === 0).map(([, t]) => t).join('')).toBe('甲');
    expect(deltas.filter(([i]) => i === 1).map(([, t]) => t).join('')).toBe('乙');
    // 流式请求恒不带 response_format，且带 stream: true
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(body.response_format).toBeUndefined();
  });

  it('Claude 协议取 content_block_delta.delta.text', async () => {
    const deltas: [number, string][] = [];
    const frames = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"[0] 甲"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const fetchImpl = vi.fn(async () => sseResponse(frames)) as any;
    const r = await translateUnits(CLAUDE_CFG, ['A'], { ...OPTS, useJsonFormat: true }, { fetchImpl, sleep: noSleep }, (i, t) => deltas.push([i, t]));
    expect(r.translations).toEqual(['甲']);
    expect(r.useJsonFormat).toBe(false);
    expect(deltas.map(([, t]) => t).join('')).toBe('甲');
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
  });

  it('流式 401 抛 AuthError 且不重试', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 })) as any;
    await expect(translateUnits(CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep }, () => {})).rejects.toBeInstanceOf(AuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('流式 400 直接抛错（不降级重发）', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 })) as any;
    await expect(translateUnits(CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep }, () => {})).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('流式中断（缺段）时逐段补齐兜底走非流式', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(sseResponse(openaiFrames('[0] 甲')))        // 流式只给了第 0 段
      .mockResolvedValueOnce(jsonResponse('{"items":[{"i":0,"t":"乙"}]}')) // 补齐第 1 段（非流式）
      .mockResolvedValueOnce(jsonResponse('{"items":[{"i":0,"t":"乙"}]}'));
    const r = await translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl: fetchImpl as any, sleep: noSleep }, () => {});
    expect(r.translations).toEqual(['甲', '乙']);
    // 第二次请求是非流式的逐段补齐
    const body2 = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
    expect(body2.stream).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/llm-client.test.ts`
Expected: FAIL —— `translateUnits` 只接受 4 个参数，第 5 个被忽略，`onDelta` 永远收不到东西。

- [ ] **Step 3: 抽 `buildRequest` 并实现流式路径**

`lib/translation/llm-client.ts` 全文改为：

```ts
import { buildMessages, parseJsonResponse, parsePlainResponse, type ChatMessage } from './prompt';
import { readSse } from './sse';
import { createMarkerDemux } from './marker-demux';
import type { ApiProtocol } from '../settings';

export interface LlmConfig { baseUrl: string; apiKey: string; model: string; protocol: ApiProtocol }

export class AuthError extends Error {}
export class FormatUnsupportedError extends Error {}

interface Deps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }
export type DeltaHandler = (unitIndex: number, text: string) => void;

const RETRY_DELAYS = [1000, 2000, 4000];
const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// 共用的重试循环：401/403 → AuthError；429/5xx 退避 [1s,2s,4s]；其余错误直接抛
async function requestWithRetry(
  doFetch: (fetchImpl: typeof fetch) => Promise<Response>,
  deps: Deps,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(fetchImpl);
    if (res.ok) return res;
    if (res.status === 401 || res.status === 403) throw new AuthError(`LLM auth failed: ${res.status}`);
    if ((res.status === 429 || res.status >= 500) && attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt]!);
      continue;
    }
    return res; // 4xx（非 401/403）交回调用方读 body 抛错
  }
}

// 请求构造只有这一处：非流式与流式的差别仅为 body 里的 stream 字段
function buildRequest(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: { useJsonFormat: boolean; stream: boolean },
): { url: string; init: RequestInit } {
  if (cfg.protocol === 'claude') {
    const system = messages.find(m => m.role === 'system')?.content ?? '';
    const user = messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
    return {
      url: `${cfg.baseUrl}/v1/messages`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: cfg.model, max_tokens: 4096, system,
          messages: [{ role: 'user', content: user }], temperature: 0.3,
          ...(opts.stream ? { stream: true } : {}),
        }),
      },
    };
  }
  const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0.3 };
  if (opts.useJsonFormat) body.response_format = { type: 'json_object' };
  if (opts.stream) body.stream = true;
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    },
  };
}

async function chatCompletion(
  cfg: LlmConfig,
  messages: ChatMessage[],
  useJsonFormat: boolean,
  deps: Deps,
): Promise<string> {
  const { url, init } = buildRequest(cfg, messages, { useJsonFormat: useJsonFormat && cfg.protocol !== 'claude', stream: false });
  const res = await requestWithRetry((f) => f(url, init), deps);
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && useJsonFormat && cfg.protocol !== 'claude' && /response_format/i.test(text)) {
      throw new FormatUnsupportedError(text);
    }
    throw new Error(`LLM request failed: ${res.status}: ${text}`);
  }
  if (cfg.protocol === 'claude') {
    const data = await res.json();
    const blocks = data.content as { type?: string; text?: string }[] | undefined;
    // 无 text 块 → 返回空串，让上层按解析失败走逐段补齐
    return blocks?.find(b => b.type === 'text')?.text ?? '';
  }
  const data = await res.json();
  return data.choices[0].message.content as string;
}

// 从一帧 SSE data 里取增量文本；非增量帧（role 帧、ping、message_start 等）返回空串
function pickDelta(protocol: ApiProtocol, data: string): string {
  let obj: { [k: string]: any };
  try {
    obj = JSON.parse(data);
  } catch {
    return '';
  }
  if (protocol === 'claude') {
    if (obj?.type !== 'content_block_delta') return '';
    return typeof obj?.delta?.text === 'string' ? obj.delta.text : '';
  }
  const c = obj?.choices?.[0]?.delta?.content;
  return typeof c === 'string' ? c : '';
}

// 流式请求：只把增量喂给 onText，正文由调用方的 demux 负责组装
async function chatCompletionStream(
  cfg: LlmConfig,
  messages: ChatMessage[],
  deps: Deps,
  onText: (text: string) => void,
): Promise<void> {
  const { url, init } = buildRequest(cfg, messages, { useJsonFormat: false, stream: true });
  const res = await requestWithRetry((f) => f(url, init), deps);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed: ${res.status}: ${text}`);
  }
  await readSse(res, (data) => {
    const t = pickDelta(cfg.protocol, data);
    if (t !== '') onText(t);
  });
}

async function translateSingle(cfg: LlmConfig, text: string, opts: { targetLang: string; systemPrompt: string; sourceLang?: string }, useJsonFormat: boolean, deps: Deps): Promise<string | null> {
  try {
    const content = await chatCompletion(cfg, buildMessages([text], opts.targetLang, opts.systemPrompt, useJsonFormat ? 'json' : 'plain', opts.sourceLang), useJsonFormat, deps);
    const parsed = useJsonFormat ? parseJsonResponse(content, 1) : parsePlainResponse(content, 1);
    return parsed?.[0] ?? null;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return null;
  }
}

// 流式：恒 plain 标记模式（JSON 无法增量解复用），结束后仍以解析出的全文为准，
// 缺段走既有逐段补齐（补齐是非流式请求）。
async function translateUnitsStreaming(
  cfg: LlmConfig,
  texts: string[],
  opts: { targetLang: string; systemPrompt: string; sourceLang?: string },
  deps: Deps,
  onDelta: DeltaHandler,
): Promise<{ translations: (string | null)[]; useJsonFormat: boolean }> {
  const demux = createMarkerDemux(texts.length, onDelta);
  await chatCompletionStream(
    cfg,
    buildMessages(texts, opts.targetLang, opts.systemPrompt, 'plain', opts.sourceLang),
    deps,
    (t) => demux.push(t),
  );
  const parsed = parsePlainResponse(demux.finish(), texts.length);
  const translations: (string | null)[] = parsed ?? new Array(texts.length).fill(null);
  for (let i = 0; i < translations.length; i++) {
    if (translations[i] === null) translations[i] = await translateSingle(cfg, texts[i]!, opts, false, deps);
  }
  return { translations, useJsonFormat: false };
}

export async function translateUnits(
  cfg: LlmConfig,
  texts: string[],
  opts: { targetLang: string; systemPrompt: string; useJsonFormat: boolean; sourceLang?: string },
  deps: Deps = {},
  onDelta?: DeltaHandler,
): Promise<{ translations: (string | null)[]; useJsonFormat: boolean }> {
  if (onDelta) return translateUnitsStreaming(cfg, texts, opts, deps, onDelta);

  let mode = opts.useJsonFormat && cfg.protocol !== 'claude'; // Claude 无 response_format，强制 plain
  let content: string;
  try {
    content = await chatCompletion(cfg, buildMessages(texts, opts.targetLang, opts.systemPrompt, mode ? 'json' : 'plain', opts.sourceLang), mode, deps);
  } catch (e) {
    if (e instanceof FormatUnsupportedError) {
      mode = false;
      content = await chatCompletion(cfg, buildMessages(texts, opts.targetLang, opts.systemPrompt, 'plain', opts.sourceLang), false, deps);
    } else {
      throw e;
    }
  }
  const parsed = mode ? parseJsonResponse(content, texts.length) : parsePlainResponse(content, texts.length);
  const translations: (string | null)[] = parsed ?? new Array(texts.length).fill(null);
  // 缺项/解析失败 → 逐段补齐
  for (let i = 0; i < translations.length; i++) {
    if (translations[i] === null) {
      translations[i] = await translateSingle(cfg, texts[i]!, opts, mode, deps);
    }
  }
  return { translations, useJsonFormat: mode };
}
```

注意 `chatCompletion` 里的两个行为要点不能丢（既有测试盯着）：Claude 恒不带 `response_format`、
OpenAI 的 `FormatUnsupportedError` 仅在「用了 json 且 400 提到 response_format」时抛。

- [ ] **Step 4: 跑测试确认通过（含既有用例）**

Run: `npm test -- tests/llm-client.test.ts`
Expected: PASS（既有 12 项 + 新增 5 项）。既有用例断言了 URL、三个 Claude 头、`body.max_tokens`、`response_format` 的有无，抽取 `buildRequest` 后必须全部仍然通过。

- [ ] **Step 5: Commit**

```bash
git add lib/translation/llm-client.ts tests/llm-client.test.ts
git commit -m "feat: llm-client 支持流式请求与增量回调"
```

---

### Task 7: 调度器透传增量

**Files:**
- Modify: `lib/translation/scheduler.ts`
- Test: `tests/scheduler.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/scheduler.test.ts` 的 `describe('handleTranslateRequest')` 里追加：

```ts
  it('流式：onDelta 的下标映射回 unit 的 paragraphId/sliceIndex', async () => {
    const seen: [string, number, number, string][] = [];
    const deps = makeDeps({
      translate: vi.fn(async (_cfg: any, texts: string[], _opts: any, _deps: any, onDelta?: any) => {
        onDelta?.(1, '乙');
        onDelta?.(0, '甲');
        return { translations: texts.map((t: string) => `译:${t}`), useJsonFormat: false };
      }),
    });
    const r = await handleTranslateRequest({ ...REQ, stream: true }, deps, (p, s, st, t) => seen.push([p, s, st, t]));
    expect(r.kind).toBe('result');
    expect(seen).toEqual([['p1', 0, 1, '乙'], ['p0', 0, 1, '甲']]);
  });

  it('流式：缓存命中的段落不产生 delta，但下标仍对齐', async () => {
    const seen: [string, string][] = [];
    const deps = makeDeps({
      getCached: (vi.fn(async () => undefined) as any)
        .mockResolvedValueOnce('缓存译文')
        .mockResolvedValueOnce(undefined),
      translate: vi.fn(async (_cfg: any, texts: string[], _opts: any, _deps: any, onDelta?: any) => {
        expect(texts).toEqual(['Goodbye world.']); // 只翻未命中的那段
        onDelta?.(0, '乙');
        return { translations: ['译:Goodbye world.'], useJsonFormat: false };
      }),
    });
    await handleTranslateRequest({ ...REQ, stream: true }, deps, (p, _s, _st, t) => seen.push([p, t]));
    expect(seen).toEqual([['p1', '乙']]);
  });

  it('流式：即使返回 useJsonFormat=false 也不翻转 jsonFormatSupported', async () => {
    const deps = makeDeps({
      translate: vi.fn(async (_cfg: any, texts: string[], opts: any) => {
        expect(opts.useJsonFormat).toBe(false); // 流式恒 plain
        return { translations: texts.map((t: string) => `译:${t}`), useJsonFormat: false };
      }),
    });
    await handleTranslateRequest({ ...REQ, stream: true }, deps, () => {});
    expect(deps.jsonFormatSupported.value).toBe(true);
  });

  it('非流式请求（无 onDelta）行为不变：仍按 useJsonFormat=false 记忆降级', async () => {
    const deps = makeDeps({
      translate: vi.fn(async (_cfg: any, texts: string[], opts: any, _deps: any, onDelta?: any) => {
        expect(onDelta).toBeUndefined(); // 没传 onDelta 就不该传下去
        return { translations: texts.map((t: string) => `译:${t}`), useJsonFormat: false };
      }),
    });
    await handleTranslateRequest(REQ, deps);
    expect(deps.jsonFormatSupported.value).toBe(false);
  });

  it('req.stream 缺省时不传 onDelta（老链路不变成流式）', async () => {
    const deps = makeDeps({
      translate: vi.fn(async (_cfg: any, texts: string[], _opts: any, _deps: any, onDelta?: any) => {
        expect(onDelta).toBeUndefined();
        return { translations: texts.map((t: string) => `译:${t}`), useJsonFormat: true };
      }),
    });
    await handleTranslateRequest(REQ, deps, () => {});
    expect(deps.jsonFormatSupported.value).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/scheduler.test.ts`
Expected: FAIL —— `handleTranslateRequest` 第三个参数被忽略，`seen` 为空数组。

- [ ] **Step 3: 实现**

在 `lib/translation/scheduler.ts` 中：

顶部加类型与签名改动：

```ts
export type DeltaSink = (paragraphId: string, sliceIndex: number, sliceTotal: number, text: string) => void;

export async function handleTranslateRequest(
  req: TranslateRequest,
  deps: SchedulerDeps,
  onDelta?: DeltaSink,
): Promise<TranslateResponse> {
```

在 `const targetLang = ...` 之后加一行：

```ts
  // 只有请求显式要求流式、且调用方提供了回调时才走流式；其余保持一次性响应
  const streaming = req.stream === true && onDelta !== undefined;
```

替换 `try` 块里的翻译调用（原 `const r = await deps.translate(cfg, ...)` 到 `if (!r.useJsonFormat ...)` 那几行）：

```ts
    if (pendingIdx.length > 0) {
      const r = await deps.translate(
        cfg,
        pendingIdx.map(i => texts[i]!),
        {
          targetLang,
          systemPrompt: settings.systemPrompt,
          useJsonFormat: streaming ? false : deps.jsonFormatSupported.value,
          sourceLang: settings.sourceLang,
        },
        {},
        // demux 的下标对应 pendingIdx 的第 k 个元素，这里映射回该 unit 的段落与分片信息
        streaming
          ? (k: number, text: string) => {
              const u = req.units[pendingIdx[k]!]!;
              onDelta!(u.paragraphId, u.sliceIndex, u.sliceTotal, text);
            }
          : undefined,
      );
      // 流式恒 plain 是「流式解析的必然」而非「该供应商不支持 json」，
      // 写进全局记忆会把后续非流式请求也永久降级（见 d952590 / 6f7b392）
      if (!streaming && !r.useJsonFormat && provider.protocol !== 'claude') deps.jsonFormatSupported.value = false;
      for (let k = 0; k < pendingIdx.length; k++) {
        translations[pendingIdx[k]!] = r.translations[k] ?? null;
      }
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: 全绿（scheduler 既有 12 项 + 新增 5 项，其余文件不受影响）。

- [ ] **Step 5: Commit**

```bash
git add lib/translation/scheduler.ts tests/scheduler.test.ts
git commit -m "feat: 调度器透传流式增量并按 unit 映射下标"
```

---

### Task 8: 后台转发增量

**Files:**
- Modify: `entrypoints/background.ts`

- [ ] **Step 1: 实现转发**

`entrypoints/background.ts` 里 `port.onMessage.addListener` 的回调改为：

```ts
    port.onMessage.addListener(async (msg: TranslateRequest) => {
      if (msg.kind !== 'translate') return;
      console.log('[llm-tr] SW received chunk', msg.chunkId, 'units =', msg.units.length); // [diag]
      await acquire();
      try {
        const response: TranslateResponse = await handleTranslateRequest(
          msg,
          {
            translate: translateUnits,
            getCached,
            setCached,
            getSettings,
            jsonFormatSupported,
          },
          msg.stream
            ? (paragraphId, sliceIndex, sliceTotal, text) => {
                // 页面可能在流式过程中导航走了：端口已断时丢弃增量，别让整个请求陪葬
                try {
                  port.postMessage({
                    kind: 'delta',
                    taskId: msg.taskId,
                    chunkId: msg.chunkId,
                    paragraphId,
                    sliceIndex,
                    sliceTotal,
                    text,
                  } satisfies TranslateResponse);
                } catch {
                  /* 端口已断开：增量丢弃 */
                }
              }
            : undefined,
        );
        console.log('[llm-tr] SW response', msg.chunkId, response.kind, response.kind === 'error' ? `${response.code}: ${response.message}` : ''); // [diag]
        port.postMessage(response);
      } catch (e) {
        // 兜底：任何意外异常（如 IndexedDB 故障）也必须回响应，保证每个请求恰好收到一个响应
        port.postMessage({
          kind: 'error',
          taskId: msg.taskId,
          chunkId: msg.chunkId,
          code: 'failed',
          message: e instanceof Error ? e.message : String(e),
        } satisfies TranslateResponse);
      } finally {
        release();
      }
    });
```

- [ ] **Step 2: 类型检查 + 既有单测**

Run: `npm run typecheck && npm test`
Expected: 无类型错误、测试全绿。

- [ ] **Step 3: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat: 后台把流式增量逐条转发给内容脚本"
```

---

### Task 9: 桩服务支持 SSE 与挂起控制

**Files:**
- Modify: `e2e/stub-server.ts`

- [ ] **Step 1: 实现**

`e2e/stub-server.ts` 改为（关键改动：状态加 `holdStream`/`releaseStream`；`stream:true` 走 SSE 分帧，最后一段可挂起等 `release`）：

```ts
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const STUB_PORT = 4789;
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;

interface StubState {
  fail: boolean;
  delayMs: number;
  holdStream: boolean;
  releaseStream: boolean;
}

const STREAM_FRAME_GAP_MS = 30;

// 供 globalSetup 启动的本地打桩服务：
// - /page 托管测试页（file:// 不注入 content script，必须走 http）
// - /chat/completions、/v1/messages 模拟 OpenAI/Claude；请求体 stream:true 时按 SSE 分帧返回
// - /__control 供用例切换失败模式/响应延迟/流式挂起（用例进程与 globalSetup 进程不同，只能走 HTTP 控制）
// 附带 CORS 头：MV3 service worker 跨域 fetch 在无 host 权限时按 CORS 处理，保证 E2E 不依赖原生授权弹窗
export function startStubServer(port = STUB_PORT): http.Server {
  const pageHtml = fs.readFileSync(path.resolve('e2e/test-page.html'), 'utf8');
  const state: StubState = { fail: false, delayMs: 0, holdStream: false, releaseStream: false };

  return http
    .createServer((req, res) => {
      const corsHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', STUB_ORIGIN);

      if (url.pathname === '/page') {
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pageHtml);
        return;
      }

      if (url.pathname === '/__control') {
        if (url.searchParams.has('reset')) {
          state.fail = false;
          state.delayMs = 0;
          state.holdStream = false;
          state.releaseStream = false;
        }
        if (url.searchParams.has('fail')) state.fail = url.searchParams.get('fail') === '1';
        if (url.searchParams.has('delay')) state.delayMs = Number(url.searchParams.get('delay')) || 0;
        if (url.searchParams.has('hold')) state.holdStream = url.searchParams.get('hold') === '1';
        if (url.searchParams.has('release')) state.releaseStream = url.searchParams.get('release') === '1';
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }

      if ((url.pathname === '/chat/completions' || url.pathname === '/v1/messages') && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          setTimeout(() => {
            if (state.fail) {
              // 400 不触发 429/5xx 退避，立即使整个分块失败（用于「失败段落可重试」用例）
              res.writeHead(400, { ...corsHeaders, 'Content-Type': 'text/plain' });
              res.end('forced failure for e2e');
              return;
            }
            const indices = collectIndices(body);
            if (wantsStream(body)) {
              void serveStream(res, corsHeaders, url.pathname, indices, state);
              return;
            }
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            if (url.pathname === '/v1/messages') {
              const text = indices.map((i) => `[${i}] 译文${i}`).join('\n\n');
              res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
            } else {
              const items = indices.map((i) => ({ i, t: `译文${i}` }));
              res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }));
            }
          }, state.delayMs);
        });
        return;
      }

      res.writeHead(404, corsHeaders);
      res.end();
    })
    .listen(port, '127.0.0.1');
}

// 请求体是 JSON：messages 中 user 内容的各段以 "[i] text" 形式编号
function collectIndices(rawBody: string): number[] {
  try {
    const parsed = JSON.parse(rawBody) as { messages?: { role?: string; content?: string }[] };
    const user = parsed.messages?.find((m) => m.role === 'user')?.content ?? '';
    const indices = [...new Set([...user.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
    return indices.sort((a, b) => a - b);
  } catch {
    return [0];
  }
}

function wantsStream(rawBody: string): boolean {
  try {
    return (JSON.parse(rawBody) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

// 把 "[i] 译文i" 全文切成 3 帧：客户端应能只靠前两帧就渲染出各段的前缀，
// 最后一帧留作 hold/release 的把手（用例借此拿到稳定可断言的中间态）。
function contentFrames(protocolPath: string, indices: number[]): string[] {
  const text = indices.map((i) => `[${i}] 译文${i}`).join('\n\n');
  const size = Math.ceil(text.length / 3) || 1;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.map((p) =>
    protocolPath === '/v1/messages'
      ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: p } })}\n\n`
      : `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`,
  );
}

function terminator(protocolPath: string): string {
  return protocolPath === '/v1/messages'
    ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    : 'data: [DONE]\n\n';
}

async function serveStream(
  res: http.ServerResponse,
  corsHeaders: Record<string, string>,
  protocolPath: string,
  indices: number[],
  state: StubState,
): Promise<void> {
  res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frames = contentFrames(protocolPath, indices);
  for (let i = 0; i < frames.length; i++) {
    const isLast = i === frames.length - 1;
    if (isLast && state.holdStream && !state.releaseStream) {
      const deadline = Date.now() + 20_000;
      while (!state.releaseStream && Date.now() < deadline) {
        if (res.destroyed) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      if (res.destroyed) return;
    }
    res.write(frames[i]!);
    if (!isLast) await new Promise((r) => setTimeout(r, STREAM_FRAME_GAP_MS));
  }
  res.write(terminator(protocolPath));
  res.end();
}
```

- [ ] **Step 2: 确认既有 E2E 仍然通过（此时还没有人发 stream:true）**

Run: `npm run build && npm run e2e -- e2e/translate.spec.ts`
Expected: 9 项全绿（原有用例不传 stream，走的还是 JSON 分支）。

- [ ] **Step 3: Commit**

```bash
git add e2e/stub-server.ts
git commit -m "test: 桩服务支持 SSE 分帧与 hold/release 控制"
```

---

### Task 10: 整页流式（内容脚本侧）

**Files:**
- Modify: `entrypoints/content.ts`

- [ ] **Step 1: 请求带 `stream: true`**

`entrypoints/content.ts` 四处构造整页请求的地方都加 `stream: true`（划词的 `selReq` 留到 Task 14）：

1. `startTranslate()` 里的 `const req: TranslateRequest = { kind: 'translate', taskId: id, chunkId: `c${i}`, units: ... }`
2. `onNewContent()` 里的 `chunkId: `c-inc-${batch}-${i}``
3. `retryAllErrors()` 里的 `chunkId: `retry-${pid}``
4. 失败段落重试的 document click 处理里的 `chunkId: `retry-${pid}``

四处都改成形如：

```ts
      const req: TranslateRequest = {
        kind: 'translate', taskId: id, chunkId: `c${i}`,
        units: chunk.units.map(u => ({ paragraphId: u.paragraphId, text: u.text, sliceIndex: u.sliceIndex, sliceTotal: u.sliceTotal })),
        stream: true,
      };
```

- [ ] **Step 2: 处理 delta：累积到分片缓冲并重渲染**

在 `entrypoints/content.ts` 中，把 Task 3 加的早退占位换成真正的分派：

```ts
function onChunkResponse(msg: TranslateResponse): void {
  if (msg.kind === 'delta') { onChunkDelta(msg); return; }
  console.log('[llm-tr] chunk response:', msg.kind, msg.chunkId, msg.kind === 'error' ? `${msg.code}: ${msg.message}` : ''); // [diag]
  ...
```

并新增 `onChunkDelta`（放在 `onChunkResponse` 之前）：

```ts
// 流式增量：只累积与重渲染，不推进任务计数——完成与否一律以紧随其后的 result 为准
function onChunkDelta(msg: Extract<TranslateResponse, { kind: 'delta' }>): void {
  if (!task || msg.taskId !== task.id || task.cancelled) return;
  const entry = task.pending.get(msg.chunkId);
  if (!entry) return;
  const buf = task.sliceBuffers.get(msg.paragraphId) ?? { total: msg.sliceTotal, parts: [] };
  buf.parts[msg.sliceIndex] = (buf.parts[msg.sliceIndex] ?? '') + msg.text;
  task.sliceBuffers.set(msg.paragraphId, buf);
  const host = findHost(task, msg.paragraphId);
  if (host) setHostState(host, 'streaming', buf.parts.join(''));
  armTimer(entry); // 有增量即续期：真卡住 60s 无增量才重发
}
```

- [ ] **Step 3: 重发前清掉该请求涉及的分片缓冲**

`postToPort` 是所有「发起/重发请求」的唯一出口，在这里清缓冲可一次覆盖超时重发、端口重连重发、失败重试三条路径：

```ts
function postToPort(req: TranslateRequest): void {
  resetChunkBuffers(req);
  if (!contextAlive()) return;
  ...
}

// 重发会重新流一遍，不清掉旧片段就会与上一次的残留叠字
function resetChunkBuffers(req: TranslateRequest): void {
  if (!task) return;
  for (const u of req.units) {
    const buf = task.sliceBuffers.get(u.paragraphId);
    if (buf) buf.parts[u.sliceIndex] = '';
  }
}
```

- [ ] **Step 4: 类型检查 + 单测**

Run: `npm run typecheck && npm test`
Expected: 无类型错误、测试全绿。

- [ ] **Step 5: 手动确认 E2E 不回归**

Run: `npm run build && npm run e2e -- e2e/translate.spec.ts`
Expected: 9 项全绿（此时整页已走 SSE，译文应正常出现）。

- [ ] **Step 6: Commit**

```bash
git add entrypoints/content.ts
git commit -m "feat: 整页翻译流式渲染（增量累积 + 重发清缓冲）"
```

---

### Task 11: E2E —— 整页流式与等待态

**Files:**
- Modify: `e2e/translate.spec.ts`

- [ ] **Step 1: 写用例**

在 `e2e/translate.spec.ts` 末尾追加：

```ts
test('整页流式：先流出已完成的段，其余段仍在等待，收流后补全', async ({ context, extensionId, request }) => {
  // hold=1：桩服务写完前两帧后挂起，用例先断言稳定中间态，再放行最后一帧
  await stubControl(request, 'hold=1');
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await sendToTestPage(driver, { kind: 'start' });

  const bodies = page.locator(`${HOST} .body`);
  await expect(bodies).toHaveCount(2, { timeout: 15_000 });
  // 第一段已按增量渲染出完整译文（前缀在流中被逐步追加得到）
  await expect(bodies.nth(0)).toHaveText('译文0', { timeout: 15_000 });
  // 此时响应尚未结束：第二段还停在等待态
  await expect(bodies.nth(1)).toContainText('翻译中');

  await stubControl(request, 'release=1');
  await expect(bodies.nth(1)).toHaveText('译文1', { timeout: 15_000 });
  await stubControl(request, 'reset=1');
});

test('等待态显示三点脉动动画（整页与划词浮窗）', async ({ context, extensionId, request }) => {
  await stubControl(request, 'delay=3000');
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await sendToTestPage(driver, { kind: 'start' });
  const dots = page.locator(`${HOST} .body .dots`);
  await expect(dots.first()).toBeVisible({ timeout: 10_000 });
  expect(await dots.count()).toBe(2);          // 两个段落各一处
  expect(await page.locator(`${HOST} .dots i`).count()).toBe(6); // 每处三个点

  // 划词浮窗同样有等待动画
  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator(`${SEL} .dot`).click();
  await expect(page.locator(`${SEL} .panel .body .dots`)).toBeVisible({ timeout: 10_000 });

  await stubControl(request, 'reset=1');
});
```

- [ ] **Step 2: 跑用例**

Run: `npm run build && npm run e2e -- e2e/translate.spec.ts -g "整页流式|等待态"`
Expected: 2 项 PASS。

若 `整页流式` 在 `toHaveText('译文0')` 处超时：说明增量没有推进到第一段结束——
检查桩服务的分帧粒度与 demux 的挂起逻辑，而不是放宽断言。

- [ ] **Step 3: 全量 E2E**

Run: `npm run e2e`
Expected: 全绿（`translate.spec.ts` 11 项 + `self-heal.spec.ts`）。

- [ ] **Step 4: Commit**

```bash
git add e2e/translate.spec.ts
git commit -m "test: 整页流式与等待态三点动画的 E2E"
```

---

### Task 12: 划词浮窗——鼠标透明、流式追加、动画

**Files:**
- Modify: `lib/renderer/selection.ts`
- Test: `tests/selection.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/selection.test.ts` 里替换 `setPanelState 三态` 用例中的 loading 断言，并追加新用例：

```ts
  it('setPanelState 三态：loading / done / error（含重试按钮）', () => {
    const { ui } = makeUI();
    ui.showPanel(10, 10, 'm');
    const body = () => ui.host.shadowRoot!.querySelector('.body') as HTMLElement;
    ui.setPanelState('loading');
    expect(body().textContent).toBe('翻译中…');            // 三点自身无文本，不掺进 textContent
    expect(body().querySelectorAll('.dots i')).toHaveLength(3);
    ui.setPanelState('done', '你好世界');
    expect(body().textContent).toBe('你好世界');
    expect(body().querySelector('.dots')).toBeNull();
    ui.setPanelState('error', 'API Key 无效');
    expect(body().textContent).toContain('API Key 无效');
    expect(body().querySelector('[data-sel-retry]')).not.toBeNull();
    ui.setPanelState('error', 'API Key 无效');
    expect(body().querySelectorAll('[data-sel-retry]')).toHaveLength(1); // 重复置错不叠按钮
  });

  it('appendPanelText：切到流式态并逐段追加，done 时覆盖为权威文本', () => {
    const { ui } = makeUI();
    ui.showPanel(10, 10, 'm');
    ui.setPanelState('loading');
    const body = () => ui.host.shadowRoot!.querySelector('.body') as HTMLElement;
    ui.appendPanelText('半截');
    expect(body().className).toBe('body streaming');
    expect(body().textContent).toBe('半截');
    ui.appendPanelText('译文');
    expect(body().textContent).toBe('半截译文');
    ui.setPanelState('done', '半截译文（权威）');
    expect(body().className).toBe('body done');
    expect(body().textContent).toBe('半截译文（权威）');
  });

  it('appendPanelText：浮窗关闭时静默忽略；hidePanel 后重新流式从零开始', () => {
    const { ui } = makeUI();
    const body = () => ui.host.shadowRoot!.querySelector('.body') as HTMLElement;
    ui.appendPanelText('丢弃');
    expect(body().textContent).toBe('翻译中…');
    ui.showPanel(10, 10, 'm');
    ui.setPanelState('loading');
    ui.appendPanelText('甲');
    ui.hidePanel();
    ui.showPanel(10, 10, 'm');
    ui.setPanelState('loading');
    ui.appendPanelText('乙');
    expect(body().textContent).toBe('乙');
  });

  it('浮窗对鼠标透明：面板本身 none，按钮与溢出正文可交互', () => {
    const { ui } = makeUI();
    ui.showPanel(10, 10, 'm');
    const panel = ui.host.shadowRoot!.querySelector('.panel') as HTMLElement;
    expect(panel.classList.contains('pop')).toBe(true); // 入场动画类
    // jsdom 不跑布局，scrollHeight/clientHeight 恒为 0 → 判定为不溢出
    const body = ui.host.shadowRoot!.querySelector('.body') as HTMLElement;
    expect(body.classList.contains('scrollable')).toBe(false);
  });

  it('isDotVisible / containsNode', () => {
    const { ui } = makeUI();
    expect(ui.isDotVisible()).toBe(false);
    ui.showDot(10, 10);
    expect(ui.isDotVisible()).toBe(true);
    ui.hideDot();
    expect(ui.isDotVisible()).toBe(false);
    const inside = ui.host.shadowRoot!.querySelector('.dot')!;
    expect(ui.containsNode(inside)).toBe(true);
    expect(ui.containsNode(ui.host)).toBe(true);
    expect(ui.containsNode(document.body)).toBe(false);
    expect(ui.containsNode(null)).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/selection.test.ts`
Expected: FAIL —— `appendPanelText` / `isDotVisible` / `containsNode` 不存在，loading 无 `.dots`。

- [ ] **Step 3: 实现**

`lib/renderer/selection.ts` 的改动：

1) 顶部 import：

```ts
import { MOTION_CSS, replayPop, setLoading } from './motion';
```

2) `SelUI` 接口增三项：

```ts
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
```

3) `SHADOW_CSS` 增分层与动画（把 MOTION_CSS 内联进来）：

```ts
const SHADOW_CSS = `
:host { position: absolute; left: 0; top: 0; z-index: 2147483647; }
.dot[hidden], .panel[hidden] { display: none; }
.dot {
  width: 26px; height: 26px; border-radius: 50%; border: none; cursor: pointer; padding: 0;
  background: #e91e63; color: #fff; font-size: 13px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}
/* 浮窗默认对鼠标透明：否则它会盖住下方正文，从浮窗上起手的拖拽既选不中文字、
   又因命中自身而被 early-return，表现为「浮窗停在上一处选区」。按钮与溢出正文单独放行。 */
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
```

4) 状态与助手（放在 `let pinned = false;` 那一组变量旁）：

```ts
  let pinned = false;
  let streaming = false; // 处于流式追加态：正文里是「累积的增量」而非权威文本
  let lastText = '';
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  // 溢出才恢复滚动：短译文保持 pointer-events:none，彻底让开下方正文
  function toggleScrollable(): void {
    bodyEl.classList.toggle('scrollable', bodyEl.scrollHeight > bodyEl.clientHeight);
  }
```

5) `hidePanel` 里重置流式态：

```ts
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
```

6) 返回对象的方法改为：

```ts
  return {
    host,
    showDot(x, y) {
      hidePanel();
      // 圆钮贴选区尾，可能落到视口外：夹一下，避免出现在屏幕外
      const p = clampPosition(x, y, 26, 26, doc.defaultView?.innerWidth ?? 1024, doc.defaultView?.innerHeight ?? 768);
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
```

注意 `setPanelState('error')` 现在把 `bodyEl.className` 重置后再 append 按钮，重复调用不会叠加按钮（`bodyEl.textContent = ...` 会先清空子节点）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/selection.test.ts`
Expected: PASS（既有 5 项 + 新增 5 项）。

- [ ] **Step 5: Commit**

```bash
git add lib/renderer/selection.ts tests/selection.test.ts
git commit -m "feat: 浮窗对鼠标透明、支持流式追加与入场/等待动画"
```

---

### Task 13: 圆钮/浮窗锚定选区（含遮挡回归）

**Files:**
- Modify: `entrypoints/content.ts`
- Test: `e2e/translate.spec.ts`

> 先写红用例再改实现：探针实测过，「浮窗盖住下一段文本、从其上方起手拖拽选不中」是稳定可复现的。

- [ ] **Step 1: 写失败的回归用例 + 给现有划词用例加位置断言**

在 `e2e/translate.spec.ts` 中，把现有 `划词翻译：选中文本出现圆钮，点击弹出浮窗显示译文` 用例改为（尾部追加位置断言）：

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

  // 圆钮贴「选区尾」，而不是 mouseup 的鼠标坐标 (100,100)
  const expected = await page.evaluate(() => {
    const rects = window.getSelection()!.getRangeAt(0).getClientRects();
    const last = rects[rects.length - 1]!;
    return { x: last.right + window.scrollX, y: last.bottom + window.scrollY };
  });
  const dotBox = (await dot.boundingBox())!;
  expect(Math.abs(dotBox.x - (expected.x + 6))).toBeLessThan(4);
  expect(Math.abs(dotBox.y - (expected.y + 6))).toBeLessThan(4);
  expect(dotBox.x).toBeGreaterThan(200); // 远离鼠标坐标 (100,100)，钉死「不再用鼠标位置」

  await dot.click();
  const panel = page.locator(`${SEL} .panel`);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('译文', { timeout: 15_000 });
});
```

并在文件末尾追加遮挡回归用例：

```ts
test('浮窗打开时不遮挡下一段正文的划词（回归）', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  // 选中第一段 → 点圆钮 → 浮窗落在选区下方，正好盖住第二段所在行的左半部分
  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator(`${SEL} .dot`).click();
  await expect(page.locator(`${SEL} .panel`)).toBeVisible();
  await expect(page.locator(`${SEL} .panel`)).toContainText('译文', { timeout: 15_000 });

  const panelBox = (await page.locator(SEL).boundingBox())!;
  const p2 = (await page.locator('article p').nth(1).boundingBox())!;
  const y = p2.y + p2.height / 2;
  // 起手点必须落在浮窗覆盖区内，否则这个用例测不到遮挡
  expect(panelBox.y).toBeLessThanOrEqual(y);
  expect(panelBox.y + panelBox.height).toBeGreaterThanOrEqual(y);

  // 从浮窗覆盖区内部起手，长拖到行尾
  await page.mouse.move(panelBox.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(1268, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('second sufficiently long English paragraph');
  await expect(page.locator(`${SEL} .dot`)).toBeVisible({ timeout: 10_000 });
});

test('键盘扩选时圆钮跟随新选区尾', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  // 先选中第一段的一小段，让圆钮出现
  await page.evaluate(() => {
    const text = document.querySelector('article p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 10);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.locator(`${SEL} .dot`)).toBeVisible({ timeout: 10_000 });

  // 程序化扩大选区（等价于 Shift+方向键）：不派发 mouseup，只发 selectionchange
  await page.evaluate(() => {
    const text = document.querySelectorAll('article p')[1]!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 24);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  const expected = await page.evaluate(() => {
    const rects = window.getSelection()!.getRangeAt(0).getClientRects();
    const last = rects[rects.length - 1]!;
    return { x: last.right + window.scrollX, y: last.bottom + window.scrollY };
  });
  await expect(async () => {
    const box = (await page.locator(`${SEL} .dot`).boundingBox())!;
    expect(Math.abs(box.x - (expected.x + 6))).toBeLessThan(4);
    expect(Math.abs(box.y - (expected.y + 6))).toBeLessThan(4);
  }).toPass({ timeout: 5_000 });
});
```

- [ ] **Step 2: 跑用例确认失败（红）**

Run: `npm run build && npm run e2e -- e2e/translate.spec.ts -g "划词|遮挡|跟随"`
Expected: `浮窗打开时不遮挡下一段正文的划词（回归）` FAIL（`selected` 为空串）、`圆钮贴选区尾` 断言 FAIL（旧实现贴鼠标坐标）、`键盘扩选时圆钮跟随` FAIL（无 selectionchange 处理）。
`划词翻译` 主体应仍 PASS（圆钮位置断言可能已失败——那正是要修的点）。

- [ ] **Step 3: 实现选区锚定**

在 `entrypoints/content.ts` 中：

1) 新增两个助手（放在 `initSelectionTranslate` 之前）：

```ts
function selectionText(): string {
  return window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
}

/**
 * 选区几何锚点：圆钮贴选区尾（最后一段 rect 的右下角），浮窗贴选区首行左下。
 * 用选区而不是 mouseup 的鼠标坐标——鼠标坐标会停在「上一次选中的文字尾部」。
 */
function selectionAnchor(): { x: number; y: number; endX: number; endY: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const rects = Array.from(sel.getRangeAt(0).getClientRects()).filter(r => r.width > 0 || r.height > 0);
  if (rects.length === 0) return null;
  const first = rects[0]!;
  const last = rects[rects.length - 1]!;
  return {
    x: first.left + window.scrollX,
    y: first.bottom + window.scrollY,
    endX: last.right + window.scrollX,
    endY: last.bottom + window.scrollY,
  };
}

function showDotAtSelection(): void {
  if (!selUI || selectionText().length < 2) return;
  const a = selectionAnchor();
  if (!a) return;
  selUI.showDot(a.endX + 6, a.endY + 6);
}
```

2) `initSelectionTranslate` 里 `ctx.addEventListener(document, 'mouseup', ...)` 的 `selUI?.showDot(e.pageX + 8, e.pageY + 8);` 那一行换成：

```ts
      showDotAtSelection();
```

（该回调里的 `const text = window.getSelection()?...` 一行同时删掉，`text.length < 2` 的判断已移进 `showDotAtSelection`。）

3) 在 mousedown 监听器之后新增 selectionchange 监听器：

```ts
  // 选区变了就说明面板里的译文已经不是「当前这段文本」的译文了；
  // 但「点击圆钮/浮窗按钮导致选区塌陷」不能算变化，否则浮窗会在打开的瞬间被自己关掉。
  ctx.addEventListener(document, 'selectionchange', () => {
    if (!selUI) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    if (selUI.containsNode(sel.anchorNode)) return; // 浮窗正文内选中：忽略
    const text = selectionText();
    if (text.length < 2) return;
    if (!selUI.isPinned() && text !== selReq?.units[0]?.text) selUI.hidePanel();
    if (selUI.isDotVisible()) showDotAtSelection(); // 键盘扩选：圆钮跟随新选区尾
  });
```

4) `onSelDotClick` 里的定位改为用选区锚点：

```ts
async function onSelDotClick(): Promise<void> {
  if (!selUI || !contextAlive()) return;
  const text = selectionText();
  selUI.hideDot();
  if (text.length < 2) return; // 选区已取消：不发请求
  const anchor = selectionAnchor();
  if (!anchor) return;
  const s = await getSettings();
  const provider = getActiveProvider(s);
  const model = provider ? `${provider.name} · ${resolveModel(provider)}` : '';
  selUI.showPanel(anchor.x, anchor.y + 6, model);
  selUI.setPanelState('loading');
  selReq = {
    kind: 'translate',
    taskId: `sel-${Date.now()}`,
    chunkId: 'c0',
    units: [{ paragraphId: 'sel', text, sliceIndex: 0, sliceTotal: 1 }],
    targetLang: cjkRatio(text) > 0.5 ? 'English' : s.targetLang,
  };
  postToPort(selReq);
  armSelTimer();
}
```

- [ ] **Step 4: 跑用例确认通过（绿）**

Run: `npm run build && npm run e2e -- e2e/translate.spec.ts -g "划词|遮挡|跟随"`
Expected: 4 项 PASS。

- [ ] **Step 5: 全量 E2E（确认没打破整页那几个用例）**

Run: `npm run e2e`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add entrypoints/content.ts e2e/translate.spec.ts
git commit -m "fix: 划词浮窗改为锚定选区且不再遮挡拖拽划词"
```

---

### Task 14: 划词流式

**Files:**
- Modify: `entrypoints/content.ts`
- Test: `e2e/translate.spec.ts`

- [ ] **Step 1: 写失败用例**

在 `e2e/translate.spec.ts` 末尾追加：

```ts
test('划词流式：面板先出现译文前缀，收流后补全', async ({ context, extensionId, request }) => {
  await stubControl(request, 'hold=1');
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

  await page.locator(`${SEL} .dot`).click();
  const body = page.locator(`${SEL} .panel .body`);
  // 挂起在最后一帧之前：此时译文是终值的严格前缀
  await expect(body).toHaveText('译文', { timeout: 15_000 });
  // 流式态已经不再是等待态：三点消失，正文换成累积译文
  expect(await page.locator(`${SEL} .panel .body .dots`).count()).toBe(0);

  await stubControl(request, 'release=1');
  await expect(body).toHaveText('译文0', { timeout: 15_000 });
  await stubControl(request, 'reset=1');
});
```

- [ ] **Step 2: 跑用例确认失败**

Run: `npm run build && npm run e2e -- e2e/translate.spec.ts -g "划词流式"`
Expected: FAIL —— 划词请求还没带 `stream:true`，面板只会一次性出现 `译文0`，`toHaveText('译文')` 超时。

- [ ] **Step 3: 实现**

在 `entrypoints/content.ts` 中：

1) `selReq` 加 `stream: true`（Task 13 里已经是新写法，这里只加一行）：

```ts
    units: [{ paragraphId: 'sel', text, sliceIndex: 0, sliceTotal: 1 }],
    targetLang: cjkRatio(text) > 0.5 ? 'English' : s.targetLang,
    stream: true,
```

2) `onChunkResponse` 顶部的 delta 分派改为按 taskId 分流：

```ts
function onChunkResponse(msg: TranslateResponse): void {
  if (msg.kind === 'delta') {
    // 划词的 delta 归面板，整页的归 host
    if (msg.taskId.startsWith('sel-')) onSelDelta(msg);
    else onChunkDelta(msg);
    return;
  }
  ...
```

3) 新增 `onSelDelta`：

```ts
// 划词流式：增量直接追加到面板正文；最终文本仍以随后的 result 为准
function onSelDelta(msg: Extract<TranslateResponse, { kind: 'delta' }>): void {
  if (!selReq || msg.taskId !== selReq.taskId) return; // 陈旧响应：忽略
  selUI?.appendPanelText(msg.text);
  armSelTimer(); // 有增量即续期
}
```

- [ ] **Step 4: 跑用例确认通过**

Run: `npm run build && npm run e2e -- e2e/translate.spec.ts -g "划词流式"`
Expected: PASS。

- [ ] **Step 5: 全量验证**

Run: `npm test && npm run typecheck && npm run e2e`
Expected: 单测全绿、无类型错误、E2E 全绿。

- [ ] **Step 6: Commit**

```bash
git add entrypoints/content.ts e2e/translate.spec.ts
git commit -m "feat: 划词翻译流式渲染到浮窗"
```

---

## 覆盖对照（spec → 任务）

| spec 要求 | 落在哪个 Task |
|---|---|
| 圆钮/浮窗锚定选区、`selectionchange` 跟随 | Task 13 |
| 浮窗 `pointer-events` 分层 + 溢出恢复滚动 | Task 12（样式与 `toggleScrollable`）+ Task 13（回归用例） |
| 选区变化收起未 pin 的旧浮窗（排除折叠与自身 UI） | Task 13 |
| 等待态三点脉动 | Task 4 + Task 5（host）+ Task 12（浮窗）+ Task 11（E2E） |
| 流式光标 / 入场动画 / reduced-motion | Task 4 + Task 5 + Task 12 |
| `stream?` 与 `{kind:'delta'}` 协议 | Task 3 |
| `sse.ts` 自解帧 | Task 1 |
| `marker-demux`（半截标记挂起、越界不认、引言丢弃） | Task 2 |
| 流式恒 plain、不翻转 `jsonFormatSupported` | Task 6 + Task 7 |
| 调度器下标 → unit 映射 | Task 7 |
| 后台逐条转发 delta | Task 8 |
| 整页增量累积与重渲染、delta 续期、重发清缓冲 | Task 10 |
| 划词增量追加到面板、`result` 权威覆盖 | Task 12 + Task 14 |
| 桩服务 SSE + 可挂起 | Task 9 |
| E2E：划词/整页流式、浮窗不挡划词、圆钮锚定、等待态 | Task 11 + Task 13 + Task 14 |

## 自审记录

**1. 占位符扫描：** 全文无 TBD/TODO；每个改动步骤都给了完整代码或精确的替换点。

**2. 内部一致性：**

- Task 3 引入 `delta` 联合类型后，`content.ts` 的 `onChunkResponse` 会出现类型错误——已在 Task 3 Step 2 用早退占位解决，Task 10/14 再换成真实分支。
- 顺序上，桩服务（Task 9）必须早于内容脚本发 `stream:true`（Task 10）：否则内容脚本会对着 JSON 响应跑 SSE 解析，所有段落解析失败，既有 E2E 会红。反之桩服务先支持 SSE 不会影响老链路（没人发 `stream:true`）。
- `streaming ? false : deps.jsonFormatSupported.value` 与「不写入 `jsonFormatSupported`」成对出现：前者恒 plain，后者不改全局记忆，两者缺一都会破坏 `d952590` 的语义。
- 划词的 `selReq` 在 Task 13 才显式写 `stream: true`（Task 14 才接线），Task 10 只给整页请求加该字段——避免面板在还没有 delta 分支时空转。
- `paragraphId` 语义贯穿一致：整页用段落 id、划词用 `'sel'`，`onChunkDelta`/`onSelDelta` 按 `taskId` 前缀分流（而不是按 paragraphId），与既有 `onChunkResponse` 的判断方式一致。

**3. 类型/命名一致性：**

- `readSse` / `createMarkerDemux` / `DeltaHandler` / `DeltaSink` / `MOTION_CSS` / `setLoading` / `replayPop` / `appendPanelText` / `isDotVisible` / `containsNode` / `onChunkDelta` / `onSelDelta` / `selectionAnchor` / `showDotAtSelection` / `resetChunkBuffers` / `contentFrames` / `serveStream` / `wantsStream` / `hold` / `release` 在全文各处拼写一致。
- `setHostState` 的 state 联合在 Task 5 扩为四值，Task 10 使用 `'streaming'`；（`'loading' | 'done' | 'error'` 的既有调用点不受影响）。
- `translateUnits` 第 5 参数 `onDelta` 在 Task 6 定义、Task 7 透传，签名一致。

**4. 已知风险（实现时若命中，先查根因再改断言）：**

- 桩服务 3 帧的切分点与 demux 的挂起点耦合：若改分帧粒度，Task 11 / Task 14 的中间态断言要一起改（这也是把切分逻辑集中到 `contentFrames` 一个函数里的原因）。
- `.body.scrollable` 依赖真实布局（jsdom 恒不溢出），只能用真实浏览器观察；E2E 的功能用例（从浮窗上方起手拖拽）已经覆盖了真正要保证的行为。
- 浮窗高度随译文变化，Task 13 的回归用例自带「起手点必须落在浮窗覆盖区内」的前置断言，几何漂移时会明确失败而不是静默通过。