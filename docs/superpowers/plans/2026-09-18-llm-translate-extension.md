# 大模型网页对照翻译插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 WXT + TypeScript 浏览器插件（Manifest V3），把网页正文英文段落用大模型 API 翻译成中文，以「原文段落下方插入对照译文」的方式呈现。

**Architecture:** 三层结构——popup（开关/进度/授权）、content script（正文识别、段落提取、Shadow DOM 渲染、持有任务状态）、background service worker（无状态，分块/限流/调 LLM/写 IndexedDB 缓存）。content script 与 background 之间用 `chrome.runtime.connect` Port 长连接通信，消息带任务 id + 分块 id。

**Tech Stack:** WXT（vanilla 模板，TypeScript strict）、Vitest + jsdom（单元）、fake-indexeddb（缓存测试）、Playwright（E2E）、idb-keyval（唯一运行时依赖）。

**Spec:** `docs/superpowers/specs/2026-09-18-llm-translate-extension-design.md`

## Global Constraints

- TypeScript `strict: true`，不使用任何 UI 框架（vanilla TS）
- Manifest V3；目标 Chrome 116+ / Firefox 127+（`optional_host_permissions` 要求 FF 127+）
- 运行时依赖只允许 `idb-keyval`；不引入 Readability.js 等提取库
- API Key 只存 `chrome.storage.local`，**禁止** `chrome.storage.sync`
- 组级流式：一组完成立即渲染，**不做**逐 token 流式
- 译文一律 Shadow DOM 承载，host 元素带 `data-llm-translate-host` 属性
- 段落处理标记用 DOM 属性 `data-llm-translate-state`（`pending`/`done`/`error`），不用内存 WeakSet
- TDD：`lib/` 下所有纯逻辑先写失败测试再实现；可见性判断必须依赖注入（jsdom 无 `innerText`）
- 提取器一律基于 `textContent`（jsdom 未实现 `innerText`）
- 每任务结束提交一次 commit，message 用 `feat:`/`test:`/`chore:` 前缀

## File Structure

```
package.json                      # npm scripts 与依赖清单（Task 1）
wxt.config.ts                     # manifest 声明：permissions/optional_host_permissions（Task 1）
tsconfig.json                     # strict（Task 1）
vitest.config.ts                  # jsdom 环境 + setup 文件（Task 1）
tests/setup.ts                    # fake-indexeddb/auto（Task 1）
lib/settings.ts                   # 设置读写 + 默认值（Task 2）
lib/extraction/scoring.ts         # 正文区域识别（Task 3）
lib/extraction/paragraphs.ts      # extractParagraphs + cjkRatio + 可见性（Task 4）
lib/translation/chunking.ts       # buildChunks + splitIntoSlices（Task 5）
lib/translation/prompt.ts         # buildMessages + parseJsonResponse + parsePlainResponse（Task 6）
lib/translation/llm-client.ts     # chatCompletion + translateUnits（重试/降级）（Task 7）
lib/cache/store.ts                # cacheKey + getCached + setCached + evictIfNeeded（Task 8）
lib/messaging/protocol.ts         # Port 消息类型（Task 9）
lib/translation/scheduler.ts      # 并发限流 + 缓存 + 拼合（Task 9）
entrypoints/background.ts         # Port 监听，接 scheduler（Task 9）
lib/renderer/host.ts              # Shadow DOM host 创建/更新/清理（Task 10）
entrypoints/content.ts            # content script 主逻辑 + MutationObserver（Task 11）
entrypoints/options/index.html    # 设置页（Task 12）
entrypoints/options/main.ts       # 设置页逻辑 + 授权按钮（Task 12）
entrypoints/popup/index.html      # popup（Task 13）
entrypoints/popup/main.ts         # 预估/进度/取消/授权（Task 13）
tests/*.test.ts                   # 每个 lib 模块对应的单测
e2e/translate.spec.ts             # Playwright E2E（Task 14）
playwright.config.ts              # E2E 配置（Task 14）
```

---

### Task 1: 项目脚手架（WXT + Vitest）

**Files:**
- Create: `package.json`、`wxt.config.ts`、`tsconfig.json`、`vitest.config.ts`、`tests/setup.ts`、`.gitignore`
- Create: `entrypoints/background.ts`、`entrypoints/content.ts`（最小可构建骨架）

**Interfaces:**
- Produces: `npm run build`（产出 `.output/chrome-mv3`）、`npm test`（vitest）、`npm run dev`（WXT 热更新）。后续所有任务依赖此构建链路。

- [ ] **Step 1: 写 `package.json` 并安装依赖**

```json
{
  "name": "llm-translate-extension",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "test": "vitest run",
    "e2e": "playwright test",
    "zip": "wxt zip"
  }
}
```

```bash
npm install idb-keyval
npm install -D wxt typescript vitest jsdom fake-indexeddb @playwright/test @types/chrome
```

- [ ] **Step 2: 写配置文件**

`wxt.config.ts`：

```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'LLM Translate',
    permissions: ['storage'],
    optional_host_permissions: ['*://*/*'],
  },
});
```

`tsconfig.json`：

```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": { "strict": true }
}
```

注意：`.wxt/tsconfig.json` 由 `wxt prepare` 生成；先跑一次 `npx wxt prepare` 再写本文件。

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
```

`tests/setup.ts`：

```ts
import 'fake-indexeddb/auto';
```

`.gitignore`：

```
node_modules
.output
.wxt
dist
playwright-report
test-results
```

- [ ] **Step 3: 写最小 entrypoints 骨架**

`entrypoints/background.ts`：

```ts
export default defineBackground(() => {
  // Task 9 填充
});
```

`entrypoints/content.ts`：

```ts
export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // Task 11 填充
  },
});
```

- [ ] **Step 4: 验证构建与测试链路**

Run: `npx wxt prepare && npm run build && npm test`
Expected: build 成功产出 `.output/chrome-mv3/manifest.json`；vitest 以 "no test files" 通过（exit 0，vitest 默认 passWithNoTests 为 false，需在 vitest.config.ts 的 test 中加 `passWithNoTests: true` 后重跑）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: WXT + Vitest 脚手架"
```

---

### Task 2: 设置存储 `lib/settings.ts`

**Files:**
- Create: `lib/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produces（后续 Task 7/9/12/13 消费）:
  - `interface Settings { baseUrl: string; apiKey: string; model: string; systemPrompt: string; targetLang: string; blacklist: string[]; disabledSites: string[]; minLength: number; cjkRatioThreshold: number }`
  - `const DEFAULT_SETTINGS: Settings`
  - `getSettings(): Promise<Settings>`（与默认值合并）
  - `saveSettings(patch: Partial<Settings>): Promise<void>`
  - `apiOriginPattern(baseUrl: string): string`（如 `https://api.deepseek.com` → `https://api.deepseek.com/*`，Task 12/13 授权用）

- [ ] **Step 1: 写失败测试**

`tests/settings.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS, getSettings, saveSettings, apiOriginPattern } from '../lib/settings';

const store = new Map<string, unknown>();
(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store.get(key) }),
      set: async (items: Record<string, unknown>) => { Object.assign(store, Object.fromEntries(Object.entries(items))); },
    },
  },
};

beforeEach(() => store.clear());

describe('settings', () => {
  it('无存储时返回默认值', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('saveSettings 部分更新并与默认值合并', async () => {
    await saveSettings({ model: 'deepseek-chat', apiKey: 'sk-x' });
    const s = await getSettings();
    expect(s.model).toBe('deepseek-chat');
    expect(s.apiKey).toBe('sk-x');
    expect(s.targetLang).toBe(DEFAULT_SETTINGS.targetLang);
  });

  it('apiOriginPattern 生成 origin 通配', () => {
    expect(apiOriginPattern('https://api.deepseek.com')).toBe('https://api.deepseek.com/*');
    expect(apiOriginPattern('https://api.deepseek.com/')).toBe('https://api.deepseek.com/*');
    expect(apiOriginPattern('http://localhost:11434/v1')).toBe('http://localhost:11434/*');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- settings`
Expected: FAIL，模块 `../lib/settings` 不存在

- [ ] **Step 3: 实现 `lib/settings.ts`**

```ts
export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  targetLang: string;
  blacklist: string[];
  disabledSites: string[];
  minLength: number;
  cjkRatioThreshold: number;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  systemPrompt: 'You are a professional translator. Translate faithfully and fluently, preserving meaning, tone, and formatting markers.',
  targetLang: '中文',
  blacklist: [],
  disabledSites: [],
  minLength: 20,
  cjkRatioThreshold: 0.3,
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(raw[KEY] ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({ [KEY]: { ...current, ...patch } });
}

export function apiOriginPattern(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.origin}/*`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- settings`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add lib/settings.ts tests/settings.test.ts
git commit -m "feat: 设置存储与默认值"
```

---

### Task 3: 正文区域识别 `lib/extraction/scoring.ts`

**Files:**
- Create: `lib/extraction/scoring.ts`
- Test: `tests/scoring.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，输入 Document/Element）
- Produces（Task 4/11 消费）:
  - `findContentRoot(doc: Document): Element` — 返回正文容器；无合格容器时返回 `doc.body`
  - `isExcludedContainer(el: Element): boolean` — 命中 nav/aside/footer/header、role=navigation|complementary|banner、aria-hidden、负向 class/id 关键词

- [ ] **Step 1: 写失败测试**

`tests/scoring.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { findContentRoot, isExcludedContainer } from '../lib/extraction/scoring';

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');
}

const LONG = 'This is a sufficiently long paragraph of English text used for testing purposes. '.repeat(3);

describe('findContentRoot', () => {
  it('选择 article 而非 nav/sidebar/footer', () => {
    const d = doc(`
      <nav><ul><li><a href="#">Home link here</a></li></ul></nav>
      <article><p>${LONG}</p><p>${LONG}</p></article>
      <aside class="sidebar"><p>${LONG}</p></aside>
      <footer><p>Copyright text that is long enough to pass the filter rules here.</p></footer>
    `);
    expect(findContentRoot(d).tagName).toBe('ARTICLE');
  });

  it('链接密度 > 50% 的容器被丢弃', () => {
    const d = doc(`
      <div class="links"><a href="#">${LONG}</a></div>
      <main><p>${LONG}</p><p>${LONG}</p></main>
    `);
    expect(findContentRoot(d).tagName).toBe('MAIN');
  });

  it('无合格容器时退化到 body', () => {
    const d = doc(`<nav><ul><li><a href="#">only nav links here</a></li></ul></nav>`);
    expect(findContentRoot(d)).toBe(d.body);
  });
});

describe('isExcludedContainer', () => {
  it('按标签排除', () => {
    const d = doc('<nav><p>x</p></nav>');
    expect(isExcludedContainer(d.querySelector('nav')!)).toBe(true);
  });
  it('按负向 class 排除', () => {
    const d = doc('<div class="cookie-banner"><p>x</p></div>');
    expect(isExcludedContainer(d.querySelector('div')!)).toBe(true);
  });
  it('按 aria-hidden 排除', () => {
    const d = doc('<div aria-hidden="true"><p>x</p></div>');
    expect(isExcludedContainer(d.querySelector('div')!)).toBe(true);
  });
  it('普通容器不排除', () => {
    const d = doc('<article><p>x</p></article>');
    expect(isExcludedContainer(d.querySelector('article')!)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- scoring`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `lib/extraction/scoring.ts`**

```ts
const EXCLUDE_TAGS = new Set(['NAV', 'ASIDE', 'FOOTER', 'HEADER']);
const EXCLUDE_ROLES = new Set(['navigation', 'complementary', 'banner']);
const NEGATIVE_RE = /nav|menu|sidebar|footer|comment|promo|banner|cookie|related|share/i;
const POSITIVE_SELECTOR = 'article, main, [role="main"], [itemprop="articleBody"]';
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, blockquote, td, th, dd, dt, figcaption';

export function isExcludedContainer(el: Element): boolean {
  if (EXCLUDE_TAGS.has(el.tagName)) return true;
  if (EXCLUDE_ROLES.has(el.getAttribute('role') ?? '')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const ident = `${el.id} ${el.getAttribute('class') ?? ''}`;
  return NEGATIVE_RE.test(ident);
}

function linkDensity(el: Element, textLen: number): number {
  if (textLen === 0) return 1;
  let linkLen = 0;
  for (const a of el.querySelectorAll('a')) linkLen += (a.textContent ?? '').length;
  return linkLen / textLen;
}

function score(el: Element): number {
  const textLen = (el.textContent ?? '').trim().length;
  if (textLen < 100) return 0;
  if (linkDensity(el, textLen) > 0.5) return 0;
  const blocks = el.querySelectorAll(BLOCK_SELECTOR).length;
  const nodeCount = Math.max(el.querySelectorAll('*').length, 1);
  const textDensity = textLen / nodeCount;
  return blocks * 100 + textDensity;
}

export function findContentRoot(doc: Document): Element {
  const candidates = new Set<Element>();
  for (const el of doc.querySelectorAll(POSITIVE_SELECTOR)) candidates.add(el);
  if (candidates.size === 0) {
    for (const el of doc.body.querySelectorAll('div, section')) candidates.add(el);
  }
  let best: Element | null = null;
  let bestScore = 0;
  for (const el of candidates) {
    if (isExcludedContainer(el) || el.closest('nav, aside, footer, header')) continue;
    const s = score(el);
    if (s > bestScore) { bestScore = s; best = el; }
  }
  return best ?? doc.body;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- scoring`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/scoring.ts tests/scoring.test.ts
git commit -m "feat: 正文区域启发式识别"
```

---

### Task 4: 段落提取 `lib/extraction/paragraphs.ts`

**Files:**
- Create: `lib/extraction/paragraphs.ts`
- Test: `tests/paragraphs.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 5/11 消费）:
  - `interface Paragraph { id: string; element: Element; text: string }`
  - `interface ExtractOptions { minLength: number; cjkRatioThreshold: number }`
  - `type IsVisibleFn = (el: Element) => boolean`
  - `extractParagraphs(root: Element, opts: ExtractOptions, isVisible: IsVisibleFn): Paragraph[]` — id 形如 `p0`、`p1`，按 DOM 顺序
  - `cjkRatio(text: string): number` — CJK 字符数 / 非空白字符数
  - `browserIsVisible(el: Element): boolean` — 生产实现（display/visibility + offsetParent，fixed 特判）；测试不传它

- [ ] **Step 1: 写失败测试**

`tests/paragraphs.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { extractParagraphs, cjkRatio } from '../lib/extraction/paragraphs';

const OPTS = { minLength: 20, cjkRatioThreshold: 0.3 };
const visible = () => true;
const LONG = 'This is a sufficiently long English paragraph used for unit testing purposes.';

function root(html: string): Element {
  const d = new DOMParser().parseFromString(`<html><body><main>${html}</main></body></html>`, 'text/html');
  return d.querySelector('main')!;
}

describe('extractParagraphs', () => {
  it('提取合格段落并保留 DOM 顺序', () => {
    const r = root(`<p>${LONG}</p><h2>A long enough english heading for test</h2><p>${LONG}</p>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps.map(p => p.id)).toEqual(['p0', 'p1', 'p2']);
    expect(ps[1].element.tagName).toBe('H2');
  });

  it('嵌套候选去重：blockquote>p 与 li>p 只提取一次（取内层）', () => {
    const r = root(`<blockquote><p>${LONG}</p></blockquote><ul><li><p>${LONG}</p></li></ul>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps).toHaveLength(2);
    expect(ps.every(p => p.element.tagName === 'P')).toBe(true);
  });

  it('过滤：短文本', () => {
    const r = root(`<p>Too short.</p><p>${LONG}</p>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('过滤：中文占比超阈值', () => {
    const r = root(`<p>这是一段中文为主 mixed english words 的段落内容足够长</p><p>${LONG}</p>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('过滤：pre/code 内的段落', () => {
    const r = root(`<pre><p>${LONG}</p></pre><p>${LONG}</p>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('过滤：无拉丁字母（纯数字/符号）', () => {
    const r = root(`<p>123 456 7890 —— +++ === 纯数字符号段落占位</p><p>${LONG}</p>`);
    expect(extractParagraphs(r, OPTS, visible)).toHaveLength(1);
  });

  it('过滤：不可见元素（isVisible 注入）', () => {
    const r = root(`<p style="display:none">${LONG}</p><p>${LONG}</p>`);
    const ps = extractParagraphs(r, OPTS, (el) => (el as HTMLElement).style.display !== 'none');
    expect(ps).toHaveLength(1);
  });

  it('textContent 空白折叠', () => {
    const r = root(`<p>This  is   a\n\n long   enough   english   paragraph   with   weird   spacing.</p>`);
    const ps = extractParagraphs(r, OPTS, visible);
    expect(ps[0].text).toBe('This is a long enough english paragraph with weird spacing.');
  });
});

describe('cjkRatio', () => {
  it('纯英文为 0，纯中文为 1', () => {
    expect(cjkRatio('hello world')).toBe(0);
    expect(cjkRatio('你好世界')).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- paragraphs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `lib/extraction/paragraphs.ts`**

```ts
export interface Paragraph { id: string; element: Element; text: string }
export interface ExtractOptions { minLength: number; cjkRatioThreshold: number }
export type IsVisibleFn = (el: Element) => boolean;

export const CANDIDATE_SELECTOR = 'p, li, h1, h2, h3, h4, blockquote, td, th, dd, dt, figcaption';
const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/g;

export function cjkRatio(text: string): number {
  const nonSpace = text.replace(/\s/g, '');
  if (nonSpace.length === 0) return 0;
  const cjk = (nonSpace.match(CJK_RE) ?? []).length;
  return cjk / nonSpace.length;
}

function isNestedDuplicate(el: Element): boolean {
  const total = (el.textContent ?? '').length;
  if (total === 0) return false;
  let inner = 0;
  for (const child of el.querySelectorAll(CANDIDATE_SELECTOR)) {
    inner += (child.textContent ?? '').length;
  }
  return inner > 0 && inner / total >= 0.7;
}

export function extractParagraphs(root: Element, opts: ExtractOptions, isVisible: IsVisibleFn): Paragraph[] {
  const result: Paragraph[] = [];
  let seq = 0;
  for (const el of root.querySelectorAll(CANDIDATE_SELECTOR)) {
    if (isNestedDuplicate(el)) continue;
    if (el.closest('pre, code')) continue;
    if (!isVisible(el)) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < opts.minLength) continue;
    if (cjkRatio(text) > opts.cjkRatioThreshold) continue;
    if (!/[a-zA-Z]/.test(text)) continue;
    result.push({ id: `p${seq++}`, element: el, text });
  }
  return result;
}

export function browserIsVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (style.position === 'fixed') return true;
  return (el as HTMLElement).offsetParent !== null;
}
```

注意：`isNestedDuplicate` 用 `querySelectorAll` 只取**后代**，不含自身，符合「只取最内层」语义。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- paragraphs`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/paragraphs.ts tests/paragraphs.test.ts
git commit -m "feat: 段落提取（嵌套去重/过滤/可见性注入）"
```

---

### Task 5: 分块 `lib/translation/chunking.ts`

**Files:**
- Create: `lib/translation/chunking.ts`
- Test: `tests/chunking.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 9/11 消费）:
  - `interface ChunkUnit { paragraphId: string; text: string; sliceIndex: number; sliceTotal: number }`
  - `interface Chunk { units: ChunkUnit[]; charCount: number }`
  - `buildChunks(paragraphs: { id: string; text: string }[], maxChars?: number): Chunk[]` — maxChars 默认 1500，DOM 顺序连续，单批 ≤ maxChars（单片可超过）
  - `splitIntoSlices(text: string, maxChars: number): string[]` — 按句子边界（`. ! ? ;` 后跟空白）切分；无边界时硬切

- [ ] **Step 1: 写失败测试**

`tests/chunking.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildChunks, splitIntoSlices } from '../lib/translation/chunking';

describe('buildChunks', () => {
  it('短段落合并进一块，不超 maxChars', () => {
    const ps = [
      { id: 'p0', text: 'a'.repeat(80) },
      { id: 'p1', text: 'b'.repeat(80) },
      { id: 'p2', text: 'c'.repeat(80) },
    ];
    const chunks = buildChunks(ps, 200);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].units.map(u => u.paragraphId)).toEqual(['p0', 'p1']);
    expect(chunks[1].units.map(u => u.paragraphId)).toEqual(['p2']);
    for (const c of chunks) expect(c.charCount).toBeLessThanOrEqual(200);
  });

  it('保持 DOM 顺序连续，不打乱', () => {
    const ps = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, text: 'x'.repeat(100) }));
    const chunks = buildChunks(ps, 250);
    const order = chunks.flatMap(c => c.units.map(u => u.paragraphId));
    expect(order).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('超长段落按句子边界分片，共享 paragraphId 与 sliceTotal', () => {
    const sentence = 'This is one complete sentence. ';
    const long = sentence.repeat(10); // 310 字符
    const chunks = buildChunks([{ id: 'p0', text: long }], 100);
    const units = chunks.flatMap(c => c.units);
    expect(units.length).toBeGreaterThan(1);
    expect(units.every(u => u.paragraphId === 'p0')).toBe(true);
    expect(units.every(u => u.sliceTotal === units.length)).toBe(true);
    expect(units.map(u => u.sliceIndex)).toEqual(units.map((_, i) => i));
    expect(units.map(u => u.text).join('')).toBe(long);
    for (const u of units) expect(u.text.endsWith('. ') || u === units[units.length - 1]).toBe(true);
  });
});

describe('splitIntoSlices', () => {
  it('短于上限直接返回整段', () => {
    expect(splitIntoSlices('short text', 100)).toEqual(['short text']);
  });
  it('无句子边界时硬切', () => {
    const slices = splitIntoSlices('x'.repeat(250), 100);
    expect(slices.map(s => s.length)).toEqual([100, 100, 50]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- chunking`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `lib/translation/chunking.ts`**

```ts
export interface ChunkUnit { paragraphId: string; text: string; sliceIndex: number; sliceTotal: number }
export interface Chunk { units: ChunkUnit[]; charCount: number }

const SENTENCE_END_RE = /[.!?;]\s/g;

export function splitIntoSlices(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const boundaries: number[] = [];
  for (const m of text.matchAll(SENTENCE_END_RE)) boundaries.push(m.index! + m[0].length);
  if (boundaries.length === 0) {
    const slices: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) slices.push(text.slice(i, i + maxChars));
    return slices;
  }
  const slices: string[] = [];
  let start = 0;
  let lastBoundary = 0;
  for (const b of boundaries) {
    if (b - start > maxChars && lastBoundary > start) {
      slices.push(text.slice(start, lastBoundary));
      start = lastBoundary;
    }
    lastBoundary = b;
  }
  if (start < text.length) slices.push(text.slice(start));
  // 单片仍超限时硬切
  return slices.flatMap(s => (s.length <= maxChars ? [s] : splitIntoSlices(s, maxChars)));
}

export function buildChunks(paragraphs: { id: string; text: string }[], maxChars = 1500): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk = { units: [], charCount: 0 };
  for (const p of paragraphs) {
    const slices = splitIntoSlices(p.text, maxChars);
    for (let s = 0; s < slices.length; s++) {
      const unit: ChunkUnit = { paragraphId: p.id, text: slices[s], sliceIndex: s, sliceTotal: slices.length };
      if (current.units.length > 0 && current.charCount + unit.text.length > maxChars) {
        chunks.push(current);
        current = { units: [], charCount: 0 };
      }
      current.units.push(unit);
      current.charCount += unit.text.length;
    }
  }
  if (current.units.length > 0) chunks.push(current);
  return chunks;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- chunking`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add lib/translation/chunking.ts tests/chunking.test.ts
git commit -m "feat: 按字符数分块与句子边界分片"
```

---

### Task 6: 提示词与响应解析 `lib/translation/prompt.ts`

**Files:**
- Create: `lib/translation/prompt.ts`
- Test: `tests/prompt.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 7/8 消费）:
  - `const PROMPT_VERSION: string`（值为 `'v1'`，Task 8 缓存 key 用）
  - `interface ChatMessage { role: 'system' | 'user'; content: string }`
  - `type PromptMode = 'json' | 'plain'`
  - `buildMessages(texts: string[], targetLang: string, systemPrompt: string, mode: PromptMode): ChatMessage[]`
  - `parseJsonResponse(content: string, expected: number): (string | null)[] | null` — 解析失败返回 `null`；缺项位置为 `null`；容忍 ```json 围栏；`i` 乱序仍按 i 对齐
  - `parsePlainResponse(content: string, expected: number): (string | null)[] | null` — 按 `[i]` 标记对齐；无任何标记返回 `null`

- [ ] **Step 1: 写失败测试**

`tests/prompt.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildMessages, parseJsonResponse, parsePlainResponse } from '../lib/translation/prompt';

describe('buildMessages', () => {
  it('json 模式要求 JSON 结构，plain 模式要求 [i] 编号', () => {
    const json = buildMessages(['Hello world here'], '中文', 'SYS', 'json');
    expect(json[0].role).toBe('system');
    expect(json[0].content).toContain('SYS');
    expect(json[0].content).toContain('中文');
    expect(json[0].content).toContain('"items"');
    expect(json[1].content).toBe('[0] Hello world here');
    const plain = buildMessages(['Hello world here'], '中文', 'SYS', 'plain');
    expect(plain[0].content).toContain('[0]');
    expect(plain[0].content).not.toContain('"items"');
  });
});

describe('parseJsonResponse', () => {
  it('正常解析并按 i 对齐（容忍乱序）', () => {
    const r = parseJsonResponse('{"items":[{"i":1,"t":"乙"},{"i":0,"t":"甲"}]}', 2);
    expect(r).toEqual(['甲', '乙']);
  });
  it('容忍 ```json 围栏', () => {
    const r = parseJsonResponse('```json\n{"items":[{"i":0,"t":"甲"}]}\n```', 1);
    expect(r).toEqual(['甲']);
  });
  it('缺项位置为 null', () => {
    const r = parseJsonResponse('{"items":[{"i":0,"t":"甲"}]}', 2);
    expect(r).toEqual(['甲', null]);
  });
  it('非 JSON 返回 null', () => {
    expect(parseJsonResponse('not json at all', 1)).toBeNull();
  });
  it('i 越界被忽略', () => {
    const r = parseJsonResponse('{"items":[{"i":5,"t":"越界"},{"i":0,"t":"甲"}]}', 1);
    expect(r).toEqual(['甲']);
  });
});

describe('parsePlainResponse', () => {
  it('按 [i] 标记对齐，容忍多行译文', () => {
    const r = parsePlainResponse('[0] 第一行\n继续第一行\n[1] 第二段', 2);
    expect(r).toEqual(['第一行\n继续第一行', '第二段']);
  });
  it('缺项为 null', () => {
    expect(parsePlainResponse('[0] 只有零', 2)).toEqual(['只有零', null]);
  });
  it('完全无标记返回 null', () => {
    expect(parsePlainResponse('没有任何编号的回复', 1)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- prompt`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `lib/translation/prompt.ts`**

```ts
export const PROMPT_VERSION = 'v1';

export interface ChatMessage { role: 'system' | 'user'; content: string }
export type PromptMode = 'json' | 'plain';

export function buildMessages(texts: string[], targetLang: string, systemPrompt: string, mode: PromptMode): ChatMessage[] {
  const numbered = texts.map((t, i) => `[${i}] ${t}`).join('\n\n');
  const format = mode === 'json'
    ? 'Respond with JSON only, no other text: {"items":[{"i":0,"t":"translation of item 0"}]}. Include every input index.'
    : 'Respond with each translation prefixed by the same [i] marker as its input, one item per block. No other text.';
  return [
    { role: 'system', content: `${systemPrompt}\nTranslate the following texts to ${targetLang}. ${format}` },
    { role: 'user', content: numbered },
  ];
}

export function parseJsonResponse(content: string, expected: number): (string | null)[] | null {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const result: (string | null)[] = new Array(expected).fill(null);
  for (const item of items) {
    const it = item as { i?: unknown; t?: unknown };
    if (typeof it.i === 'number' && Number.isInteger(it.i) && it.i >= 0 && it.i < expected && typeof it.t === 'string') {
      result[it.i] = it.t;
    }
  }
  return result;
}

const MARKER_RE = /\[(\d+)\]\s*/g;

export function parsePlainResponse(content: string, expected: number): (string | null)[] | null {
  const marks = [...content.matchAll(MARKER_RE)];
  if (marks.length === 0) return null;
  const result: (string | null)[] = new Array(expected).fill(null);
  for (let k = 0; k < marks.length; k++) {
    const i = Number(marks[k][1]);
    const start = marks[k].index! + marks[k][0].length;
    const end = k + 1 < marks.length ? marks[k + 1].index! : content.length;
    if (Number.isInteger(i) && i >= 0 && i < expected) {
      result[i] = content.slice(start, end).trim();
    }
  }
  return result;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- prompt`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add lib/translation/prompt.ts tests/prompt.test.ts
git commit -m "feat: 提示词构造与 JSON/纯文本响应解析"
```

---

### Task 7: LLM 客户端 `lib/translation/llm-client.ts`

**Files:**
- Create: `lib/translation/llm-client.ts`
- Test: `tests/llm-client.test.ts`

**Interfaces:**
- Consumes: `buildMessages`、`parseJsonResponse`、`parsePlainResponse`、`ChatMessage`（Task 6）
- Produces（Task 9 消费）:
  - `interface LlmConfig { baseUrl: string; apiKey: string; model: string }`
  - `class AuthError extends Error`（401/403）
  - `class FormatUnsupportedError extends Error`（400 且错误信息涉及 response_format）
  - `translateUnits(cfg: LlmConfig, texts: string[], opts: { targetLang: string; systemPrompt: string; useJsonFormat: boolean }, deps?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<{ translations: (string | null)[]; useJsonFormat: boolean }>`
  - 行为契约：429/5xx 退避重试（1s/2s/4s，最多 3 次）→ 仍失败抛 `Error`；401/403 抛 `AuthError`；400 涉 response_format → 自动切 plain 模式重发（返回 `useJsonFormat: false`，供 Task 9 记忆）；解析失败/缺项 → 逐段单独请求补齐，单段也失败则该位置为 `null`

- [ ] **Step 1: 写失败测试**

`tests/llm-client.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { translateUnits, AuthError } from '../lib/translation/llm-client';

const CFG = { baseUrl: 'https://api.test.com', apiKey: 'sk-x', model: 'm1' };
const OPTS = { targetLang: '中文', systemPrompt: 'SYS', useJsonFormat: true };
const noSleep = () => Promise.resolve();

function jsonResponse(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

describe('translateUnits', () => {
  it('正常 JSON 响应按 i 对齐返回', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"items":[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]}')) as any;
    const r = await translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep });
    expect(r.translations).toEqual(['甲', '乙']);
    expect(r.useJsonFormat).toBe(true);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('400 涉及 response_format 时降级 plain 并重发', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"response_format not supported"}', { status: 400 }))
      .mockResolvedValueOnce(jsonResponse('[0] 甲\n[1] 乙')) as any;
    const r = await translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep });
    expect(r.useJsonFormat).toBe(false);
    expect(r.translations).toEqual(['甲', '乙']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
    expect(body2.response_format).toBeUndefined();
  });

  it('JSON 解析失败时逐段降级补齐', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse('garbage not json'))
      .mockResolvedValueOnce(jsonResponse('{"items":[{"i":0,"t":"甲"}]}'))
      .mockResolvedValueOnce(jsonResponse('{"items":[{"i":0,"t":"乙"}]}')) as any;
    const r = await translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep });
    expect(r.translations).toEqual(['甲', '乙']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('429 退避重试后成功', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse('{"items":[{"i":0,"t":"甲"}]}')) as any;
    const r = await translateUnits(CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep });
    expect(r.translations).toEqual(['甲']);
  });

  it('401 抛 AuthError 且不重试', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 })) as any;
    await expect(translateUnits(CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(AuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('持续 500 重试 3 次后抛错', async () => {
    const fetchImpl = vi.fn(async () => new Response('server error', { status: 500 })) as any;
    await expect(translateUnits(CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep })).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 首次 + 3 次重试
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- llm-client`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `lib/translation/llm-client.ts`**

```ts
import { buildMessages, parseJsonResponse, parsePlainResponse, ChatMessage } from './prompt';

export interface LlmConfig { baseUrl: string; apiKey: string; model: string }

export class AuthError extends Error {}
export class FormatUnsupportedError extends Error {}

interface Deps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }

const RETRY_DELAYS = [1000, 2000, 4000];
const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function chatCompletion(cfg: LlmConfig, messages: ChatMessage[], useJsonFormat: boolean, deps: Deps): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0.3 };
  if (useJsonFormat) body.response_format = { type: 'json_object' };
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content as string;
    }
    if (res.status === 401 || res.status === 403) throw new AuthError(`LLM auth failed: ${res.status}`);
    if (res.status === 400 && useJsonFormat) {
      const text = await res.text();
      if (/response_format/i.test(text)) throw new FormatUnsupportedError(text);
      throw new Error(`LLM bad request: ${text}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt]);
      continue;
    }
    throw new Error(`LLM request failed: ${res.status}`);
  }
}

async function translateSingle(cfg: LlmConfig, text: string, opts: { targetLang: string; systemPrompt: string }, useJsonFormat: boolean, deps: Deps): Promise<string | null> {
  try {
    const content = await chatCompletion(cfg, buildMessages([text], opts.targetLang, opts.systemPrompt, useJsonFormat ? 'json' : 'plain'), useJsonFormat, deps);
    const parsed = useJsonFormat ? parseJsonResponse(content, 1) : parsePlainResponse(content, 1);
    return parsed?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function translateUnits(
  cfg: LlmConfig,
  texts: string[],
  opts: { targetLang: string; systemPrompt: string; useJsonFormat: boolean },
  deps: Deps = {},
): Promise<{ translations: (string | null)[]; useJsonFormat: boolean }> {
  let mode = opts.useJsonFormat;
  let content: string;
  try {
    content = await chatCompletion(cfg, buildMessages(texts, opts.targetLang, opts.systemPrompt, mode ? 'json' : 'plain'), mode, deps);
  } catch (e) {
    if (e instanceof FormatUnsupportedError) {
      mode = false;
      content = await chatCompletion(cfg, buildMessages(texts, opts.targetLang, opts.systemPrompt, 'plain'), false, deps);
    } else {
      throw e;
    }
  }
  const parsed = mode ? parseJsonResponse(content, texts.length) : parsePlainResponse(content, texts.length);
  const translations: (string | null)[] = parsed ?? new Array(texts.length).fill(null);
  // 缺项/解析失败 → 逐段补齐
  for (let i = 0; i < translations.length; i++) {
    if (translations[i] === null) {
      translations[i] = await translateSingle(cfg, texts[i], opts, mode, deps);
    }
  }
  return { translations, useJsonFormat: mode };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- llm-client`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add lib/translation/llm-client.ts tests/llm-client.test.ts
git commit -m "feat: LLM 客户端（退避重试/response_format 降级/逐段补齐）"
```

---

### Task 8: 缓存 `lib/cache/store.ts`

**Files:**
- Create: `lib/cache/store.ts`
- Test: `tests/cache.test.ts`

**Interfaces:**
- Consumes: `idb-keyval`；`tests/setup.ts` 的 fake-indexeddb（Task 1）
- Produces（Task 9 消费）:
  - `cacheKey(text: string, promptVersion: string, model: string, targetLang: string): string` — 同步 FNV-1a hash；text 先 trim + 空白折叠
  - `getCached(key: string): Promise<string | undefined>` — 命中时更新 accessedAt
  - `setCached(key: string, translation: string, meta: { model: string; promptVersion: string }): Promise<void>` — 写入后自动 `evictIfNeeded`
  - `evictIfNeeded(maxEntries?: number, maxBytes?: number): Promise<void>` — 默认 5000 条 / 50MB，按 accessedAt 升序淘汰

- [ ] **Step 1: 写失败测试**

`tests/cache.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { cacheKey, getCached, setCached, evictIfNeeded } from '../lib/cache/store';

describe('cacheKey', () => {
  it('空白折叠后命中同一 key', () => {
    expect(cacheKey('hello   world', 'v1', 'm', '中文')).toBe(cacheKey(' hello world ', 'v1', 'm', '中文'));
  });
  it('promptVersion / model / targetLang 任一变化则 key 不同', () => {
    const base = cacheKey('text', 'v1', 'm1', '中文');
    expect(cacheKey('text', 'v2', 'm1', '中文')).not.toBe(base);
    expect(cacheKey('text', 'v1', 'm2', '中文')).not.toBe(base);
    expect(cacheKey('text', 'v1', 'm1', '英文')).not.toBe(base);
  });
});

describe('getCached/setCached', () => {
  it('写入后可读出', async () => {
    const k = cacheKey('some text', 'v1', 'm', '中文');
    await setCached(k, '一些文字', { model: 'm', promptVersion: 'v1' });
    expect(await getCached(k)).toBe('一些文字');
  });
  it('未命中返回 undefined', async () => {
    expect(await getCached('nonexistent-key')).toBeUndefined();
  });
});

describe('evictIfNeeded', () => {
  it('超过条数上限时淘汰最久未访问的', async () => {
    for (let i = 0; i < 5; i++) {
      await setCached(`k${i}`, `v${i}`, { model: 'm', promptVersion: 'v1' });
      await new Promise(r => setTimeout(r, 2)); // 保证 accessedAt 可区分
    }
    await getCached('k0'); // k0 变最新
    await evictIfNeeded(3, 50 * 1024 * 1024);
    expect(await getCached('k0')).toBe('v0');
    expect(await getCached('k1')).toBeUndefined();
    expect(await getCached('k2')).toBeUndefined();
    expect(await getCached('k4')).toBe('v4');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- cache`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `lib/cache/store.ts`**

```ts
import { get, set, del, keys } from 'idb-keyval';

const PREFIX = 'tr:';
const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

interface Entry {
  text: string;
  model: string;
  promptVersion: string;
  createdAt: number;
  accessedAt: number;
  bytes: number;
}

export function cacheKey(text: string, promptVersion: string, model: string, targetLang: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const input = `${normalized}|${promptVersion}|${model}|${targetLang}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + '-' + input.length.toString(16);
}

export async function getCached(key: string): Promise<string | undefined> {
  const entry = await get<Entry>(PREFIX + key);
  if (!entry) return undefined;
  entry.accessedAt = Date.now();
  await set(PREFIX + key, entry);
  return entry.text;
}

export async function setCached(key: string, translation: string, meta: { model: string; promptVersion: string }): Promise<void> {
  const now = Date.now();
  const entry: Entry = {
    text: translation,
    model: meta.model,
    promptVersion: meta.promptVersion,
    createdAt: now,
    accessedAt: now,
    bytes: translation.length * 2,
  };
  await set(PREFIX + key, entry);
  await evictIfNeeded();
}

export async function evictIfNeeded(maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES): Promise<void> {
  const allKeys = (await keys()).filter(k => typeof k === 'string' && k.startsWith(PREFIX)) as string[];
  if (allKeys.length <= maxEntries) return;
  const entries = await Promise.all(allKeys.map(async k => ({ k, e: (await get<Entry>(k))! })));
  entries.sort((a, b) => a.e.accessedAt - b.e.accessedAt);
  let totalBytes = entries.reduce((n, x) => n + x.e.bytes, 0);
  let remaining = entries.length;
  for (const { k, e } of entries) {
    if (remaining <= maxEntries && totalBytes <= maxBytes) break;
    await del(k);
    totalBytes -= e.bytes;
    remaining--;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- cache`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add lib/cache/store.ts tests/cache.test.ts
git commit -m "feat: IndexedDB 译文缓存（FNV key + LRU 淘汰）"
```

---

### Task 9: 消息协议 + Background 调度器

**Files:**
- Create: `lib/messaging/protocol.ts`、`lib/translation/scheduler.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `translateUnits`、`LlmConfig`、`AuthError`（Task 7）；`cacheKey`、`getCached`、`setCached`（Task 8）；`PROMPT_VERSION`（Task 6）；`getSettings`（Task 2）
- Produces（Task 11/13 消费）:
  - `interface UnitPayload { paragraphId: string; text: string; sliceIndex: number; sliceTotal: number }`
  - `interface TranslateRequest { kind: 'translate'; taskId: string; chunkId: string; units: UnitPayload[] }`
  - `type TranslateResponse = { kind: 'result'; taskId: string; chunkId: string; translations: { paragraphId: string; sliceIndex: number; sliceTotal: number; text: string }[] } | { kind: 'error'; taskId: string; chunkId: string; code: 'auth' | 'failed'; message: string }`
  - `handleTranslateRequest(req: TranslateRequest, deps: SchedulerDeps): Promise<TranslateResponse>` — 纯异步函数，不依赖 chrome API（chrome API 只在 `entrypoints/background.ts` 薄壳里）
  - `interface SchedulerDeps { translate: typeof translateUnits; getCached: typeof getCached; setCached: typeof setCached; getSettings: typeof getSettings; jsonFormatSupported: { value: boolean } }` — `jsonFormatSupported` 为可写引用，400 降级后本 SW 生命周期内记忆

- [ ] **Step 1: 写 `lib/messaging/protocol.ts`（无逻辑，直接写）**

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
}

export interface TranslateResultItem {
  paragraphId: string;
  sliceIndex: number;
  sliceTotal: number;
  text: string;
}

export type TranslateResponse =
  | { kind: 'result'; taskId: string; chunkId: string; translations: TranslateResultItem[] }
  | { kind: 'error'; taskId: string; chunkId: string; code: 'auth' | 'failed'; message: string };
```

- [ ] **Step 2: 写失败测试**

`tests/scheduler.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleTranslateRequest, SchedulerDeps } from '../lib/translation/scheduler';
import { TranslateRequest } from '../lib/messaging/protocol';

function makeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    translate: vi.fn(async (_cfg: any, texts: string[]) => ({
      translations: texts.map(t => `译:${t}`),
      useJsonFormat: true,
    })),
    getCached: vi.fn(async () => undefined),
    setCached: vi.fn(async () => {}),
    getSettings: vi.fn(async () => ({
      baseUrl: 'https://api.test.com', apiKey: 'sk-x', model: 'm1',
      systemPrompt: 'SYS', targetLang: '中文',
    })),
    jsonFormatSupported: { value: true },
    ...overrides,
  } as unknown as SchedulerDeps;
}

const REQ: TranslateRequest = {
  kind: 'translate', taskId: 't1', chunkId: 'c1',
  units: [
    { paragraphId: 'p0', text: 'Hello world.', sliceIndex: 0, sliceTotal: 1 },
    { paragraphId: 'p1', text: 'Goodbye world.', sliceIndex: 0, sliceTotal: 1 },
  ],
};

describe('handleTranslateRequest', () => {
  it('正常路径：调 LLM、写缓存、返回结果', async () => {
    const deps = makeDeps();
    const r = await handleTranslateRequest(REQ, deps);
    expect(r.kind).toBe('result');
    if (r.kind === 'result') {
      expect(r.translations.map(t => t.text)).toEqual(['译:Hello world.', '译:Goodbye world.']);
    }
    expect(deps.setCached).toHaveBeenCalledTimes(2);
  });

  it('缓存命中的段落不调 LLM', async () => {
    const deps = makeDeps({
      getCached: vi.fn(async (key: string) => (key.includes('Hello') || true ? undefined : undefined)),
    });
    // 第一个段落命中缓存
    (deps.getCached as any).mockResolvedValueOnce('缓存译文').mockResolvedValueOnce(undefined);
    const r = await handleTranslateRequest(REQ, deps);
    expect(deps.translate).toHaveBeenCalledTimes(1);
    expect((deps.translate as any).mock.calls[0][1]).toEqual(['Goodbye world.']);
    expect(r.kind).toBe('result');
    if (r.kind === 'result') expect(r.translations[0].text).toBe('缓存译文');
  });

  it('AuthError 返回 code=auth 的错误响应', async () => {
    const { AuthError } = await import('../lib/translation/llm-client');
    const deps = makeDeps({ translate: vi.fn(async () => { throw new AuthError('401'); }) });
    const r = await handleTranslateRequest(REQ, deps);
    expect(r).toMatchObject({ kind: 'error', code: 'auth', taskId: 't1', chunkId: 'c1' });
  });

  it('其他异常返回 code=failed', async () => {
    const deps = makeDeps({ translate: vi.fn(async () => { throw new Error('LLM request failed: 500'); }) });
    const r = await handleTranslateRequest(REQ, deps);
    expect(r).toMatchObject({ kind: 'error', code: 'failed' });
  });

  it('400 降级后 jsonFormatSupported 被记忆', async () => {
    const deps = makeDeps({
      translate: vi.fn(async () => ({ translations: ['译:A', '译:B'], useJsonFormat: false })),
    });
    await handleTranslateRequest(REQ, deps);
    expect(deps.jsonFormatSupported.value).toBe(false);
  });

  it('null 译文（逐段补齐也失败）映射为 error', async () => {
    const deps = makeDeps({
      translate: vi.fn(async () => ({ translations: ['译:A', null], useJsonFormat: true })),
    });
    const r = await handleTranslateRequest(REQ, deps);
    expect(r).toMatchObject({ kind: 'error', code: 'failed' });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -- scheduler`
Expected: FAIL，模块不存在

- [ ] **Step 4: 实现 `lib/translation/scheduler.ts`**

```ts
import { TranslateRequest, TranslateResponse } from '../messaging/protocol';
import { translateUnits, LlmConfig, AuthError } from './llm-client';
import { PROMPT_VERSION } from './prompt';

export interface SchedulerDeps {
  translate: typeof translateUnits;
  getCached: (key: string) => Promise<string | undefined>;
  setCached: (key: string, translation: string, meta: { model: string; promptVersion: string }) => Promise<void>;
  getSettings: () => Promise<{ baseUrl: string; apiKey: string; model: string; systemPrompt: string; targetLang: string }>;
  jsonFormatSupported: { value: boolean };
}

export async function handleTranslateRequest(req: TranslateRequest, deps: SchedulerDeps): Promise<TranslateResponse> {
  const settings = await deps.getSettings();
  const cfg: LlmConfig = { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model };
  const texts = req.units.map(u => u.text);
  const keys = texts.map(t => cacheKeyOf(t, settings.model, settings.targetLang));

  const translations: (string | null)[] = new Array(texts.length).fill(null);
  const pendingIdx: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = await deps.getCached(keys[i]);
    if (hit !== undefined) translations[i] = hit;
    else pendingIdx.push(i);
  }

  try {
    if (pendingIdx.length > 0) {
      const r = await deps.translate(cfg, pendingIdx.map(i => texts[i]), {
        targetLang: settings.targetLang,
        systemPrompt: settings.systemPrompt,
        useJsonFormat: deps.jsonFormatSupported.value,
      });
      if (!r.useJsonFormat) deps.jsonFormatSupported.value = false;
      for (let k = 0; k < pendingIdx.length; k++) {
        translations[pendingIdx[k]] = r.translations[k];
      }
    }
  } catch (e) {
    if (e instanceof AuthError) {
      return { kind: 'error', taskId: req.taskId, chunkId: req.chunkId, code: 'auth', message: 'API Key 无效或权限不足，请检查设置页' };
    }
    return { kind: 'error', taskId: req.taskId, chunkId: req.chunkId, code: 'failed', message: e instanceof Error ? e.message : String(e) };
  }

  if (translations.some(t => t === null)) {
    return { kind: 'error', taskId: req.taskId, chunkId: req.chunkId, code: 'failed', message: '部分段落翻译失败（重试与逐段降级均未成功）' };
  }

  for (const i of pendingIdx) {
    await deps.setCached(keys[i], translations[i]!, { model: settings.model, promptVersion: PROMPT_VERSION });
  }

  return {
    kind: 'result',
    taskId: req.taskId,
    chunkId: req.chunkId,
    translations: req.units.map((u, i) => ({
      paragraphId: u.paragraphId,
      sliceIndex: u.sliceIndex,
      sliceTotal: u.sliceTotal,
      text: translations[i]!,
    })),
  };
}

import { cacheKey } from '../cache/store';
function cacheKeyOf(text: string, model: string, targetLang: string): string {
  return cacheKey(text, PROMPT_VERSION, model, targetLang);
}
```

注意：把 `import { cacheKey }` 移到文件顶部（上面为可读性放在底部，实现时放顶部）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -- scheduler`
Expected: 6 passed

- [ ] **Step 6: 接线 `entrypoints/background.ts`（含并发限流 3）**

```ts
import { handleTranslateRequest } from '../lib/translation/scheduler';
import { translateUnits } from '../lib/translation/llm-client';
import { getCached, setCached } from '../lib/cache/store';
import { getSettings } from '../lib/settings';
import { TranslateRequest, TranslateResponse } from '../lib/messaging/protocol';

// 并发计数在内存中，属 best-effort：SW 重启后重置，超限由 API 侧 429 + 退避兜底
let inFlight = 0;
const waiters: (() => void)[] = [];
const jsonFormatSupported = { value: true };

async function acquire(): Promise<void> {
  if (inFlight < 3) { inFlight++; return; }
  await new Promise<void>(r => waiters.push(r));
  inFlight++;
}
function release(): void {
  inFlight--;
  waiters.shift()?.();
}

export default defineBackground(() => {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'translate') return;
    port.onMessage.addListener(async (msg: TranslateRequest) => {
      if (msg.kind !== 'translate') return;
      await acquire();
      try {
        const response: TranslateResponse = await handleTranslateRequest(msg, {
          translate: translateUnits,
          getCached,
          setCached,
          getSettings,
          jsonFormatSupported,
        });
        port.postMessage(response);
      } finally {
        release();
      }
    });
  });
});
```

- [ ] **Step 7: 验证构建与全部单测**

Run: `npm run build && npm test`
Expected: build 成功；全部测试通过

- [ ] **Step 8: Commit**

```bash
git add lib/messaging lib/translation/scheduler.ts entrypoints/background.ts tests/scheduler.test.ts
git commit -m "feat: Port 协议与 background 调度器（缓存/限流/降级记忆）"
```

---

### Task 10: 译文渲染器 `lib/renderer/host.ts`

**Files:**
- Create: `lib/renderer/host.ts`
- Test: `tests/host.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 11 消费）:
  - `const HOST_ATTR = 'data-llm-translate-host'`
  - `ensureHost(after: Element, hostId: string): HTMLElement` — `li` 插到内部末尾，其他作兄弟插到元素之后；父容器 flex/grid 时独占一行；重复调用同 id 返回已有 host
  - `setHostState(host: HTMLElement, state: 'loading' | 'done' | 'error', text?: string): void` — error 态含 `data-retry` 按钮（事件由调用方 delegate）
  - `removeAllHosts(root: ParentNode): void`

- [ ] **Step 1: 写失败测试**

`tests/host.test.ts`：

```ts
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
    ensureHost(d.querySelectorAll('p')[0], 'x1');
    ensureHost(d.querySelectorAll('p')[1], 'x2');
    removeAllHosts(d);
    expect(d.querySelectorAll(`[${HOST_ATTR}]`)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- host`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `lib/renderer/host.ts`**

```ts
export const HOST_ATTR = 'data-llm-translate-host';

const SHADOW_CSS = `
:host { display: block; }
.body { margin: 4px 0 12px; padding: 6px 10px; border-left: 3px solid #7aa2f7;
  color: #333; background: #f6f8fc; font-size: 0.95em; line-height: 1.6; }
.body.loading { color: #999; }
.body.error { border-left-color: #e06c75; color: #e06c75; }
button[data-retry] { margin-left: 8px; cursor: pointer; }
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
  body.textContent = '翻译中…';
  shadow.append(style, body);

  if (after.tagName === 'LI') {
    after.appendChild(host);
  } else {
    const parent = after.parentElement;
    if (parent) {
      const display = getComputedStyle(parent).display;
      if (display.includes('flex') || display.includes('grid')) {
        host.style.flexBasis = '100%';
        host.style.width = '100%';
      }
      parent.insertBefore(host, after.nextSibling);
    }
  }
  return host;
}

export function setHostState(host: HTMLElement, state: 'loading' | 'done' | 'error', text?: string): void {
  const body = host.shadowRoot?.querySelector('.body');
  if (!body) return;
  body.className = `body ${state}`;
  body.textContent = state === 'loading' ? '翻译中…' : state === 'error' ? '翻译失败' : (text ?? '');
  if (state === 'error') {
    const btn = host.ownerDocument.createElement('button');
    btn.setAttribute('data-retry', '');
    btn.textContent = '重试';
    body.appendChild(btn);
  }
}

export function removeAllHosts(root: ParentNode): void {
  for (const host of root.querySelectorAll(`[${HOST_ATTR}]`)) host.remove();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- host`
Expected: 6 passed（jsdom 的 `getComputedStyle` 对未指定 display 的父元素返回空串，`includes` 安全）

- [ ] **Step 5: Commit**

```bash
git add lib/renderer/host.ts tests/host.test.ts
git commit -m "feat: Shadow DOM 译文渲染器"
```

---

### Task 11: Content script 集成 `entrypoints/content.ts`

**Files:**
- Modify: `entrypoints/content.ts`
- Test: 无单测（集成逻辑由 Task 14 E2E 覆盖；本任务交付物以 build + 手动加载验证）

**Interfaces:**
- Consumes: `findContentRoot`（Task 3）；`extractParagraphs`、`browserIsVisible`、`Paragraph`（Task 4）；`buildChunks`（Task 5）；`TranslateRequest`、`TranslateResponse`（Task 9）；`ensureHost`、`setHostState`、`removeAllHosts`、`HOST_ATTR`（Task 10）；`getSettings`（Task 2）
- Produces（Task 13 popup 通过 `chrome.tabs.sendMessage` 消费的消息协议）:
  - 接收 `{ kind: 'probe' }` → 返回 `{ kind: 'probe-result', paragraphs: number, chars: number, blacklisted: boolean }`
  - 接收 `{ kind: 'start' }` → 开始翻译（幂等：翻译中忽略）
  - 接收 `{ kind: 'cancel' }` → 终止任务、保留已渲染译文
  - 接收 `{ kind: 'clear' }` → 移除全部译文 + 停止监听
  - 推送（popup 监听 `chrome.runtime.onMessage`）：`{ kind: 'progress', done: number, total: number }`、`{ kind: 'task-state', state: 'idle' | 'running' | 'done' | 'error', message?: string }`

- [ ] **Step 1: 实现 `entrypoints/content.ts`**

```ts
import { findContentRoot } from '../lib/extraction/scoring';
import { extractParagraphs, browserIsVisible, Paragraph } from '../lib/extraction/paragraphs';
import { buildChunks } from '../lib/translation/chunking';
import { TranslateRequest, TranslateResponse } from '../lib/messaging/protocol';
import { ensureHost, setHostState, removeAllHosts } from '../lib/renderer/host';
import { getSettings } from '../lib/settings';

const STATE_ATTR = 'data-llm-translate-state';

interface Task {
  id: string;
  cancelled: boolean;
  total: number;
  done: number;
  pending: Map<string, { chunk: TranslateRequest; retries: number }>;
  sliceBuffers: Map<string, { total: number; parts: string[] }>;
  paragraphs: Map<string, Paragraph>;
  observer: MutationObserver | null;
}

let task: Task | null = null;
let port: chrome.runtime.Port | null = null;

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.kind === 'probe') { probe().then(sendResponse); return true; }
      if (msg.kind === 'start') { void startTranslate(); sendResponse({ ok: true }); return; }
      if (msg.kind === 'cancel') { cancelTask(); sendResponse({ ok: true }); return; }
      if (msg.kind === 'clear') { clearAll(); sendResponse({ ok: true }); return; }
    });
    watchSpaNavigation();
  },
});

async function currentHostBlacklisted(): Promise<boolean> {
  const s = await getSettings();
  const host = location.hostname;
  return s.blacklist.some(d => host === d || host.endsWith('.' + d)) || s.disabledSites.includes(host);
}

async function collectParagraphs(): Promise<Paragraph[]> {
  const s = await getSettings();
  const root = findContentRoot(document);
  const ps = extractParagraphs(root, { minLength: s.minLength, cjkRatioThreshold: s.cjkRatioThreshold }, browserIsVisible);
  return ps.filter(p => !p.element.hasAttribute(STATE_ATTR));
}

async function probe() {
  const blacklisted = await currentHostBlacklisted();
  if (blacklisted) return { kind: 'probe-result', paragraphs: 0, chars: 0, blacklisted: true };
  const ps = await collectParagraphs();
  return { kind: 'probe-result', paragraphs: ps.length, chars: ps.reduce((n, p) => n + p.text.length, 0), blacklisted: false };
}

function connectPort(): chrome.runtime.Port {
  if (port) return port;
  port = chrome.runtime.connect({ name: 'translate' });
  port.onMessage.addListener((msg: TranslateResponse) => onChunkResponse(msg));
  port.onDisconnect.addListener(() => {
    port = null;
    // SW 被终止导致断开：重连并重发未完成分块（幂等）
    if (task && !task.cancelled && task.pending.size > 0) {
      for (const p of task.pending.values()) connectPort().postMessage(p.chunk);
    }
  });
  return port;
}

async function startTranslate(): Promise<void> {
  if (task) return; // 幂等
  if (await currentHostBlacklisted()) return;
  const paragraphs = await collectParagraphs();
  if (paragraphs.length === 0) { notify({ kind: 'task-state', state: 'done' }); return; }

  const chunks = buildChunks(paragraphs.map(p => ({ id: p.id, text: p.text })));
  const id = `task-${Date.now()}`;
  task = {
    id, cancelled: false, total: chunks.length, done: 0,
    pending: new Map(), sliceBuffers: new Map(),
    paragraphs: new Map(paragraphs.map(p => [p.id, p])),
    observer: null,
  };
  notify({ kind: 'task-state', state: 'running' });

  for (const p of paragraphs) {
    p.element.setAttribute(STATE_ATTR, 'pending');
    ensureHost(p.element, hostId(id, p.id));
  }
  startObserver();

  chunks.forEach((chunk, i) => {
    const req: TranslateRequest = {
      kind: 'translate', taskId: id, chunkId: `c${i}`,
      units: chunk.units.map(u => ({ paragraphId: u.paragraphId, text: u.text, sliceIndex: u.sliceIndex, sliceTotal: u.sliceTotal })),
    };
    task!.pending.set(req.chunkId, { chunk: req, retries: 0 });
    connectPort().postMessage(req);
  });
}

function onChunkResponse(msg: TranslateResponse): void {
  if (!task || msg.taskId !== task.id || task.cancelled) return;
  const entry = task.pending.get(msg.chunkId);
  if (!entry) return;
  task.pending.delete(msg.chunkId);

  if (msg.kind === 'error') {
    if (msg.code === 'auth') {
      notify({ kind: 'task-state', state: 'error', message: msg.message });
      cancelTask();
      return;
    }
    for (const u of entry.chunk.units) {
      const p = task.paragraphs.get(u.paragraphId);
      if (p) {
        p.element.setAttribute(STATE_ATTR, 'error');
        setHostState(document.querySelector(`[data-llm-translate-host="${hostId(task.id, u.paragraphId)}"]`) as HTMLElement, 'error');
      }
    }
  } else {
    for (const t of msg.translations) {
      const buf = task.sliceBuffers.get(t.paragraphId) ?? { total: t.sliceTotal, parts: [] };
      buf.parts[t.sliceIndex] = t.text;
      task.sliceBuffers.set(t.paragraphId, buf);
      if (buf.parts.filter(Boolean).length === buf.total) {
        const p = task.paragraphs.get(t.paragraphId)!;
        p.element.setAttribute(STATE_ATTR, 'done');
        setHostState(document.querySelector(`[data-llm-translate-host="${hostId(task.id, t.paragraphId)}"]`) as HTMLElement, 'done', buf.parts.join(''));
      }
    }
  }
  task.done++;
  notify({ kind: 'progress', done: task.done, total: task.total });
  if (task.done >= task.total) {
    notify({ kind: 'task-state', state: 'done' });
    stopObserverOnly();
    task = null;
  }
}

// 失败段落重试（事件委托：shadow 内 data-retry 按钮）
document.addEventListener('click', (e) => {
  const path = e.composedPath();
  const btn = path.find(n => n instanceof HTMLElement && n.hasAttribute('data-retry'));
  if (!btn || !task) return;
  const host = path.find(n => n instanceof HTMLElement && n.hasAttribute('data-llm-translate-host')) as HTMLElement | undefined;
  const pid = host?.getAttribute('data-llm-translate-host')?.split('/')[1];
  const p = pid ? task.paragraphs.get(pid) : undefined;
  if (!p) return;
  const req: TranslateRequest = {
    kind: 'translate', taskId: task.id, chunkId: `retry-${pid}`,
    units: [{ paragraphId: p.id, text: p.text, sliceIndex: 0, sliceTotal: 1 }],
  };
  task.pending.set(req.chunkId, { chunk: req, retries: 0 });
  connectPort().postMessage(req);
}, true);

function cancelTask(): void {
  if (!task) return;
  task.cancelled = true;
  task.pending.clear();
  stopObserverOnly();
  task = null;
  notify({ kind: 'task-state', state: 'idle' });
}

function clearAll(): void {
  cancelTask();
  removeAllHosts(document);
  document.querySelectorAll(`[${STATE_ATTR}]`).forEach(el => el.removeAttribute(STATE_ATTR));
}

function startObserver(): void {
  if (!task || task.observer) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  task.observer = new MutationObserver((mutations) => {
    if (mutations.every(m => (m.target as Element).closest?.('[data-llm-translate-host]'))) return; // 自触发过滤
    clearTimeout(timer);
    timer = setTimeout(() => void onNewContent(), 300);
  });
  task.observer.observe(document.body, { childList: true, subtree: true });
}

async function onNewContent(): Promise<void> {
  if (!task || task.cancelled) return;
  const fresh = await collectParagraphs();
  if (fresh.length === 0) return;
  const chunks = buildChunks(fresh.map(p => ({ id: p.id, text: p.text })), 1500);
  task.total += chunks.length;
  for (const p of fresh) {
    task.paragraphs.set(p.id, p);
    p.element.setAttribute(STATE_ATTR, 'pending');
    ensureHost(p.element, hostId(task.id, p.id));
  }
  chunks.forEach((chunk, i) => {
    const req: TranslateRequest = {
      kind: 'translate', taskId: task!.id, chunkId: `c-inc-${Date.now()}-${i}`,
      units: chunk.units.map(u => ({ paragraphId: u.paragraphId, text: u.text, sliceIndex: u.sliceIndex, sliceTotal: u.sliceTotal })),
    };
    task!.pending.set(req.chunkId, { chunk: req, retries: 0 });
    connectPort().postMessage(req);
  });
  notify({ kind: 'progress', done: task.done, total: task.total });
}

function stopObserverOnly(): void {
  task?.observer?.disconnect();
  if (task) task.observer = null;
}

function watchSpaNavigation(): void {
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      clearAll();
    }
  }, 1000);
}

function hostId(taskId: string, paragraphId: string): string {
  return `${taskId}/${paragraphId}`;
}

function notify(msg: unknown): void {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup 未打开时忽略 */ });
}
```

注意：增量提取的新段落 id 复用 `p0…` 序号会撞车 —— `extractParagraphs` 每次从 0 编号。因此 `collectParagraphs` 需在返回前为已见元素重映射 id：给元素加 `data-llm-translate-pid` 属性，已有则复用，否则分配全局递增序号。实现时在 `collectParagraphs` 顶部加：

```ts
let pidSeq = 0;
function stableId(el: Element): string {
  const existing = el.getAttribute('data-llm-translate-pid');
  if (existing) return existing;
  const id = `p${pidSeq++}`;
  el.setAttribute('data-llm-translate-pid', id);
  return id;
}
```

并在 `collectParagraphs` 里 `ps.forEach(p => { p.id = stableId(p.element); })`；`clearAll` 同时移除 `data-llm-translate-pid`。

- [ ] **Step 2: 验证构建 + 手动冒烟**

Run: `npm run build`
Expected: build 成功。随后 `chrome://extensions` 加载 `.output/chrome-mv3`，打开任意英文页面，console 无报错（本任务尚无 UI 触发入口，冒烟只验证注入不崩）

- [ ] **Step 3: Commit**

```bash
git add entrypoints/content.ts
git commit -m "feat: content script 集成（提取/Port/渲染/增量/取消/SPA）"
```

---

### Task 12: 设置页 `entrypoints/options/`

**Files:**
- Create: `entrypoints/options/index.html`、`entrypoints/options/main.ts`
- Test: 无单测（表单绑定逻辑由 E2E/手动验收覆盖）

**Interfaces:**
- Consumes: `getSettings`、`saveSettings`、`apiOriginPattern`（Task 2）
- Produces: 用户可配置的 base URL / API Key / 模型名 / 系统提示词 / 目标语言 / 黑名单 / 过滤阈值；「授权 API 域名」按钮调 `chrome.permissions.request`；保存时如 baseUrl 变更则 `chrome.permissions.remove` 回收旧域名权限

- [ ] **Step 1: 写 `entrypoints/options/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>LLM Translate 设置</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 24px auto; padding: 0 16px; }
  label { display: block; margin-top: 12px; font-weight: 600; }
  input, textarea, select { width: 100%; box-sizing: border-box; padding: 6px; margin-top: 4px; }
  textarea { min-height: 80px; }
  .row { display: flex; gap: 12px; } .row > div { flex: 1; }
  #status { margin-top: 12px; color: #2a7; }
  #perm-status { font-weight: 400; margin-left: 8px; }
</style></head>
<body>
  <h1>LLM Translate 设置</h1>
  <label>API Base URL <input id="baseUrl" placeholder="https://api.deepseek.com"></label>
  <label>API Key <input id="apiKey" type="password"></label>
  <label>模型名 <input id="model" placeholder="deepseek-chat"></label>
  <label>系统提示词 <textarea id="systemPrompt"></textarea></label>
  <div class="row">
    <div><label>目标语言 <input id="targetLang"></label></div>
    <div><label>最短段落长度 <input id="minLength" type="number"></label></div>
    <div><label>中文占比阈值 <input id="cjkRatioThreshold" type="number" step="0.05" min="0" max="1"></label></div>
  </div>
  <label>网站黑名单（每行一个域名）<textarea id="blacklist"></textarea></label>
  <p><button id="save">保存</button>
     <button id="grant">授权访问 API 域名</button><span id="perm-status"></span></p>
  <p id="status"></p>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

- [ ] **Step 2: 写 `entrypoints/options/main.ts`**

```ts
import { getSettings, saveSettings, apiOriginPattern } from '../../lib/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function refreshPermStatus(): Promise<void> {
  const s = await getSettings();
  if (!s.baseUrl) return;
  const granted = await chrome.permissions.contains({ origins: [apiOriginPattern(s.baseUrl)] });
  $('perm-status').textContent = granted ? '（已授权）' : '（未授权，翻译前需授权）';
}

async function load(): Promise<void> {
  const s = await getSettings();
  ($('baseUrl') as HTMLInputElement).value = s.baseUrl;
  ($('apiKey') as HTMLInputElement).value = s.apiKey;
  ($('model') as HTMLInputElement).value = s.model;
  ($('systemPrompt') as HTMLTextAreaElement).value = s.systemPrompt;
  ($('targetLang') as HTMLInputElement).value = s.targetLang;
  ($('minLength') as HTMLInputElement).value = String(s.minLength);
  ($('cjkRatioThreshold') as HTMLInputElement).value = String(s.cjkRatioThreshold);
  ($('blacklist') as HTMLTextAreaElement).value = s.blacklist.join('\n');
  await refreshPermStatus();
}

$('save').addEventListener('click', async () => {
  const old = await getSettings();
  await saveSettings({
    baseUrl: ($('baseUrl') as HTMLInputElement).value.trim().replace(/\/+$/, ''),
    apiKey: ($('apiKey') as HTMLInputElement).value.trim(),
    model: ($('model') as HTMLInputElement).value.trim(),
    systemPrompt: ($('systemPrompt') as HTMLTextAreaElement).value,
    targetLang: ($('targetLang') as HTMLInputElement).value.trim() || '中文',
    minLength: Number(($('minLength') as HTMLInputElement).value) || 20,
    cjkRatioThreshold: Number(($('cjkRatioThreshold') as HTMLInputElement).value) || 0.3,
    blacklist: ($('blacklist') as HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean),
  });
  // baseUrl 变更：回收旧域名权限
  const next = ($('baseUrl') as HTMLInputElement).value.trim().replace(/\/+$/, '');
  if (old.baseUrl && old.baseUrl !== next) {
    await chrome.permissions.remove({ origins: [apiOriginPattern(old.baseUrl)] });
  }
  $('status').textContent = '已保存';
  await refreshPermStatus();
});

$('grant').addEventListener('click', async () => {
  const baseUrl = ($('baseUrl') as HTMLInputElement).value.trim().replace(/\/+$/, '');
  if (!baseUrl) { $('status').textContent = '请先填写 Base URL'; return; }
  const granted = await chrome.permissions.request({ origins: [apiOriginPattern(baseUrl)] });
  $('status').textContent = granted ? '授权成功' : '授权被拒绝，翻译请求将被浏览器拦截';
  await refreshPermStatus();
});

chrome.permissions.onAdded.addListener(refreshPermStatus);
chrome.permissions.onRemoved.addListener(refreshPermStatus);

void load();
```

- [ ] **Step 3: 验证构建**

Run: `npm run build`
Expected: build 成功，`.output/chrome-mv3/options.html` 存在

- [ ] **Step 4: Commit**

```bash
git add entrypoints/options
git commit -m "feat: 设置页（含 API 域名授权与权限回收）"
```

---

### Task 13: Popup `entrypoints/popup/`

**Files:**
- Create: `entrypoints/popup/index.html`、`entrypoints/popup/main.ts`
- Test: 无单测（由 E2E/手动验收覆盖）

**Interfaces:**
- Consumes: Task 11 的消息协议（`probe`/`start`/`cancel`/`clear` + `progress`/`task-state` 推送）；`getSettings`、`apiOriginPattern`（Task 2）
- Produces: 完整用户入口——预估（`tokens ≈ chars / 3.5`）、开始/取消、站点开关（写入 `disabledSites`）、授权入口、进度展示

- [ ] **Step 1: 写 `entrypoints/popup/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8">
<style>
  body { font-family: system-ui, sans-serif; width: 280px; padding: 12px; }
  button { width: 100%; padding: 8px; margin-top: 8px; cursor: pointer; }
  #estimate, #progress, #message { font-size: 13px; color: #555; margin-top: 8px; }
  #message.error { color: #e06c75; }
  .row { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 13px; }
  a { font-size: 12px; }
</style></head>
<body>
  <div class="row"><input type="checkbox" id="site-toggle" checked><label for="site-toggle">在此站点启用</label></div>
  <div id="estimate"></div>
  <div id="progress"></div>
  <button id="action">翻译本页</button>
  <button id="grant" hidden>授权 API 域名</button>
  <div id="message"></div>
  <p><a href="#" id="open-options">打开设置页</a></p>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

- [ ] **Step 2: 写 `entrypoints/popup/main.ts`**

```ts
import { getSettings, saveSettings, apiOriginPattern } from '../../lib/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let state: 'idle' | 'running' | 'done' | 'error' = 'idle';
let currentTabId = 0;

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setState(s: typeof state, message = ''): void {
  state = s;
  ($('action') as HTMLButtonElement).textContent = s === 'running' ? '取消翻译' : '翻译本页';
  $('message').textContent = message;
  $('message').className = s === 'error' ? 'error' : '';
  $('progress').textContent = '';
  if (s === 'idle') $('estimate').textContent = '';
}

async function refresh(): Promise<void> {
  const tab = await activeTab();
  if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) {
    $('estimate').textContent = '当前页面不支持翻译';
    ($('action') as HTMLButtonElement).disabled = true;
    return;
  }
  currentTabId = tab.id;
  const host = new URL(tab.url).hostname;
  const s = await getSettings();
  const disabled = s.disabledSites.includes(host);
  ($('site-toggle') as HTMLInputElement).checked = !disabled;

  if (!s.apiKey) { $('message').textContent = '请先在设置页填写 API Key'; $('message').className = 'error'; }

  const granted = await chrome.permissions.contains({ origins: [apiOriginPattern(s.baseUrl)] });
  ($('grant') as HTMLButtonElement).hidden = granted;
  if (!granted) $('message').textContent = 'API 域名未授权，点击「授权 API 域名」';

  const probe = await chrome.tabs.sendMessage(tab.id, { kind: 'probe' }).catch(() => null);
  if (probe?.blacklisted) {
    $('estimate').textContent = '此站点在黑名单中';
  } else if (probe && !disabled) {
    const tokens = Math.ceil(probe.chars / 3.5);
    $('estimate').textContent = `将翻译 ${probe.paragraphs} 段 / 约 ${tokens} tokens`;
  }
}

$('action').addEventListener('click', async () => {
  if (state === 'running') {
    await chrome.tabs.sendMessage(currentTabId, { kind: 'cancel' });
    setState('idle');
    return;
  }
  await chrome.tabs.sendMessage(currentTabId, { kind: 'start' });
  setState('running');
});

$('grant').addEventListener('click', async () => {
  const s = await getSettings();
  const granted = await chrome.permissions.request({ origins: [apiOriginPattern(s.baseUrl)] });
  ($('grant') as HTMLButtonElement).hidden = granted;
  $('message').textContent = granted ? '' : '授权被拒绝，翻译请求将被浏览器拦截';
});

$('site-toggle').addEventListener('change', async (e) => {
  const tab = await activeTab();
  const host = new URL(tab.url!).hostname;
  const s = await getSettings();
  const enabled = (e.target as HTMLInputElement).checked;
  const disabledSites = enabled ? s.disabledSites.filter(d => d !== host) : [...new Set([...s.disabledSites, host])];
  await saveSettings({ disabledSites });
  if (!enabled) await chrome.tabs.sendMessage(tab.id!, { kind: 'clear' }).catch(() => {});
});

$('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.kind === 'progress') $('progress').textContent = `进度 ${msg.done} / ${msg.total}`;
  if (msg.kind === 'task-state') setState(msg.state, msg.message ?? '');
});

void refresh();
```

- [ ] **Step 3: 验证构建 + 手动冒烟**

Run: `npm run build`
Expected: build 成功。加载 `.output/chrome-mv3` 后点开 popup，英文页面显示段数/token 预估；未授权时显示授权按钮

- [ ] **Step 4: Commit**

```bash
git add entrypoints/popup
git commit -m "feat: popup（预估/进度/取消/站点开关/授权入口）"
```

---

### Task 14: E2E（Playwright）+ 手动验收

**Files:**
- Create: `playwright.config.ts`、`e2e/fixtures.ts`、`e2e/translate.spec.ts`、`e2e/test-page.html`
- Test: `e2e/translate.spec.ts`（自身即测试）

**Interfaces:**
- Consumes: `npm run build` 产物 `.output/chrome-mv3`（Task 1–13 全部）
- Produces: `npm run e2e` 可跑通的核心链路验证

- [ ] **Step 1: 写 Playwright 配置与 fixture**

`playwright.config.ts`：

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: { headless: false }, // MV3 扩展需 headed 或 new headless
});
```

`e2e/fixtures.ts`：

```ts
import { test as base, chromium, BrowserContext } from '@playwright/test';
import path from 'path';

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const pathToExtension = path.resolve('.output/chrome-mv3');
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
        '--headless=new',
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw.url().split('/')[2]);
  },
});
export const expect = test.expect;
```

- [ ] **Step 2: 写测试页与 E2E 用例**

`e2e/test-page.html`：

```html
<!doctype html><html><body>
<nav><ul><li><a href="#">Navigation link one here</a></li></ul></nav>
<article>
  <p>This is the first sufficiently long English paragraph of the test article body.</p>
  <p>This is the second sufficiently long English paragraph of the test article body.</p>
</article>
<aside class="sidebar"><p>Sidebar content that should never be translated at all.</p></aside>
</body></html>
```

`e2e/translate.spec.ts`：

```ts
import { test, expect } from './fixtures';

test.beforeEach(async ({ context, extensionId }) => {
  // 预置设置（写入扩展的 storage.local）
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.evaluate(() => chrome.storage.local.set({
    settings: {
      baseUrl: 'http://127.0.0.1:4789', apiKey: 'sk-test', model: 'm1',
      systemPrompt: 'SYS', targetLang: '中文', blacklist: [], disabledSites: [],
      minLength: 20, cjkRatioThreshold: 0.3,
    },
  }));
  // 授权 stub 域名（optional_host_permissions 已声明 *://*/* 上限）
  await page.evaluate(() => chrome.permissions.request({ origins: ['http://127.0.0.1:4789/*'] })).catch(() => {});
  await page.close();
});

test('全文翻译：正文段落出现译文，导航与侧边栏不翻', async ({ context, extensionId }) => {
  // SW fetch 打桩：用 route 无法拦 SW 请求，改用 CDP fetch 域或在测试页注入 stub server。
  // 方案：本地起 stub server 更简单 —— 见 Step 3 说明，这里假定 stub 在 4789 端口
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4789/page');

  // 触发翻译（E2E 中没有真实 popup 点击，通过扩展页面代理调用 chrome.tabs API 向测试页发消息）
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/options.html`);
  await driver.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: false });
    const tabs = await chrome.tabs.query({});
    const target = tabs.find(x => x.url?.startsWith('http://127.0.0.1:4789/'));
    if (target?.id) await chrome.tabs.sendMessage(target.id, { kind: 'start' });
  });

  await expect(page.locator('[data-llm-translate-host]')).toHaveCount(2, { timeout: 15000 });
  const shadow = page.locator('[data-llm-translate-host]').first();
  await expect(shadow).toContainText('译文');
});
```

注意：Playwright 的 `page.route` **无法拦截 service worker 发起的 fetch**。Step 3 用本地 stub HTTP server 解决：E2E 启动前在 `globalSetup` 起一个返回固定 JSON 的 node http server（监听 `127.0.0.1:4789`），设置里的 baseUrl 写 `http://127.0.0.1:4789`，该 origin 已在 `optional_host_permissions` 覆盖范围内（`*://*/*`），E2E 里通过扩展页面调 `chrome.permissions.request` 完成授权（测试环境可自动授予）。测试页不放在 file://（file:// 页面默认不注入 content script），而由 stub server 托管在 `http://127.0.0.1:4789/page`。

- [ ] **Step 3: 写 stub server 与 globalSetup**

`e2e/stub-server.ts`：

```ts
import http from 'http';
import fs from 'fs';
import path from 'path';

export function startStubServer(port = 4789): http.Server {
  const pageHtml = fs.readFileSync(path.resolve('e2e/test-page.html'), 'utf8');
  return http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(pageHtml);
      return;
    }
    if (req.url === '/chat/completions') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const texts = [...body.matchAll(/\[\d+\] ([^\n]+)/g)].map(m => m[1]);
        const items = texts.map((_, i) => ({ i, t: `译文${i}` }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }).listen(port);
}
```

`playwright.config.ts` 增加：

```ts
import { startStubServer } from './e2e/stub-server';

export default defineConfig({
  // ...上文配置
  globalSetup: async () => {
    const server = startStubServer();
    return async () => server.close();
  },
});
```

用例中测试页 URL 用 `http://127.0.0.1:4789/page`，设置 baseUrl 用 `http://127.0.0.1:4789`。E2E 需覆盖的 5 条（对照 spec）：插入位置正确、不破坏原页面交互（测试页加按钮验证可点击）、SPA 动态加载内容可翻（`page.evaluate` 动态 append 段落，断言新 host 出现）、失败段落可重试（stub 首次 500 二次成功）、站点开关刷新保持（写 disabledSites 后 reload，断言无 host）。

- [ ] **Step 4: 跑 E2E**

Run: `npm run build && npx playwright install chromium && npm run e2e`
Expected: 全部用例通过（如 `--headless=new` 下 SW 异常，改 `headless: false` 在有显示环境跑）

- [ ] **Step 5: 手动验收清单（在真实浏览器执行）**

- [ ] Wikipedia 英文词条：正文翻译，左侧导航/顶部菜单不翻
- [ ] Medium / dev.to 文章：译文在段落下方，深色模式可读
- [ ] GitHub 仓库页（SPA）：切换文件/Tab 后旧译文清理，可重新触发
- [ ] 真实 API Key 全流程：预估 → 授权 → 组级流式渲染 → 第二次打开同页缓存命中（几乎秒出）
- [ ] 取消：翻译中点「取消」，后续段落不再出现译文
- [ ] 站点开关：关闭后译文移除，刷新后保持关闭

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts e2e
git commit -m "test: Playwright E2E 与 LLM stub server"
```

---

## 自审记录

- Spec 覆盖：正文识别（T3）、提取与过滤（T4）、增量提取与自触发过滤（T11）、分块与分片（T5）、JSON 结构化输出与解析（T6）、response_format 400 降级（T7）、429/5xx 退避（T7）、并发限流 best-effort（T9 Step 6）、缓存 key 构成与 LRU（T8）、Port 协议与任务/分块 id（T9/T11）、SW 终止重连重发（T11 connectPort）、Shadow DOM 渲染与插入规则（T10）、取消与清理（T11/T13）、权限申请收窄与回收（T12/T13）、token 预估（T13）、站点开关持久化（T13）、E2E 打桩与手动验收（T14）
- 类型一致性：`TranslateRequest/TranslateResponse`（T9 定义，T11 使用）、`Paragraph`（T4 定义，T11 使用）、`SchedulerDeps`（T9 定义，background 薄壳填充）、`ensureHost/setHostState/removeAllHosts/HOST_ATTR`（T10 定义，T11 使用）、`getSettings/saveSettings/apiOriginPattern`（T2 定义，T9/T11/T12/T13 使用）均已核对一致
- 已知实现注意点已就地标注：T9 import 位置、T11 段落 id 稳定性重映射、T14 SW fetch 不可被 page.route 拦截需 stub server
