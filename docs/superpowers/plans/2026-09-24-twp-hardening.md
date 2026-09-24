# 参考 TWP 的整页翻译加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留双语译文块范式，借鉴 TWP 加固整页翻译：提取层跳过表、300ms 轮询视口惰性调度、同文本别名合并扇出、代际失效补齐。

**Architecture:** 提取层在 `lib/extraction/paragraphs.ts` 增加跳过表；新纯逻辑模块 `lib/translation/lazy-pool.ts`（视口池）与 `lib/translation/alias.ts`（同文本分组）承载全部可测逻辑；`entrypoints/content.ts` 只做接线：段落入池、定时器泵取、发送与扇出。

**Tech Stack:** TypeScript、WXT、vitest（jsdom）。

**Spec:** `docs/superpowers/specs/2026-09-24-twp-hardening-design.md`

## Global Constraints

- 不改为文本节点原地替换渲染；不改 `background.ts`、`lib/translation/scheduler.ts`、`lib/cache/`。
- 惰性调度用 300ms `setInterval` 轮询 + `getBoundingClientRect`（TWP 路线），不用 IntersectionObserver。
- 视口外扩 margin 固定 200px；轮询间隔固定 300ms。
- `STATE_ATTR` 标记与宿主块创建推迟到「取出并发送」时，入池不做。
- 测试框架 vitest；命令 `npx vitest run`；构建 `npx wxt build`。
- 提交信息用中文，格式 `type: 描述`。

---

### Task 1: 提取层跳过表

**Files:**
- Modify: `lib/extraction/paragraphs.ts`
- Test: `tests/paragraphs.test.ts`

**Interfaces:**
- Consumes: 现有 `EXCLUDED_ANCESTOR_SELECTOR`（`lib/extraction/scoring.ts:8`）。
- Produces: `SKIPPED_ANCESTOR_SELECTOR` 常量；`extractParagraphs` 过滤链新增 notranslate / translate=no / contenteditable / 图标字体跳过。

- [ ] **Step 1: 写失败测试**

在 `tests/paragraphs.test.ts` 的 `describe('extractParagraphs')` 末尾追加：

```ts
  it('跳过表：notranslate / translate=no / contenteditable / 图标字体', () => {
    const r = root(`
      <div class="notranslate"><p>${LONG}</p></div>
      <div translate="no"><p>${LONG}</p></div>
      <div contenteditable="true"><p>${LONG}</p></div>
      <p class="material-icons">${LONG}</p>
      <div class="CodeMirror"><p>${LONG}</p></div>
      <p>${LONG}</p>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps).toHaveLength(1);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/paragraphs.test.ts`
Expected: FAIL，新用例提取到 6 段而非 1 段。

- [ ] **Step 3: 实现跳过表**

在 `lib/extraction/paragraphs.ts` 中，`DIV_MIN_LENGTH` 常量之后新增：

```ts
// 业界跳过约定与图标/代码字体容器（借鉴 TWP）：整棵子树不翻译
export const SKIPPED_ANCESTOR_SELECTOR =
  '.notranslate, [translate="no"], [contenteditable]:not([contenteditable="false"]), .CodeMirror, .material-icons, .material-symbols-outlined, .material-symbols-rounded';
```

修改 `extractParagraphs` 中 `excludedAncestors` 的拼装（原第 55-57 行）：

```ts
  const excludedAncestors = rule?.extraExcludes
    ? `${EXCLUDED_ANCESTOR_SELECTOR}, ${SKIPPED_ANCESTOR_SELECTOR}, ${rule.extraExcludes}`
    : `${EXCLUDED_ANCESTOR_SELECTOR}, ${SKIPPED_ANCESTOR_SELECTOR}`;
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/paragraphs.test.ts`
Expected: PASS（含既有用例，注意 GitHub `extraIncludes` 用例应不受影响）。

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/paragraphs.ts tests/paragraphs.test.ts
git commit -m "feat: 提取层新增 notranslate/translate=no/contenteditable/图标字体跳过表"
```

---

### Task 2: LazyPool 视口池

**Files:**
- Create: `lib/translation/lazy-pool.ts`
- Test: `tests/lazy-pool.test.ts`

**Interfaces:**
- Consumes: `Paragraph`（`lib/extraction/paragraphs.ts:4`，`{ id: string; element: Element; text: string }`）。
- Produces:
  ```ts
  export interface RectLike { top: number; bottom: number }
  export class LazyPool {
    add(p: Paragraph): void;                    // 按 id 去重
    addAll(ps: Paragraph[]): void;
    takeVisible(getRect: (el: Element) => RectLike, viewportHeight: number, margin?: number): Paragraph[];
    removeMany(ids: string[]): Paragraph[];     // 返回被移除的段落，未命中静默跳过
    prune(): number;                            // 剔除 !element.isConnected，返回剔除数
    get size(): number;
    clear(): void;
  }
  ```

- [ ] **Step 1: 写失败测试**

创建 `tests/lazy-pool.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { LazyPool, type RectLike } from '../lib/translation/lazy-pool';
import type { Paragraph } from '../lib/extraction/paragraphs';

function p(id: string, top: number, bottom = top + 20): Paragraph {
  const el = document.createElement('p');
  el.textContent = `paragraph ${id}`;
  document.body.appendChild(el);
  el.setAttribute('data-top', String(top));
  el.setAttribute('data-bottom', String(bottom));
  return { id, element: el, text: `paragraph ${id}` };
}

const rectOf = (el: Element): RectLike => ({
  top: Number(el.getAttribute('data-top')),
  bottom: Number(el.getAttribute('data-bottom')),
});

describe('LazyPool', () => {
  it('takeVisible：只取出视口（含 margin）内的段落并移出池', () => {
    const pool = new LazyPool();
    pool.addAll([p('a', 0), p('b', 500), p('c', 900), p('d', 1300)]);
    const taken = pool.takeVisible(rectOf, 800, 200);
    expect(taken.map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(pool.size).toBe(1);
  });

  it('add：同 id 去重', () => {
    const pool = new LazyPool();
    const a = p('a', 0);
    pool.add(a);
    pool.add(a);
    expect(pool.size).toBe(1);
  });

  it('removeMany：返回被移除段落，未命中静默', () => {
    const pool = new LazyPool();
    pool.addAll([p('a', 0), p('b', 10), p('c', 20)]);
    const removed = pool.removeMany(['a', 'c', 'zzz']);
    expect(removed.map(x => x.id)).toEqual(['a', 'c']);
    expect(pool.size).toBe(1);
  });

  it('prune：剔除已断开节点，返回剔除数', () => {
    const pool = new LazyPool();
    const gone = p('gone', 0);
    pool.addAll([gone, p('stay', 0)]);
    gone.element.remove();
    expect(pool.prune()).toBe(1);
    expect(pool.size).toBe(1);
  });

  it('clear：清空', () => {
    const pool = new LazyPool();
    pool.addAll([p('a', 0), p('b', 0)]);
    pool.clear();
    expect(pool.size).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/lazy-pool.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 LazyPool**

创建 `lib/translation/lazy-pool.ts`：

```ts
import type { Paragraph } from '../extraction/paragraphs';

export interface RectLike { top: number; bottom: number }

const DEFAULT_MARGIN = 200;

export class LazyPool {
  private items = new Map<string, Paragraph>();

  add(p: Paragraph): void {
    if (!this.items.has(p.id)) this.items.set(p.id, p);
  }

  addAll(ps: Paragraph[]): void {
    for (const p of ps) this.add(p);
  }

  takeVisible(getRect: (el: Element) => RectLike, viewportHeight: number, margin = DEFAULT_MARGIN): Paragraph[] {
    const taken: Paragraph[] = [];
    for (const [id, p] of this.items) {
      const r = getRect(p.element);
      if (r.bottom >= -margin && r.top <= viewportHeight + margin) {
        taken.push(p);
        this.items.delete(id);
      }
    }
    return taken;
  }

  removeMany(ids: string[]): Paragraph[] {
    const removed: Paragraph[] = [];
    for (const id of ids) {
      const p = this.items.get(id);
      if (p) {
        removed.push(p);
        this.items.delete(id);
      }
    }
    return removed;
  }

  prune(): number {
    let n = 0;
    for (const [id, p] of this.items) {
      if (!p.element.isConnected) {
        this.items.delete(id);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/lazy-pool.test.ts`
Expected: PASS 5 个用例。

- [ ] **Step 5: Commit**

```bash
git add lib/translation/lazy-pool.ts tests/lazy-pool.test.ts
git commit -m "feat: LazyPool 视口惰性池（id 去重/可见取出/别名移除/断点回收）"
```

---

### Task 3: 同文本别名分组

**Files:**
- Create: `lib/translation/alias.ts`
- Test: `tests/alias.test.ts`

**Interfaces:**
- Consumes: `Paragraph`。
- Produces:
  ```ts
  export function buildAliases(ps: Paragraph[]): Map<string, string[]>; // 规范文本 -> 段落 id 列表
  export function mergeAliases(target: Map<string, string[]>, ps: Paragraph[]): void; // 追加且 id 去重
  ```

- [ ] **Step 1: 写失败测试**

创建 `tests/alias.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildAliases, mergeAliases } from '../lib/translation/alias';
import type { Paragraph } from '../lib/extraction/paragraphs';

function p(id: string, text: string): Paragraph {
  return { id, element: document.createElement('p'), text };
}

describe('buildAliases / mergeAliases', () => {
  it('同文本归为一组，保持入组顺序', () => {
    const m = buildAliases([p('a', 'hello'), p('b', 'world'), p('c', 'hello')]);
    expect(m.get('hello')).toEqual(['a', 'c']);
    expect(m.get('world')).toEqual(['b']);
  });

  it('mergeAliases：并入既有组且 id 去重', () => {
    const m = buildAliases([p('a', 'hello')]);
    mergeAliases(m, [p('a', 'hello'), p('b', 'hello'), p('c', 'new')]);
    expect(m.get('hello')).toEqual(['a', 'b']);
    expect(m.get('new')).toEqual(['c']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/alias.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

创建 `lib/translation/alias.ts`：

```ts
import type { Paragraph } from '../extraction/paragraphs';

export function buildAliases(ps: Paragraph[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  mergeAliases(m, ps);
  return m;
}

export function mergeAliases(target: Map<string, string[]>, ps: Paragraph[]): void {
  for (const p of ps) {
    const ids = target.get(p.text);
    if (ids) {
      if (!ids.includes(p.id)) ids.push(p.id);
    } else {
      target.set(p.text, [p.id]);
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/alias.test.ts`
Expected: PASS 2 个用例。

- [ ] **Step 5: Commit**

```bash
git add lib/translation/alias.ts tests/alias.test.ts
git commit -m "feat: 同文本别名分组工具"
```

---

### Task 4: content.ts 接线（惰性调度 + 别名扇出 + 代际补齐）

**Files:**
- Modify: `entrypoints/content.ts`

**Interfaces:**
- Consumes: `LazyPool`（Task 2）、`buildAliases` / `mergeAliases`（Task 3）。
- Produces: 无新导出；`Task` 接口新增 `aliases: Map<string, string[]>` 字段。

说明：本任务为接线，`content.ts` 依赖 `#imports` / `defineContentScript`，不进 vitest；验证靠既有测试套件不回归 + 构建 + 手动核对清单（Step 4）。

**代际审计结论**（先行记录，作为修改依据）：陈旧 delta/result 已被 `msg.taskId !== task.id || task.cancelled` 拦截（`content.ts:265,313`）；`onChunkTimeout`、port 重连重发均有 `task`/`cancelled` 闸。缺口仅两处：① 取消任务时池与定时器未清理（本次新增的状态）；② `completeChunk` 的完成判定未考虑池内未发段落。本任务一并修复。

- [ ] **Step 1: 模块状态与 Task 接口**

`entrypoints/content.ts` 顶部 import 区追加：

```ts
import { LazyPool } from '../lib/translation/lazy-pool';
import { buildAliases, mergeAliases } from '../lib/translation/alias';
```

常量区（`MAX_RESENDS` 之后）追加：

```ts
const POOL_TICK_MS = 300;
const VIEWPORT_MARGIN = 200;
```

`Task` 接口（第 33-43 行）新增字段：

```ts
interface Task {
  id: string;
  cancelled: boolean;
  total: number;
  done: number;
  pending: Map<string, PendingEntry>;
  sliceBuffers: Map<string, { total: number; parts: string[] }>;
  paragraphs: Map<string, Paragraph>;
  errors: Set<string>;
  observer: MutationObserver | null;
  aliases: Map<string, string[]>;
}
```

模块状态（`let speaking = false;` 之后）追加：

```ts
let pool = new LazyPool();
let ticker: ReturnType<typeof setInterval> | null = null;
let chunkSeq = 0;
```

- [ ] **Step 2: collectParagraphs 移除文本丢弃兜底**

把 `collectParagraphs`（第 89-101 行）中的文本级丢弃改回只按 `STATE_ATTR` 过滤（同文本段落交由别名机制处理）：

```ts
async function collectParagraphs(): Promise<Paragraph[]> {
  const s = await getSettings();
  const root = findContentRoot(document, SITE_RULE);
  const ps = extractParagraphs(root, { minLength: s.minLength, cjkRatioThreshold: s.cjkRatioThreshold }, browserIsVisible, SITE_RULE);
  const fresh = ps.filter(p => !p.element.hasAttribute(STATE_ATTR));
  fresh.forEach(p => { p.id = stableId(p.element); });
  return fresh;
}
```

- [ ] **Step 3: 新增池泵与定时器控制、别名工具函数**

在 `sendChunk` 函数之后插入：

```ts
function aliasIds(t: Task, p: Paragraph): string[] {
  return t.aliases.get(p.text) ?? [p.id];
}

// 池泵：取出视口内段落（含别名扩展），打标、建宿主、按规范文本去重后发块
function pump(): void {
  if (!task || task.cancelled) return;
  try {
    pool.prune();
    const taken = pool.takeVisible(
      (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; },
      window.innerHeight,
      VIEWPORT_MARGIN,
    );
    if (taken.length === 0) {
      if (pool.size === 0) stopTicker();
      return;
    }
    // 别名扩展：同文本段落一并取出，只发一份文本
    const batch = new Map<string, Paragraph>();
    for (const p of taken) {
      batch.set(p.id, p);
      const rest = aliasIds(task, p).filter(id => !batch.has(id));
      for (const q of pool.removeMany(rest)) batch.set(q.id, q);
    }
    for (const p of batch.values()) {
      task.paragraphs.set(p.id, p);
      p.element.setAttribute(STATE_ATTR, 'pending');
      ensureHost(p.element, hostId(task.id, p.id));
    }
    const canonical = new Map<string, Paragraph>();
    for (const p of batch.values()) if (!canonical.has(p.text)) canonical.set(p.text, p);
    const chunks = buildChunks([...canonical.values()].map(p => ({ id: p.id, text: p.text })));
    task.total += chunks.length;
    for (const chunk of chunks) {
      const req: TranslateRequest = {
        kind: 'translate', taskId: task.id, chunkId: `c${chunkSeq++}`, stream: true,
        units: chunk.units.map(u => ({ paragraphId: u.paragraphId, text: u.text, sliceIndex: u.sliceIndex, sliceTotal: u.sliceTotal })),
      };
      sendChunk({ chunk: req, retries: 0, timer: null });
    }
    notify({ kind: 'progress', done: task.done, total: task.total });
    if (pool.size === 0) stopTicker();
  } catch { /* 单次轮询异常不杀死定时器 */ }
}

function startTicker(): void {
  if (ticker !== null) return;
  ticker = setInterval(pump, POOL_TICK_MS);
}

function stopTicker(): void {
  if (ticker !== null) { clearInterval(ticker); ticker = null; }
}

// 后台标签页暂停轮询（TWP 同款），恢复可见时立即补一次泵
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopTicker();
  } else if (task && !task.cancelled && pool.size > 0) {
    startTicker();
    pump();
  }
});
```

- [ ] **Step 4: startTranslate 改为入池**

替换 `startTranslate` 中第 231-257 行（`const chunks = buildChunks(...)` 到 `console.log('[llm-tr] startTranslate: chunks posted to port')`）为：

```ts
    const id = `task-${Date.now()}`;
    task = {
      id, cancelled: false, total: 0, done: 0,
      pending: new Map(), sliceBuffers: new Map(),
      paragraphs: new Map(),
      errors: new Set(),
      observer: null,
      aliases: buildAliases(paragraphs),
    };
    notify({ kind: 'task-state', state: 'running' });
    pool.addAll(paragraphs);
    startObserver();
    startTicker();
    pump();
```

（其前的 `const paragraphs = await collectParagraphs();` 与空段落提前返回保持不变；`[diag]` 日志可保留。）

- [ ] **Step 5: completeChunk 完成判定加池条件**

替换 `completeChunk`（第 196-206 行）：

```ts
function completeChunk(): void {
  if (!task) return;
  task.done++;
  notify({ kind: 'progress', done: task.done, total: task.total });
  if (task.done >= task.total && pool.size === 0 && task.pending.size === 0) {
    notify({ kind: 'task-state', state: 'done' });
    stopObserverOnly();
    stopTicker();
    // 仍有失败段落时保留 task（静默态），供重试按钮继续工作
    if (task.errors.size === 0) task = null;
  }
}
```

- [ ] **Step 6: onChunkDelta 扇出**

替换 `onChunkDelta` 中第 271-272 行（host 查找与 setHostState）：

```ts
  const joined = buf.parts.join('');
  const p = task.paragraphs.get(msg.paragraphId);
  for (const pid of (p ? aliasIds(task, p) : [msg.paragraphId])) {
    const host = findHost(task, pid);
    if (host) setHostState(host, 'streaming', joined);
  }
```

- [ ] **Step 7: result 完成态扇出**

替换 `onChunkResponse` 中第 331-338 行（`if (buf.parts.filter...` 整块）：

```ts
      if (buf.parts.filter(Boolean).length === buf.total) {
        const p = task.paragraphs.get(t.paragraphId);
        if (p) {
          const text = buf.parts.join('');
          for (const pid of aliasIds(task, p)) {
            const q = task.paragraphs.get(pid);
            if (!q) continue;
            q.element.setAttribute(STATE_ATTR, 'done');
            const host = findHost(task, pid);
            if (host) setHostState(host, 'done', text);
          }
        }
      }
```

- [ ] **Step 8: markChunkError 扇出**

替换 `markChunkError`（第 183-194 行）：

```ts
function markChunkError(chunk: TranslateRequest): void {
  if (!task) return;
  for (const u of chunk.units) {
    const p = task.paragraphs.get(u.paragraphId);
    if (!p) continue;
    for (const pid of aliasIds(task, p)) {
      const q = task.paragraphs.get(pid);
      if (!q) continue;
      task.errors.add(pid);
      q.element.setAttribute(STATE_ATTR, 'error');
      const host = findHost(task, pid);
      if (host) setHostState(host, 'error');
    }
  }
}
```

- [ ] **Step 9: onNewContent 改为入池**

替换 `onNewContent`（第 436-461 行），并删除其前的 `let incSeq = 0;`（`extracting` 声明保留）：

```ts
async function onNewContent(): Promise<void> {
  if (!task || task.cancelled || extracting || !contextAlive()) return;
  extracting = true;
  try {
    const fresh = await collectParagraphs();
    if (!task || task.cancelled || fresh.length === 0) return;
    mergeAliases(task.aliases, fresh);
    pool.addAll(fresh);
    startTicker();
    pump();
  } finally {
    extracting = false;
  }
}
```

- [ ] **Step 10: cancelTask 清理池与定时器**

在 `cancelTask` 的 `stopObserverOnly();` 一行之后追加：

```ts
  pool.clear();
  stopTicker();
```

- [ ] **Step 11: 运行测试与构建**

Run: `npx vitest run`
Expected: 全部 PASS（198+3+5+2=208 个用例；既有用例不回归）。

Run: `npx wxt build`
Expected: 构建成功。

- [ ] **Step 12: 手动核对清单（浏览器实测）**

在 GitHub 仓库页与文件页加载 `.output/chrome-mv3`：
1. 提交栏、commit 列不翻译；About 翻译。
2. 长 README 页面：初始只翻译首屏附近段落，滚动后陆续出现译文。
3. 同文本重复段落（如有）同时出现同一份译文。

- [ ] **Step 13: Commit**

```bash
git add entrypoints/content.ts
git commit -m "feat: 视口惰性调度与同文本别名扇出接入整页翻译"
```

---

### Task 5: 全量验证与收尾

**Files:**
- 无新增；仅验证。

- [ ] **Step 1: 全量单测**

Run: `npx vitest run`
Expected: 全部 PASS。

- [ ] **Step 2: 构建**

Run: `npx wxt build`
Expected: 构建成功。

- [ ] **Step 3: e2e（若本机已装 Playwright 浏览器）**

Run: `npx playwright test`
Expected: 通过；若环境缺浏览器（`Executable doesn't exist`），记录跳过原因，不视为失败。

- [ ] **Step 4: 对照 spec 验收标准逐条确认**

对照 `docs/superpowers/specs/2026-09-24-twp-hardening-design.md` 的 4 条验收标准，逐条标注已验证/待实测。

---

### Task 6: e2e 覆盖别名扇出与惰性调度（spec §6 测试缺口补齐）

**Files:**
- Modify: `e2e/stub-server.ts`（新增请求统计）
- Modify: `e2e/translate.spec.ts`（新增 3 个用例）

**Interfaces:**
- Consumes: 既有 e2e 设施（`openDriver/openTestPage/sendToTestPage/stubControl/seedSettings`、`HOST` 选择器）。
- Produces: 桩服务 `GET /__control?stats=1` 返回 `{ bodies: string[] }`（历次 `/chat/completions`、`/v1/messages` 的原始请求体，reset 时清空，最多保留 100 条）。

- [ ] **Step 1: 桩服务加请求统计**

`StubState` 增加 `bodies: string[]`（初始 `[]`）；`/chat/completions`、`/v1/messages` 的 `req.on('end')` 里 `state.bodies.push(body)`，超过 100 条时 shift；`reset` 时清空；`/__control` 带 `stats` 参数时在响应 JSON 里并入 `bodies`。

- [ ] **Step 2: 别名扇出用例**

`e2e/translate.spec.ts` 新增：开始前向 `article` 追加两段**完全相同**的英文长段落；start 后断言 4 个宿主块全部显示译文；然后从 `/__control?stats=1` 读 bodies，断言该重复段落的原文文本在所有请求体中总共只出现 1 次。

- [ ] **Step 3: 惰性调度用例**

向 `article` 内两段之前插入 3000px 占位 div，再在 `article` 末尾追加一个长段落（位于视口+200px 之外）；start 后等待 1 秒，断言只有 2 个宿主块；`window.scrollTo(0, 3000)` 后断言第 3 个宿主块出现并最终显示译文。

- [ ] **Step 4: 代际拦截用例**

`stubControl(request, 'delay=2000')`；start 后立即 `sendToTestPage(driver, { kind: 'cancel' })`；等待 3 秒（延迟响应已到达）；断言宿主块仍停在等待态（不包含"译文"）。

- [ ] **Step 5: 运行 e2e**

Run: `npx playwright test`
Expected: 全部通过（含既有 16 个用例不回归）。

- [ ] **Step 6: Commit**

```bash
git add e2e/stub-server.ts e2e/translate.spec.ts
git commit -m "test: e2e 覆盖别名扇出/视口惰性调度/取消后陈旧响应拦截"
```
