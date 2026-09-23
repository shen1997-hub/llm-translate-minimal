# 划词单词详解（词典卡片）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 划词选中单词或短词组（≤3 词）时，浮窗展示结构化词典卡片（音标、词性义项、关联词、当前句语境解释），取代原来的纯翻译文本。

**Architecture:** 新增独立 `lookup` 消息通道：content 端判定单词后截取所在句子发 `LookupRequest`；background 用专用词典提示词经 LLM 一次性返回 JSON，解析为 `WordEntry`；selection 浮窗新增 `showWordCard` 分区块渲染。与现有 translate 通道完全并行、互不干扰。

**Tech Stack:** TypeScript + WXT（Chrome MV3）、vitest（jsdom 环境）、无新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-23-word-lookup-design.md`

## Global Constraints

- 不新增任何 npm 依赖；只用项目已有的 vitest / jsdom / chrome 类型。
- UI 文案用中文（与现有浮窗「翻译中…」「重试」一致）。
- 测试命令：`npm test`（vitest run）；类型检查：`npm run typecheck`；构建验证：`npm run build`。
- vitest 环境为 jsdom（`vitest.config.ts`），可直接使用 `document.createRange` / `Node.TEXT_NODE`。
- 每个 Task 结束单独 commit，commit message 用中文、遵循 `type: 描述` 格式（参考 git log 中的 `docs: ...`）。
- **已知简化（与 spec 的偏差，有意为之）：** `extractSentence` 只在选区起点所在的同一个文本节点内向前后扩展句边界，不跨兄弟文本节点。普通文章段落通常是单一文本节点，覆盖绝大多数情况；跨节点选区退化为节点内片段，可接受。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `lib/extraction/word.ts` | `isWordLike` 判定 + `extractSentence` 取句（纯函数） | 新建 |
| `tests/word.test.ts` | 上述两函数单测 | 新建 |
| `lib/translation/prompt.ts` | `WordEntry` 类型 + `buildLookupMessages` + `parseLookupResponse` | 修改（追加） |
| `tests/lookup-prompt.test.ts` | 词典提示词与解析单测 | 新建 |
| `lib/translation/llm-client.ts` | `lookupWord` 一次性词典请求（json→plain 降级） | 修改（追加） |
| `tests/llm-client.test.ts` | 追加 `lookupWord` 用例 | 修改（追加） |
| `lib/messaging/protocol.ts` | `LookupRequest` / `LookupResponse` 类型 | 修改（追加） |
| `lib/translation/scheduler.ts` | `handleLookupRequest` + `SchedulerDeps.lookup` | 修改（追加） |
| `tests/scheduler.test.ts` | `handleLookupRequest` 用例 + makeDeps 补 `lookup` | 修改（追加） |
| `entrypoints/background.ts` | port 消息按 kind 分发 lookup 分支 | 修改 |
| `lib/renderer/selection.ts` | `showWordCard` 卡片渲染 + `formatWordEntryText` 复制文本 | 修改 |
| `tests/word-card.test.ts` | `formatWordEntryText` 单测 | 新建 |
| `entrypoints/content.ts` | 点击圆钮时的词典分支、响应路由、重试 | 修改 |

---

### Task 1: 单词判定与取句纯函数（lib/extraction/word.ts）

**Files:**
- Create: `lib/extraction/word.ts`
- Test: `tests/word.test.ts`

**Interfaces:**
- Produces（后续 Task 7 消费）:
  - `isWordLike(text: string): boolean`
  - `extractSentence(range: Range): string`

- [ ] **Step 1: 写失败测试**

创建 `tests/word.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { isWordLike, extractSentence } from '../lib/extraction/word';

describe('isWordLike', () => {
  it('单个词判定为单词', () => {
    expect(isWordLike('apple')).toBe(true);
  });
  it('连字符复合词判定为单词', () => {
    expect(isWordLike('well-known')).toBe(true);
  });
  it('2-3 个词的词组判定为单词', () => {
    expect(isWordLike('take care')).toBe(true);
    expect(isWordLike('take care of')).toBe(true);
  });
  it('超过 3 个词不判定为单词', () => {
    expect(isWordLike('this is a sentence')).toBe(false);
  });
  it('含句读符号不判定为单词', () => {
    expect(isWordLike('hello.')).toBe(false);
    expect(isWordLike('什么？')).toBe(false);
  });
  it('空白与超长输入不判定为单词', () => {
    expect(isWordLike('   ')).toBe(false);
    expect(isWordLike('x'.repeat(61))).toBe(false);
  });
  it('单个中文词判定为单词', () => {
    expect(isWordLike('翻译')).toBe(true);
  });
});

function makeRange(text: string, word: string): Range {
  const div = document.createElement('div');
  div.textContent = text;
  const node = div.firstChild as Text;
  const start = text.indexOf(word);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + word.length);
  return range;
}

describe('extractSentence', () => {
  it('句中选词：返回完整句子', () => {
    const r = makeRange('The quick brown fox jumps over the lazy dog. Next sentence here.', 'brown');
    expect(extractSentence(r)).toBe('The quick brown fox jumps over the lazy dog.');
  });
  it('不串到相邻句', () => {
    const r = makeRange('First one. Second one. Third one.', 'Second');
    expect(extractSentence(r)).toBe('Second one.');
  });
  it('中文句读边界', () => {
    const r = makeRange('今天天气很好。我们去公园散步。明天再说。', '公园');
    expect(extractSentence(r)).toBe('我们去公园散步。');
  });
  it('选区起点在元素节点：退化为选中文本', () => {
    const div = document.createElement('div');
    div.innerHTML = '<b>hello</b> world';
    const range = document.createRange();
    range.selectNodeContents(div);
    expect(extractSentence(range)).toBe('hello world');
  });
  it('超长句子以选词为中心截断到 300 字符', () => {
    const text = `${'a'.repeat(200)} TARGET ${'b'.repeat(200)}`;
    const r = makeRange(text, 'TARGET');
    const s = extractSentence(r);
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).toContain('TARGET');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/word.test.ts`
Expected: FAIL — `Cannot find module '../lib/extraction/word'`

- [ ] **Step 3: 实现 lib/extraction/word.ts**

```ts
const SENTENCE_PUNCT_RE = /[.!?。！？；;]/;
const SENTENCE_BOUNDARY_RE = /[.!?。！？；;\n]/;
const MAX_WORD_LEN = 60;
const MAX_SENTENCE_LEN = 300;

/** 选中内容是否为单词/短词组（≤3 词、无句读符号、长度 ≤60） */
export function isWordLike(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > MAX_WORD_LEN) return false;
  if (SENTENCE_PUNCT_RE.test(t)) return false;
  return t.split(/\s+/).length <= 3;
}

/**
 * 取选区所在的完整句子：只在选区起点所在文本节点内向前后扩展到句边界。
 * 跨节点的选区退化为该节点内片段；选区起点落在元素节点时退化为选中文本本身。
 */
export function extractSentence(range: Range): string {
  const collapsed = range.toString().replace(/\s+/g, ' ').trim();
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return collapsed;
  const text = node.textContent ?? '';
  const start = range.startOffset;
  let s = start;
  while (s > 0 && !SENTENCE_BOUNDARY_RE.test(text[s - 1]!)) s--;
  let e = start;
  while (e < text.length && !SENTENCE_BOUNDARY_RE.test(text[e]!)) e++;
  if (e < text.length) e++; // 句尾标点一并带上
  let sentence = text.slice(s, e).replace(/\s+/g, ' ').trim();
  if (sentence.length > MAX_SENTENCE_LEN) {
    const idx = collapsed !== '' ? sentence.indexOf(collapsed) : -1;
    const center = idx >= 0 ? idx + collapsed.length / 2 : sentence.length / 2;
    const from = Math.max(0, Math.floor(center - MAX_SENTENCE_LEN / 2));
    sentence = sentence.slice(from, from + MAX_SENTENCE_LEN);
  }
  return sentence;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/word.test.ts`
Expected: PASS（7 + 5 个用例）

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/word.ts tests/word.test.ts
git commit -m "feat: 新增单词判定与取句纯函数 isWordLike/extractSentence"
```

---

### Task 2: 词典提示词与响应解析（lib/translation/prompt.ts）

**Files:**
- Modify: `lib/translation/prompt.ts`（文件尾部追加）
- Test: `tests/lookup-prompt.test.ts`（新建）

**Interfaces:**
- Consumes: 无（自包含）
- Produces（Task 3/4/6 消费）:
  - `interface WordEntry { word: string; phonetic?: string; senses: { pos: string; meaning: string }[]; related: { word: string; note: string }[]; contextual: string }`
  - `buildLookupMessages(word: string, sentence: string, targetLang: string): ChatMessage[]`
  - `parseLookupResponse(content: string): WordEntry | null`

- [ ] **Step 1: 写失败测试**

创建 `tests/lookup-prompt.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildLookupMessages, parseLookupResponse } from '../lib/translation/prompt';

describe('buildLookupMessages', () => {
  it('系统提示含目标语言与 JSON 结构要求，用户消息含单词与句子', () => {
    const m = buildLookupMessages('raise', 'Please raise your hand.', '中文');
    expect(m[0]!.role).toBe('system');
    expect(m[0]!.content).toContain('中文');
    expect(m[0]!.content).toContain('"senses"');
    expect(m[0]!.content).toContain('"contextual"');
    expect(m[1]!.role).toBe('user');
    expect(m[1]!.content).toContain('raise');
    expect(m[1]!.content).toContain('Please raise your hand.');
  });
});

describe('parseLookupResponse', () => {
  it('正常解析完整词条', () => {
    const r = parseLookupResponse('{"word":"raise","phonetic":"/reɪz/","senses":[{"pos":"v.","meaning":"举起"}],"related":[{"word":"lift","note":"syn. 举起"}],"contextual":"本句中指举起手"}');
    expect(r).toEqual({
      word: 'raise',
      phonetic: '/reɪz/',
      senses: [{ pos: 'v.', meaning: '举起' }],
      related: [{ word: 'lift', note: 'syn. 举起' }],
      contextual: '本句中指举起手',
    });
  });
  it('容忍 ```json 围栏', () => {
    const r = parseLookupResponse('```json\n{"word":"a","senses":[{"pos":"n.","meaning":"甲"}],"related":[],"contextual":"x"}\n```');
    expect(r?.word).toBe('a');
  });
  it('phonetic 为空串时归一为 undefined', () => {
    const r = parseLookupResponse('{"word":"a","phonetic":"","senses":[{"pos":"n.","meaning":"甲"}],"related":[],"contextual":"x"}');
    expect(r?.phonetic).toBeUndefined();
  });
  it('义项/关联词里的非法条目被过滤', () => {
    const r = parseLookupResponse('{"word":"a","senses":[{"pos":"n.","meaning":"甲"},{"pos":1}],"related":[{"word":"b"},{"word":"c","note":"syn. 丙"}],"contextual":"x"}');
    expect(r?.senses).toEqual([{ pos: 'n.', meaning: '甲' }]);
    expect(r?.related).toEqual([{ word: 'c', note: 'syn. 丙' }]);
  });
  it('义项与语境解释同时缺失时返回 null', () => {
    expect(parseLookupResponse('{"word":"a","senses":[],"related":[]}')).toBeNull();
  });
  it('非 JSON / 非对象返回 null', () => {
    expect(parseLookupResponse('not json')).toBeNull();
    expect(parseLookupResponse('[1,2]')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/lookup-prompt.test.ts`
Expected: FAIL — `buildLookupMessages is not exported`

- [ ] **Step 3: 在 lib/translation/prompt.ts 尾部追加实现**

```ts
export interface WordEntry {
  word: string;
  phonetic?: string;
  senses: { pos: string; meaning: string }[];
  related: { word: string; note: string }[];
  contextual: string;
}

export function buildLookupMessages(word: string, sentence: string, targetLang: string): ChatMessage[] {
  const schema = '{"word":"the word","phonetic":"IPA transcription, empty string if not applicable","senses":[{"pos":"part of speech","meaning":"meaning in ' + targetLang + '"}],"related":[{"word":"related word","note":"relation tag + short gloss, e.g. \\"syn. 举起\\""}],"contextual":"explanation of the word as used in the given sentence, in ' + targetLang + '"}';
  return [
    {
      role: 'system',
      content: `You are a dictionary. Explain the given word or short phrase in ${targetLang}. "senses" lists each part of speech with its meanings; "related" lists synonyms/antonyms/derivatives; "contextual" explains the meaning in the given sentence. Respond with JSON only, no other text: ${schema}`,
    },
    { role: 'user', content: `Word: ${word}\nSentence: ${sentence}` },
  ];
}

export function parseLookupResponse(content: string): WordEntry | null {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as { word?: unknown; phonetic?: unknown; senses?: unknown; related?: unknown; contextual?: unknown };
  const senses = Array.isArray(o.senses)
    ? o.senses.filter((s): s is { pos: string; meaning: string } =>
        typeof s === 'object' && s !== null
        && typeof (s as { pos?: unknown }).pos === 'string'
        && typeof (s as { meaning?: unknown }).meaning === 'string')
    : [];
  const related = Array.isArray(o.related)
    ? o.related.filter((r): r is { word: string; note: string } =>
        typeof r === 'object' && r !== null
        && typeof (r as { word?: unknown }).word === 'string'
        && typeof (r as { note?: unknown }).note === 'string')
    : [];
  const contextual = typeof o.contextual === 'string' ? o.contextual : '';
  if (senses.length === 0 && contextual === '') return null;
  return {
    word: typeof o.word === 'string' ? o.word : '',
    phonetic: typeof o.phonetic === 'string' && o.phonetic !== '' ? o.phonetic : undefined,
    senses,
    related,
    contextual,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/lookup-prompt.test.ts`
Expected: PASS（1 + 6 个用例）

- [ ] **Step 5: Commit**

```bash
git add lib/translation/prompt.ts tests/lookup-prompt.test.ts
git commit -m "feat: 词典提示词 buildLookupMessages 与响应解析 parseLookupResponse"
```

---

### Task 3: lookupWord 客户端（lib/translation/llm-client.ts）

**Files:**
- Modify: `lib/translation/llm-client.ts`（import 行 + 文件尾部追加）
- Test: `tests/llm-client.test.ts`（import 行 + 文件尾部追加 describe）

**Interfaces:**
- Consumes: Task 2 的 `buildLookupMessages` / `parseLookupResponse` / `WordEntry`；本文件已有的 `chatCompletion`、`FormatUnsupportedError`、`AuthError`、`Deps`、`LlmConfig`（均无需改动）
- Produces（Task 4 消费）:
  - `lookupWord(cfg: LlmConfig, word: string, sentence: string, opts: { targetLang: string; useJsonFormat: boolean }, deps?: Deps): Promise<WordEntry | null>` — 解析失败返回 `null`；`AuthError` 向上抛；`FormatUnsupportedError` 内部降级 plain 重发

- [ ] **Step 1: 写失败测试**

`tests/llm-client.test.ts` 第 2 行 import 改为：

```ts
import { translateUnits, lookupWord, AuthError } from '../lib/translation/llm-client';
```

文件尾部追加：

```ts
describe('lookupWord', () => {
  const entry = {
    word: 'raise', phonetic: '/reɪz/',
    senses: [{ pos: 'v.', meaning: '举起' }],
    related: [], contextual: '本句中指举起手',
  };

  it('正常 JSON 响应解析为 WordEntry，并带 response_format', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(JSON.stringify(entry))) as any;
    const r = await lookupWord(CFG, 'raise', 'Please raise your hand.', { targetLang: '中文', useJsonFormat: true }, { fetchImpl, sleep: noSleep });
    expect(r).toEqual(entry);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('400 涉及 response_format 时降级重发', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"response_format not supported"}', { status: 400 }))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify(entry))) as any;
    const r = await lookupWord(CFG, 'raise', 's', { targetLang: '中文', useJsonFormat: true }, { fetchImpl, sleep: noSleep });
    expect(r?.word).toBe('raise');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
    expect(body2.response_format).toBeUndefined();
  });

  it('响应无法解析时返回 null', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('garbage not json')) as any;
    const r = await lookupWord(CFG, 'raise', 's', { targetLang: '中文', useJsonFormat: true }, { fetchImpl, sleep: noSleep });
    expect(r).toBeNull();
  });

  it('401 抛 AuthError', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 })) as any;
    await expect(lookupWord(CFG, 'raise', 's', { targetLang: '中文', useJsonFormat: true }, { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(AuthError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/llm-client.test.ts`
Expected: FAIL — `lookupWord is not a function`（import 报错）

- [ ] **Step 3: 实现**

`lib/translation/llm-client.ts` 第 1 行 import 改为：

```ts
import { buildMessages, buildLookupMessages, parseJsonResponse, parseLookupResponse, parsePlainResponse, type ChatMessage, type WordEntry } from './prompt';
```

文件尾部追加：

```ts
// 词典查询：一次性请求（词条内容短，不做流式）。解析失败返回 null，由调用方报 failed；
// response_format 不支持时沿用翻译链路的 plain 降级。
export async function lookupWord(
  cfg: LlmConfig,
  word: string,
  sentence: string,
  opts: { targetLang: string; useJsonFormat: boolean },
  deps: Deps = {},
): Promise<WordEntry | null> {
  let mode = opts.useJsonFormat && cfg.protocol !== 'claude'; // Claude 无 response_format
  let content: string;
  try {
    content = await chatCompletion(cfg, buildLookupMessages(word, sentence, opts.targetLang), mode, deps);
  } catch (e) {
    if (e instanceof FormatUnsupportedError) {
      mode = false;
      content = await chatCompletion(cfg, buildLookupMessages(word, sentence, opts.targetLang), false, deps);
    } else {
      throw e;
    }
  }
  return parseLookupResponse(content);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/llm-client.test.ts`
Expected: PASS（原有用例 + 4 个新用例全绿）

- [ ] **Step 5: Commit**

```bash
git add lib/translation/llm-client.ts tests/llm-client.test.ts
git commit -m "feat: llm-client 新增 lookupWord 词典查询"
```

---

### Task 4: 协议类型与调度（protocol.ts + scheduler.ts）

**Files:**
- Modify: `lib/messaging/protocol.ts`（顶部加 import + 尾部追加类型）
- Modify: `lib/translation/scheduler.ts`（import 行、`SchedulerDeps` 接口、文件尾部追加）
- Test: `tests/scheduler.test.ts`（import 行、makeDeps、文件尾部追加 describe）

**Interfaces:**
- Consumes: Task 2 `WordEntry`；Task 3 `lookupWord`
- Produces（Task 5/7 消费）:
  - `interface LookupRequest { kind: 'lookup'; taskId: string; word: string; sentence: string; targetLang?: string }`
  - `type LookupResponse = { kind: 'lookup-result'; taskId: string; entry: WordEntry } | { kind: 'error'; taskId: string; code: 'auth' | 'failed'; message: string }`
  - `handleLookupRequest(req: LookupRequest, deps: SchedulerDeps): Promise<LookupResponse>`
  - `SchedulerDeps` 新增字段 `lookup: typeof lookupWord`

- [ ] **Step 1: 写失败测试**

`tests/scheduler.test.ts` 第 2-3 行 import 改为：

```ts
import { handleTranslateRequest, handleLookupRequest, type SchedulerDeps } from '../lib/translation/scheduler';
import type { TranslateRequest, LookupRequest } from '../lib/messaging/protocol';
```

新增第 4 行：

```ts
import { AuthError } from '../lib/translation/llm-client';
```

`makeDeps` 返回对象中（`jsonFormatSupported` 之前）加一行：

```ts
    lookup: vi.fn(async () => ({ word: 'raise', senses: [], related: [], contextual: 'x' })),
```

文件尾部追加：

```ts
const LOOKUP_REQ: LookupRequest = { kind: 'lookup', taskId: 'sel-1', word: 'raise', sentence: 'Please raise your hand.' };

describe('handleLookupRequest', () => {
  it('正常路径：返回 lookup-result，word 为空时回填请求词', async () => {
    const deps = makeDeps();
    (deps.lookup as any).mockResolvedValue({ word: '', senses: [{ pos: 'v.', meaning: '举起' }], related: [], contextual: '本句指举起手' });
    const r = await handleLookupRequest(LOOKUP_REQ, deps);
    expect(r.kind).toBe('lookup-result');
    if (r.kind === 'lookup-result') {
      expect(r.entry.word).toBe('raise');
      expect(r.entry.contextual).toBe('本句指举起手');
    }
  });

  it('解析失败（null）返回 failed 错误', async () => {
    const deps = makeDeps();
    (deps.lookup as any).mockResolvedValue(null);
    const r = await handleLookupRequest(LOOKUP_REQ, deps);
    expect(r).toEqual({ kind: 'error', taskId: 'sel-1', code: 'failed', message: '词典响应解析失败，请重试' });
  });

  it('AuthError 返回 auth 错误', async () => {
    const deps = makeDeps();
    (deps.lookup as any).mockRejectedValue(new AuthError('LLM auth failed: 401'));
    const r = await handleLookupRequest(LOOKUP_REQ, deps);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.code).toBe('auth');
  });

  it('未配置供应商返回 auth 错误', async () => {
    const deps = makeDeps();
    (deps.getSettings as any).mockResolvedValue({
      providers: [], activeProviderId: '', sourceLang: 'auto', systemPrompt: 'SYS',
      targetLang: '中文', blacklist: [], disabledSites: [], minLength: 20,
      cjkRatioThreshold: 0.3, selectionTranslate: true, baseUrl: '', apiKey: '', model: '',
    });
    const r = await handleLookupRequest(LOOKUP_REQ, deps);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.code).toBe('auth');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: FAIL — `handleLookupRequest is not exported`

- [ ] **Step 3a: protocol.ts 追加类型**

`lib/messaging/protocol.ts` 第 1 行前插入：

```ts
import type { WordEntry } from '../translation/prompt';

```

文件尾部追加：

```ts
/** content → background（port 消息）：单词/短词组词典查询 */
export interface LookupRequest {
  kind: 'lookup';
  taskId: string;
  word: string;
  /** 单词所在句子（语境解释用） */
  sentence: string;
  /** 逐请求目标语言覆盖（划词双语向）；缺省用 settings.targetLang */
  targetLang?: string;
}

export type LookupResponse =
  | { kind: 'lookup-result'; taskId: string; entry: WordEntry }
  | { kind: 'error'; taskId: string; code: 'auth' | 'failed'; message: string };
```

- [ ] **Step 3b: scheduler.ts 追加 handleLookupRequest**

`lib/translation/scheduler.ts` 第 1-2 行 import 改为：

```ts
import type { TranslateRequest, TranslateResponse, LookupRequest, LookupResponse } from '../messaging/protocol';
import { translateUnits, lookupWord, AuthError, type LlmConfig } from './llm-client';
```

`SchedulerDeps` 接口中（`translate` 一行之后）加：

```ts
  lookup: typeof lookupWord;
```

文件尾部追加：

```ts
export async function handleLookupRequest(
  req: LookupRequest,
  deps: SchedulerDeps,
): Promise<LookupResponse> {
  const settings = await deps.getSettings();
  const provider = getActiveProvider(settings);
  if (!provider) {
    return { kind: 'error', taskId: req.taskId, code: 'auth', message: '尚未配置 API 供应商，请前往设置页添加' };
  }
  const cfg: LlmConfig = { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: resolveModel(provider), protocol: provider.protocol };
  try {
    const entry = await deps.lookup(cfg, req.word, req.sentence, {
      targetLang: req.targetLang ?? settings.targetLang,
      useJsonFormat: deps.jsonFormatSupported.value,
    });
    if (!entry) return { kind: 'error', taskId: req.taskId, code: 'failed', message: '词典响应解析失败，请重试' };
    if (entry.word === '') entry.word = req.word;
    return { kind: 'lookup-result', taskId: req.taskId, entry };
  } catch (e) {
    if (e instanceof AuthError) {
      return { kind: 'error', taskId: req.taskId, code: 'auth', message: 'API Key 无效或权限不足，请检查设置页' };
    }
    return { kind: 'error', taskId: req.taskId, code: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: PASS（原有用例 + 4 个新用例全绿）

- [ ] **Step 5: Commit**

```bash
git add lib/messaging/protocol.ts lib/translation/scheduler.ts tests/scheduler.test.ts
git commit -m "feat: lookup 消息协议与 handleLookupRequest 调度"
```

---

### Task 5: background 端口分发（entrypoints/background.ts）

**Files:**
- Modify: `entrypoints/background.ts:1-5`（import）与 `:60-61`（port 消息入口）

**Interfaces:**
- Consumes: Task 4 的 `LookupRequest` / `LookupResponse` / `handleLookupRequest`；Task 3 的 `lookupWord`
- Produces: port `translate` 上按 `msg.kind` 分发 `'lookup'` 与 `'translate'`

本任务无可单测的纯逻辑（chrome port 接线），验证靠 typecheck + 全量测试。

- [ ] **Step 1: 修改 import 行**

`entrypoints/background.ts` 第 1-5 行改为：

```ts
import { handleTranslateRequest, handleLookupRequest } from '../lib/translation/scheduler';
import { translateUnits, lookupWord } from '../lib/translation/llm-client';
import { getCached, setCached } from '../lib/cache/store';
import { getSettings } from '../lib/settings';
import type { StartTabRequest, StartTabResponse, TranslateRequest, TranslateResponse, LookupRequest } from '../lib/messaging/protocol';
```

- [ ] **Step 2: port 消息入口加 lookup 分支**

`port.onMessage.addListener(async (msg: TranslateRequest) => {` 一行改为：

```ts
    port.onMessage.addListener(async (msg: TranslateRequest | LookupRequest) => {
      if (msg.kind === 'lookup') {
        await acquire();
        try {
          const response = await handleLookupRequest(
            msg,
            { translate: translateUnits, lookup: lookupWord, getCached, setCached, getSettings, jsonFormatSupported },
          );
          port.postMessage(response);
        } catch (e) {
          // 与 translate 分支同理：任何意外异常也必须回响应，保证每个请求恰好一个响应
          port.postMessage({
            kind: 'error',
            taskId: msg.taskId,
            code: 'failed',
            message: e instanceof Error ? e.message : String(e),
          });
        } finally {
          release();
        }
        return;
      }
```

（原有 `if (msg.kind !== 'translate') return;` 及其后代码保持不变，注意原有行首缩进不变。）

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: 均无错误、全绿

- [ ] **Step 4: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat: background 端口分发 lookup 词典查询"
```

---

### Task 6: 词典卡片 UI（lib/renderer/selection.ts）

**Files:**
- Modify: `lib/renderer/selection.ts`
- Test: `tests/word-card.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `WordEntry`
- Produces（Task 7 消费）:
  - `SelUI.showWordCard(entry: WordEntry): void`（`SelUI` 接口新方法）
  - `formatWordEntryText(entry: WordEntry): string`（导出纯函数，复制按钮用）

- [ ] **Step 1: 写失败测试（formatWordEntryText 纯函数）**

创建 `tests/word-card.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { formatWordEntryText } from '../lib/renderer/selection';

const base = {
  word: 'raise',
  phonetic: '/reɪz/' as string | undefined,
  senses: [{ pos: 'v.', meaning: '举起；提升' }, { pos: 'n.', meaning: '加薪' }],
  related: [{ word: 'lift', note: 'syn. 举起' }, { word: 'lower', note: 'ant. 降低' }],
  contextual: '本句中指举起手',
};

describe('formatWordEntryText', () => {
  it('完整词条：单词+音标+义项+关联词+语境逐行输出', () => {
    const text = formatWordEntryText(base);
    expect(text).toBe([
      'raise /reɪz/',
      'v. 举起；提升',
      'n. 加薪',
      '关联词：lift(syn. 举起)，lower(ant. 降低)',
      '本句中：本句中指举起手',
    ].join('\n'));
  });
  it('无音标/无关联词/无语境时对应行省略', () => {
    const text = formatWordEntryText({ word: 'the', phonetic: undefined, senses: [{ pos: 'art.', meaning: '定冠词' }], related: [], contextual: '' });
    expect(text).toBe(['the', 'art. 定冠词'].join('\n'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/word-card.test.ts`
Expected: FAIL — `formatWordEntryText is not exported`

- [ ] **Step 3: 实现 selection.ts 改动**

共 5 处编辑：

**3a. 文件顶部 import 之后、`SEL_HOST_ATTR` 常量之前，加：**

```ts
import type { WordEntry } from '../translation/prompt';
```

（放在现有 `import { MOTION_CSS, replayPop, setLoading } from './motion';` 之后。）

**3b. `SelUI` 接口中 `appendPanelText` 一行之后加：**

```ts
  /** 词典模式：结构化渲染单词卡片（音标/义项/关联词/语境） */
  showWordCard(entry: WordEntry): void;
```

**3c. `clampPosition` 函数之前（即 `SelUI` 接口结束后）加导出纯函数：**

```ts
/** 词典卡片的复制纯文本：单词+音标+义项+关联词+语境逐行 */
export function formatWordEntryText(entry: WordEntry): string {
  const lines: string[] = [];
  lines.push(entry.phonetic ? `${entry.word} ${entry.phonetic}` : entry.word);
  for (const s of entry.senses) lines.push(`${s.pos} ${s.meaning}`);
  if (entry.related.length > 0) lines.push(`关联词：${entry.related.map(r => `${r.word}(${r.note})`).join('，')}`);
  if (entry.contextual !== '') lines.push(`本句中：${entry.contextual}`);
  return lines.join('\n');
}
```

**3d. SHADOW_CSS 中：**
- `.panel {` 的 `width: 300px;` 改为 `width: 340px;`
- `.body button[data-sel-retry] { ... }` 规则之后、`.footer {` 之前，追加：

```css
.word-head { display: flex; align-items: baseline; gap: 8px; padding-bottom: 4px; }
.word-head .w { font-size: 18px; font-weight: 700; }
.word-head .phonetic { color: #999; font-size: 12.5px; }
.word-section { padding: 4px 0; }
.word-section + .word-section { border-top: 1px solid #f0f0f0; }
.sec-title { font-size: 11.5px; color: #999; margin-bottom: 2px; }
.sense { display: flex; gap: 6px; }
.sense .pos { color: #e91e63; font-style: italic; min-width: 32px; }
.related-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { background: #f4f4f6; border-radius: 10px; padding: 1px 8px; font-size: 12px; }
.contextual { background: #faf6f8; border-radius: 8px; padding: 6px 8px; }
```

- 暗色媒体查询块内（`.header, .footer { border-color: #383c44; }` 之后）追加：

```css
  .word-section + .word-section { border-color: #383c44; }
  .chip { background: #33373f; }
  .contextual { background: #2b2f38; }
```

**3e. `createSelectionUI` 函数体内：**
- `let lastText = '';` 一行之后加：

```ts
  let speakText = ''; // 词典卡片朗读单词本身；为空则朗读 lastText
```

- speak 按钮监听（`panel.querySelector('.speak')!.addEventListener('click', () => cbs.onSpeak(lastText));`）改为：

```ts
  panel.querySelector('.speak')!.addEventListener('click', () => cbs.onSpeak(speakText || lastText));
```

- `hidePanel` 函数中 `lastText = '';` 一行之后加：

```ts
    speakText = '';
```

- `setPanelState` 函数体最前（`streaming = false;` 之后）加：

```ts
    speakText = '';
```

- 返回对象的 `appendPanelText(text) { ... },` 之后加 `showWordCard` 实现：

```ts
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
```

注意：`showWordCard` 定义在返回对象字面量内部，`formatWordEntryText` 在模块作用域，可直接引用；`toggleScrollable` 是闭包内已有函数，需在它定义之后使用（返回对象在文件尾部，满足）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/word-card.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `npm run typecheck && npm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add lib/renderer/selection.ts tests/word-card.test.ts
git commit -m "feat: 划词浮窗新增词典卡片渲染 showWordCard"
```

---

### Task 7: content 端接线（entrypoints/content.ts）

**Files:**
- Modify: `entrypoints/content.ts`（import、状态变量、`postToPort`、`connectPort` 监听类型、`onChunkResponse`、`onSelDotClick`、`onRetry`、`selectionchange`）

**Interfaces:**
- Consumes: Task 1 `isWordLike`/`extractSentence`；Task 4 `LookupRequest`/`LookupResponse`；Task 6 `showWordCard`
- Produces: 完整功能链路（点击圆钮 → 词典卡片）

本任务为既有函数的多处小编辑，无新纯函数，验证靠 typecheck + 全量测试 + 构建。

- [ ] **Step 1: import 与状态变量**

第 1-3 行 import 区域加一行（放在 `import { siteRuleFor } ...` 之后）：

```ts
import { isWordLike, extractSentence } from '../lib/extraction/word';
```

第 6 行改为：

```ts
import type { TranslateRequest, TranslateResponse, LookupRequest, LookupResponse } from '../lib/messaging/protocol';
```

第 48 行（`let selReq: TranslateRequest | null = null; // 最后一次划词请求，供重试重发`）之后加两行：

```ts
let lookupReq: LookupRequest | null = null; // 最后一次词典查询请求，供重试重发
let selText = ''; // 当前面板对应的选中文本（判断选区是否变化）
```

- [ ] **Step 2: postToPort 放宽类型**

`function postToPort(req: TranslateRequest): void {` 与下一行改为：

```ts
function postToPort(req: TranslateRequest | LookupRequest): void {
  if (req.kind === 'translate') resetChunkBuffers(req);
```

（`resetChunkBuffers` 访问 `req.units`，lookup 请求无此字段，必须跳过。）

- [ ] **Step 3: connectPort 监听类型**

`p.onMessage.addListener((msg: TranslateResponse) => onChunkResponse(msg));` 改为：

```ts
  p.onMessage.addListener((msg: TranslateResponse | LookupResponse) => onChunkResponse(msg));
```

- [ ] **Step 4: onChunkResponse 加 lookup 路由**

`function onChunkResponse(msg: TranslateResponse): void {` 及其开头改为：

```ts
function onChunkResponse(msg: TranslateResponse | LookupResponse): void {
  if (msg.kind === 'lookup-result') {
    if (!lookupReq || msg.taskId !== lookupReq.taskId) return; // 陈旧响应：忽略
    if (selTimer !== null) { clearTimeout(selTimer); selTimer = null; }
    selUI?.showWordCard(msg.entry);
    return;
  }
  if (msg.kind === 'delta') {
    // 划词的 delta 归面板，整页的归 host
    if (msg.taskId.startsWith('sel-')) onSelDelta(msg);
    else onChunkDelta(msg);
    return;
  }
  // lookup 的错误响应没有 chunkId 字段，以此与 translate 错误区分
  if (!('chunkId' in msg)) {
    if (!lookupReq || msg.taskId !== lookupReq.taskId) return; // 陈旧响应：忽略
    if (selTimer !== null) { clearTimeout(selTimer); selTimer = null; }
    selUI?.setPanelState('error', msg.message);
    return;
  }
```

（其后原有 `console.log('[llm-tr] chunk response:'...)` 起的代码保持不变。）

- [ ] **Step 5: onSelDotClick 加词典分支**

整个 `onSelDotClick` 函数替换为：

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
  selText = text;
  const targetLang = cjkRatio(text) > 0.5 ? 'English' : s.targetLang;
  if (isWordLike(text)) {
    const sel = window.getSelection();
    const sentence = sel && sel.rangeCount > 0 ? extractSentence(sel.getRangeAt(0)) : text;
    lookupReq = { kind: 'lookup', taskId: `sel-${Date.now()}`, word: text, sentence, targetLang };
    selReq = null;
    postToPort(lookupReq);
  } else {
    selReq = {
      kind: 'translate',
      taskId: `sel-${Date.now()}`,
      chunkId: 'c0',
      units: [{ paragraphId: 'sel', text, sliceIndex: 0, sliceTotal: 1 }],
      targetLang,
      stream: true,
    };
    lookupReq = null;
    postToPort(selReq);
  }
  armSelTimer();
}
```

- [ ] **Step 6: onRetry 重发当前请求（翻译或词典）**

整个 `onRetry` 回调（含 `if (!selReq) return;` 等原有四行）替换为：

```ts
    onRetry: () => {
      const req = lookupReq ?? selReq;
      if (!req) return;
      selUI?.setPanelState('loading');
      postToPort(req);
      armSelTimer();
    },
```

- [ ] **Step 7: selectionchange 判定改用 selText**

`if (!selUI.isPinned() && text !== selReq?.units[0]?.text) selUI.hidePanel();` 改为：

```ts
    if (!selUI.isPinned() && text !== selText) selUI.hidePanel();
```

- [ ] **Step 8: 类型检查 + 全量测试 + 构建**

Run: `npm run typecheck && npm test && npm run build`
Expected: 全部通过（wxt build 成功产出 `.output`）

- [ ] **Step 9: Commit**

```bash
git add entrypoints/content.ts
git commit -m "feat: 划词选中单词/短词组时走词典卡片通道"
```

---

### Task 8: 端到端人工验证

**Files:** 无代码改动

- [ ] **Step 1: 加载扩展并验证单词场景**

Run: `npm run build`，在 `chrome://extensions` 加载 `.output/chrome-mv3`（或 `npm run dev` 热更）。

验证步骤：
1. 打开任意英文页面，选中单个单词（如 `raise`）→ 点击「译」圆钮 → 浮窗应显示词典卡片：单词+音标、词性义项、关联词 chips、「本句中」语境解释。
2. 选中 2-3 词词组（如 `take care of`）→ 同样出词典卡片。
3. 复制按钮 → 剪贴板为多行纯文本；🔊 按钮朗读单词本身。
4. 卡片模式下点「重试」应重发词典请求。

- [ ] **Step 2: 验证回归场景**

1. 选中整句英文 → 仍走流式翻译（原有行为）。
2. 选中中文词（如 `翻译`）→ 出英文解释的词典卡片（双语向 targetLang 逻辑）。
3. 整页翻译（popup「翻译本页」）→ 不受影响。
4. 断网/错误 API Key → 卡片场景显示错误 + 重试按钮。

发现的问题修复后单独 commit（`fix: ...`），并把修复对应的用例补进最近的测试文件。
