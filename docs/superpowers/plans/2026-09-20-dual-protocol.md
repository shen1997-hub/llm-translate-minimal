# 双协议接入 + CC Switch 导入 + 品牌改名 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 供应商支持 OpenAI/Claude 双协议、设置页可从 CC Switch 的 cc-switch.db 批量导入供应商、扩展改名「极简翻译」。

**Architecture:** `Provider` 加 `protocol` 字段（旧数据惰性迁移默认 openai）；llm-client 按协议分流两个 transport（共用重试/auth 链路，Claude 强制 plain 解析）；CC Switch 导入分两层——纯函数解析层 `lib/import/ccswitch.ts`（可单测）+ sql.js 读取层 `lib/import/ccswitch-db.ts`；设置页加协议下拉与导入 UI；stub server 加 `/v1/messages` 支撑 Claude 协议 E2E。

**Tech Stack:** TypeScript + WXT + Vitest(jsdom) + Playwright + sql.js（唯一新增依赖）。

## Global Constraints

- `verbatimModuleSyntax`（类型导入必须 `import type`）、`noUncheckedIndexedAccess`。
- 新增依赖仅允许 `sql.js`（runtime）与 `@types/sql.js`（dev）；无新 manifest 权限。
- `entrypoints/content.ts` 与 `entrypoints/background.ts` 中带 `// [diag]` 标记的日志**保留不动**。
- Claude transport：`POST {baseUrl}/v1/messages`，headers 必须含 `x-api-key`、`anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`；body 含 `max_tokens: 4096`；Claude 协议强制 plain 模式（不读不写 jsonFormatSupported）。
- 品牌名统一为「极简翻译」（manifest name、popup、options、README）。
- 验证命令：`npm test`、`npm run typecheck`、`npm run build`、`npm run e2e`（E2E 前先 build）。
- 现有基线：100 单测 + 5 E2E 全绿，任何任务不得破坏。

## File Structure

- `lib/settings.ts`（修改）：`ApiProtocol` 类型、`Provider.protocol`、惰性迁移
- `lib/translation/llm-client.ts`（修改）：`LlmConfig.protocol`，拆 openai/claude 两个 transport
- `lib/translation/scheduler.ts`（修改）：cfg 透传 `provider.protocol`
- `lib/import/ccswitch.ts`（新建）：`CcSwitchRow`/`ImportedProvider` 类型 + `parseCcSwitchProviders` 纯函数
- `lib/import/ccswitch-db.ts`（新建）：`readCcSwitchDb`（sql.js 薄层）
- `types/assets.d.ts`（新建）：`*.wasm?url` 模块声明
- `entrypoints/options/index.html` + `main.ts`（修改）：协议下拉、导入按钮/路径提示/候选列表
- `e2e/stub-server.ts`（修改）：`/v1/messages` 端点
- `e2e/fixtures/cc-switch-test.sql` + `.db`（新建）：导入 E2E 夹具
- `e2e/translate.spec.ts`（修改）：BASE_SETTINGS 补 protocol、追加 Claude 协议与导入两条用例
- `wxt.config.ts`、`entrypoints/popup/index.html`、`README.md`（修改）：品牌改名
- `tests/settings.test.ts`、`tests/llm-client.test.ts`、`tests/scheduler.test.ts`（修改）、`tests/ccswitch.test.ts`（新建）

---

### Task 1: settings 加 ApiProtocol 与 Provider.protocol 迁移

**Files:**
- Modify: `lib/settings.ts:1-8`（Provider 接口）、`lib/settings.ts:63-81`（getSettings 迁移）
- Modify: `entrypoints/options/main.ts:11-16`（newProviderDraft）
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export type ApiProtocol = 'openai' | 'claude'`（`lib/settings.ts`）
  - `Provider.protocol: ApiProtocol`（Task 2/3/5 依赖）
  - `getSettings()` 保证返回的每个 provider 都有 `protocol`（旧数据补 `'openai'`）

- [ ] **Step 1: 写失败测试**

`tests/settings.test.ts` 顶部的 `PV` 常量改为（加 protocol 行）：

```ts
const PV: Provider = {
  id: 'pv-1', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-x', models: ['deepseek-chat', 'deepseek-reasoner'], activeModel: 'deepseek-chat',
};
```

在 `describe('默认值与读写')` 内追加：

```ts
  it('旧供应商数据无 protocol 字段时读取补 openai', async () => {
    store.set('settings', {
      providers: [{ id: 'p1', name: 'A', baseUrl: 'https://a.com', apiKey: 'k', models: ['m'], activeModel: 'm' }],
      activeProviderId: 'p1',
    });
    const s = await getSettings();
    expect(s.providers[0]!.protocol).toBe('openai');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL —— TS 报错（Provider 缺 protocol）或断言为 undefined

- [ ] **Step 3: 最小实现**

`lib/settings.ts` Provider 接口前加类型，接口加字段：

```ts
export type ApiProtocol = 'openai' | 'claude';

export interface Provider {
  id: string;
  name: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  models: string[];
  activeModel: string;
}
```

`getSettings` 中旧单配置迁移的 `legacy` 字面量加一行 `protocol: 'openai' as ApiProtocol,`；并在 `const merged: Settings = { ...DEFAULT_SETTINGS, ...stored };` 之后加一行：

```ts
  merged.providers = merged.providers.map(p => ({ protocol: 'openai' as ApiProtocol, ...p }));
```

`entrypoints/options/main.ts` 的 `newProviderDraft` 返回值加一行：

```ts
    protocol: 'openai',
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run tests/settings.test.ts && npm run typecheck`
Expected: PASS。若 typecheck 在其他文件报「缺 protocol」，在该字面量补 `protocol: 'openai'`（不要改逻辑）。

- [ ] **Step 5: 全量单测 + Commit**

Run: `npm test`
Expected: 全绿

```bash
git add lib/settings.ts entrypoints/options/main.ts tests/settings.test.ts
git commit -m "feat: Provider 增加 protocol 字段与旧数据惰性迁移"
```

---

### Task 2: llm-client 双 transport + scheduler 透传

**Files:**
- Modify: `lib/translation/llm-client.ts`（全文件）
- Modify: `lib/translation/scheduler.ts:22`（cfg 一行）
- Test: `tests/llm-client.test.ts`、`tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `ApiProtocol`（Task 1，`lib/settings.ts`）
- Produces:
  - `LlmConfig { baseUrl: string; apiKey: string; model: string; protocol: ApiProtocol }`（protocol 必填）
  - `translateUnits(cfg, texts, opts, deps)` 签名不变；`cfg.protocol === 'claude'` 时强制 plain（返回 `useJsonFormat: false`），请求走 `POST {baseUrl}/v1/messages`

- [ ] **Step 1: 写失败测试**

`tests/llm-client.test.ts` 的 `CFG` 加 protocol：

```ts
const CFG = { baseUrl: 'https://api.test.com', apiKey: 'sk-x', model: 'm1', protocol: 'openai' as const };
```

文件末尾追加：

```ts
const CLAUDE_CFG = { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', model: 'claude-x', protocol: 'claude' as const };

function claudeResponse(text: string, status = 200) {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status });
}

describe('translateUnits（Claude 协议）', () => {
  it('请求走 /v1/messages，三个头与 body 结构正确，响应取 text 块', async () => {
    const fetchImpl = vi.fn(async () => claudeResponse('[0] 甲')) as any;
    const r = await translateUnits(CLAUDE_CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep });
    expect(r.translations).toEqual(['甲']);
    expect(r.useJsonFormat).toBe(false);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers['Authorization']).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toContain('SYS');
    expect(body.messages).toEqual([{ role: 'user', content: '[0] A' }]);
    expect(body.response_format).toBeUndefined();
  });

  it('Claude 协议忽略 useJsonFormat 入参（强制 plain 解析）', async () => {
    const fetchImpl = vi.fn(async () => claudeResponse('[0] 甲\n[1] 乙')) as any;
    const r = await translateUnits(CLAUDE_CFG, ['A', 'B'], { ...OPTS, useJsonFormat: true }, { fetchImpl, sleep: noSleep });
    expect(r.useJsonFormat).toBe(false);
    expect(r.translations).toEqual(['甲', '乙']);
  });

  it('401 抛 AuthError 不重试；429 退避后成功', async () => {
    const f401 = vi.fn(async () => new Response('unauthorized', { status: 401 })) as any;
    await expect(translateUnits(CLAUDE_CFG, ['A'], OPTS, { fetchImpl: f401, sleep: noSleep })).rejects.toBeInstanceOf(AuthError);
    expect(f401).toHaveBeenCalledTimes(1);
    const f429 = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(claudeResponse('[0] 甲')) as any;
    const r = await translateUnits(CLAUDE_CFG, ['A'], OPTS, { fetchImpl: f429, sleep: noSleep });
    expect(r.translations).toEqual(['甲']);
  });

  it('响应无 text 块时按解析失败走逐段补齐', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [] }), { status: 200 }))
      .mockResolvedValueOnce(claudeResponse('[0] 甲'))
      .mockResolvedValueOnce(claudeResponse('[0] 乙')) as any;
    const r = await translateUnits(CLAUDE_CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep });
    expect(r.translations).toEqual(['甲', '乙']);
  });
});
```

`tests/scheduler.test.ts` 的 `makeDeps` 默认 settings 里 provider 字面量加 `protocol: 'openai',`；「使用解析后的供应商与模型」用例的 `call[0]` 断言改为：

```ts
    expect(call[0]).toEqual({ baseUrl: 'https://api.test.com', apiKey: 'sk-x', model: 'm1', protocol: 'openai' });
```

并在 describe 末尾追加：

```ts
  it('cfg 透传供应商 protocol（claude）', async () => {
    const deps = makeDeps({
      getSettings: vi.fn(async () => ({
        providers: [{
          id: 'pv-1', name: 'Claude', protocol: 'claude', baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant', models: ['claude-x'], activeModel: 'claude-x',
        }],
        activeProviderId: 'pv-1', sourceLang: 'auto',
        systemPrompt: 'SYS', targetLang: '中文',
        blacklist: [], disabledSites: [], minLength: 20, cjkRatioThreshold: 0.3,
        baseUrl: '', apiKey: '', model: '',
      })) as any,
    });
    await handleTranslateRequest(REQ, deps);
    expect((deps.translate as any).mock.calls[0][0].protocol).toBe('claude');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/llm-client.test.ts tests/scheduler.test.ts`
Expected: FAIL —— `LlmConfig` 无 protocol、claude 用例全部失败

- [ ] **Step 3: 实现**

`lib/translation/llm-client.ts` 改为（完整文件）：

```ts
import { buildMessages, parseJsonResponse, parsePlainResponse, type ChatMessage } from './prompt';
import type { ApiProtocol } from '../settings';

export interface LlmConfig { baseUrl: string; apiKey: string; model: string; protocol: ApiProtocol }

export class AuthError extends Error {}
export class FormatUnsupportedError extends Error {}

interface Deps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }

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

async function openaiChat(cfg: LlmConfig, messages: ChatMessage[], useJsonFormat: boolean, deps: Deps): Promise<string> {
  const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0.3 };
  if (useJsonFormat) body.response_format = { type: 'json_object' };
  const res = await requestWithRetry(
    (f) => f(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    }),
    deps,
  );
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && useJsonFormat && /response_format/i.test(text)) throw new FormatUnsupportedError(text);
    throw new Error(`LLM request failed: ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.choices[0].message.content as string;
}

async function claudeChat(cfg: LlmConfig, messages: ChatMessage[], deps: Deps): Promise<string> {
  const system = messages.find(m => m.role === 'system')?.content ?? '';
  const user = messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
  const body = {
    model: cfg.model, max_tokens: 4096, system,
    messages: [{ role: 'user', content: user }], temperature: 0.3,
  };
  const res = await requestWithRetry(
    (f) => f(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed: ${res.status}: ${text}`);
  }
  const data = await res.json();
  const blocks = data.content as { type?: string; text?: string }[] | undefined;
  // 无 text 块 → 返回空串，让上层按解析失败走逐段补齐
  return blocks?.find(b => b.type === 'text')?.text ?? '';
}

async function chatCompletion(cfg: LlmConfig, messages: ChatMessage[], useJsonFormat: boolean, deps: Deps): Promise<string> {
  return cfg.protocol === 'claude' ? claudeChat(cfg, messages, deps) : openaiChat(cfg, messages, useJsonFormat, deps);
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

export async function translateUnits(
  cfg: LlmConfig,
  texts: string[],
  opts: { targetLang: string; systemPrompt: string; useJsonFormat: boolean; sourceLang?: string },
  deps: Deps = {},
): Promise<{ translations: (string | null)[]; useJsonFormat: boolean }> {
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

注意：原 `chatCompletion` 里「500 重试耗尽后抛 `LLM request failed: {status}`」的行为改由「4xx/5xx 非退避响应返回给调用方读 body 抛错」表达，`tests/llm-client.test.ts` 既有用例「持续 500 重试 3 次后抛错」断言 `rejects.toThrow(/500/)` 与新错误消息 `LLM request failed: 500: server error` 兼容。

`lib/translation/scheduler.ts` 的 cfg 行改为：

```ts
  const cfg: LlmConfig = { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: resolveModel(provider), protocol: provider.protocol };
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run tests/llm-client.test.ts tests/scheduler.test.ts && npm run typecheck`
Expected: PASS。`noUncheckedIndexedAccess` 下 `data.choices[0]` 保持原样写法即可（data 为 any）。

- [ ] **Step 5: 全量单测 + Commit**

Run: `npm test`
Expected: 全绿

```bash
git add lib/translation/llm-client.ts lib/translation/scheduler.ts tests/llm-client.test.ts tests/scheduler.test.ts
git commit -m "feat: llm-client 拆 OpenAI/Claude 双 transport，scheduler 透传 protocol"
```

---

### Task 3: CC Switch 解析纯函数 parseCcSwitchProviders

**Files:**
- Create: `lib/import/ccswitch.ts`
- Test: `tests/ccswitch.test.ts`（新建）

**Interfaces:**
- Consumes: `ApiProtocol`（Task 1）
- Produces（Task 4/5 依赖，签名逐字）:

```ts
export interface CcSwitchRow { id: string; app_type: string; name: string; settings_config: string; is_current: number }
export interface ImportedProvider {
  name: string; protocol: ApiProtocol; baseUrl: string; apiKey: string;
  models: string[]; activeModel: string; isCurrent: boolean;
}
export function parseCcSwitchProviders(rows: CcSwitchRow[]): ImportedProvider[];
```

- [ ] **Step 1: 写失败测试（新建 tests/ccswitch.test.ts）**

```ts
import { describe, it, expect } from 'vitest';
import { parseCcSwitchProviders } from '../lib/import/ccswitch';
import type { CcSwitchRow } from '../lib/import/ccswitch';

const claudeRow: CcSwitchRow = {
  id: 'abc-1', app_type: 'claude', name: 'DeepSeek', is_current: 1,
  settings_config: JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-claude',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic/',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-v4.1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'deepseek-v4.1',
    },
  }),
};

const codexRow: CcSwitchRow = {
  id: 'def-2', app_type: 'codex', name: '火山', is_current: 0,
  settings_config: JSON.stringify({
    auth: { OPENAI_API_KEY: 'sk-openai', auth_mode: 'apikey' },
    config: 'model_provider = "custom"\nmodel = "glm-5.3"\n\n[model_providers.custom]\nbase_url = "https://ark.example.com/api/coding"\n',
  }),
};

describe('parseCcSwitchProviders', () => {
  it('claude 行：env 映射、baseUrl 去尾斜杠、模型名去重、isCurrent 透传', () => {
    const r = parseCcSwitchProviders([claudeRow]);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      name: 'DeepSeek', protocol: 'claude',
      baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-claude',
      models: ['deepseek-v4.1', 'deepseek-v4-flash'], activeModel: 'deepseek-v4.1',
      isCurrent: true,
    });
  });

  it('codex 行：auth 取 Key、TOML 提取 model 与 base_url，协议 openai', () => {
    const r = parseCcSwitchProviders([codexRow]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      name: '火山', protocol: 'openai',
      baseUrl: 'https://ark.example.com/api/coding', apiKey: 'sk-openai',
      models: ['glm-5.3'], activeModel: 'glm-5.3', isCurrent: false,
    });
  });

  it('claude 行缺 ANTHROPIC_BASE_URL 时回退官方地址；模型兜底 ANTHROPIC_MODEL', () => {
    const row: CcSwitchRow = {
      id: 'x', app_type: 'claude', name: 'A', is_current: 0,
      settings_config: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_MODEL: 'claude-sonnet-4' } }),
    };
    const r = parseCcSwitchProviders([row]);
    expect(r[0]!.baseUrl).toBe('https://api.anthropic.com');
    expect(r[0]!.models).toEqual(['claude-sonnet-4']);
  });

  it('跳过：official 行、无 Key 行、codex 缺 base_url 行、非法 JSON 行、未知 app_type', () => {
    const rows: CcSwitchRow[] = [
      { id: 'codex-official', app_type: 'codex', name: 'OpenAI Official', settings_config: '{"auth":{},"config":""}', is_current: 0 },
      { id: 'no-key', app_type: 'claude', name: 'NoKey', settings_config: '{"env":{}}', is_current: 0 },
      { id: 'no-url', app_type: 'codex', name: 'NoUrl', settings_config: '{"auth":{"OPENAI_API_KEY":"k"},"config":"model = \\"m\\""}', is_current: 0 },
      { id: 'bad', app_type: 'claude', name: 'Bad', settings_config: 'not-json', is_current: 0 },
      { id: 'g', app_type: 'gemini', name: 'G', settings_config: '{"env":{}}', is_current: 0 },
    ];
    expect(parseCcSwitchProviders(rows)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ccswitch.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 lib/import/ccswitch.ts（完整文件）**

```ts
import type { ApiProtocol } from '../settings';

export interface CcSwitchRow {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
  is_current: number;
}

export interface ImportedProvider {
  name: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  models: string[];
  activeModel: string;
  isCurrent: boolean;
}

const CLAUDE_MODEL_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
] as const;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function mapClaudeRow(row: CcSwitchRow, cfg: Record<string, unknown>): ImportedProvider | null {
  const env = (cfg.env ?? {}) as Record<string, string | undefined>;
  const apiKey = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) return null;
  const baseUrl = stripTrailingSlash(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com');
  const models: string[] = [];
  const push = (v: string | undefined) => { if (v && !models.includes(v)) models.push(v); };
  for (const k of CLAUDE_MODEL_KEYS) push(env[k]);
  push(env.ANTHROPIC_MODEL);
  return {
    name: row.name, protocol: 'claude', baseUrl, apiKey,
    models, activeModel: models[0] ?? '', isCurrent: row.is_current === 1,
  };
}

function mapCodexRow(row: CcSwitchRow, cfg: Record<string, unknown>): ImportedProvider | null {
  const auth = (cfg.auth ?? {}) as Record<string, string | undefined>;
  const apiKey = auth.OPENAI_API_KEY ?? '';
  const toml = typeof cfg.config === 'string' ? cfg.config : '';
  const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? '';
  const baseUrl = stripTrailingSlash(/^\s*base_url\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? '');
  if (!apiKey || !baseUrl) return null; // 无地址无法构造请求，跳过
  const models = model ? [model] : [];
  return {
    name: row.name, protocol: 'openai', baseUrl, apiKey,
    models, activeModel: models[0] ?? '', isCurrent: row.is_current === 1,
  };
}

export function parseCcSwitchProviders(rows: CcSwitchRow[]): ImportedProvider[] {
  const out: ImportedProvider[] = [];
  for (const row of rows) {
    if (row.id.endsWith('-official')) continue;
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(row.settings_config) as Record<string, unknown>;
    } catch {
      continue;
    }
    const mapped = row.app_type === 'claude' ? mapClaudeRow(row, cfg)
      : row.app_type === 'codex' ? mapCodexRow(row, cfg)
      : null;
    if (mapped) out.push(mapped);
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run tests/ccswitch.test.ts && npm run typecheck`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add lib/import/ccswitch.ts tests/ccswitch.test.ts
git commit -m "feat: CC Switch providers 表解析纯函数（claude/codex 映射）"
```

---

### Task 4: sql.js 读取层 + 依赖 + E2E 夹具

**Files:**
- Create: `lib/import/ccswitch-db.ts`
- Create: `types/assets.d.ts`
- Create: `e2e/fixtures/cc-switch-test.sql`、`e2e/fixtures/cc-switch-test.db`（由 sql 生成）
- Modify: `package.json`（npm install 产生）

**Interfaces:**
- Consumes: `CcSwitchRow`（Task 3）
- Produces: `export function readCcSwitchDb(buf: ArrayBuffer): Promise<CcSwitchRow[]>`（Task 5 依赖）

- [ ] **Step 1: 安装依赖**

Run: `npm install sql.js && npm install -D @types/sql.js`
Expected: package.json dependencies 出现 `sql.js`（^1.x），devDependencies 出现 `@types/sql.js`

- [ ] **Step 2: wasm 模块类型声明（新建 types/assets.d.ts）**

```ts
declare module '*.wasm?url' {
  const src: string;
  export default src;
}
```

- [ ] **Step 3: 实现 lib/import/ccswitch-db.ts（完整文件）**

```ts
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { CcSwitchRow } from './ccswitch';

export async function readCcSwitchDb(buf: ArrayBuffer): Promise<CcSwitchRow[]> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  let db: InstanceType<typeof SQL.Database>;
  try {
    db = new SQL.Database(new Uint8Array(buf));
  } catch {
    throw new Error('不是有效的 CC Switch 数据库（SQLite）文件');
  }
  try {
    const res = db.exec(
      "SELECT id, app_type, name, settings_config, is_current FROM providers WHERE app_type IN ('claude','codex')",
    );
    const table = res[0];
    if (!table) return [];
    return table.values.map(v => ({
      id: String(v[0]), app_type: String(v[1]), name: String(v[2]),
      settings_config: String(v[3]), is_current: Number(v[4]),
    }));
  } catch {
    throw new Error('数据库中未找到 providers 表');
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: 生成 E2E 夹具数据库**

新建 `e2e/fixtures/cc-switch-test.sql`：

```sql
CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER);
INSERT INTO providers VALUES
  ('test-claude-1','claude','TestClaude','{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test-claude","ANTHROPIC_BASE_URL":"http://127.0.0.1:4789/anthropic","ANTHROPIC_DEFAULT_OPUS_MODEL_NAME":"claude-test-model"}}',1),
  ('test-codex-1','codex','TestOpenAI','{"auth":{"OPENAI_API_KEY":"sk-test-openai"},"config":"model = \"gpt-test\"\nbase_url = \"http://127.0.0.1:4789\""}',0),
  ('codex-official','codex','OpenAI Official','{"auth":{},"config":""}',0);
```

Run: `sqlite3 e2e/fixtures/cc-switch-test.db < e2e/fixtures/cc-switch-test.sql`
Expected: 无输出；`sqlite3 e2e/fixtures/cc-switch-test.db "SELECT count(*) FROM providers;"` 输出 3
（本机 sqlite3 在 PATH 中；若不可用则用 `node -e` 配合 sql.js 生成等价 db 文件）

- [ ] **Step 5: typecheck + build，确认 wasm 打进产物**

Run: `npm run typecheck && npm run build && ls .output/chrome-mv3/assets/ | grep -i wasm`
Expected: typecheck 无错误；build 成功；grep 列出一个 `sql-wasm-*.wasm` 资产文件（若 grep 无结果，说明 `?url` 资产未被正确打包，必须先解决再继续）

- [ ] **Step 6: 全量单测 + Commit**

Run: `npm test`
Expected: 全绿（本任务无新单测，回归确认）

```bash
git add package.json package-lock.json types/assets.d.ts lib/import/ccswitch-db.ts e2e/fixtures/cc-switch-test.sql e2e/fixtures/cc-switch-test.db
git commit -m "feat: sql.js 读取 cc-switch.db 薄层与 E2E 夹具库"
```

---

### Task 5: 设置页协议下拉 + CC Switch 导入 UI

**Files:**
- Modify: `entrypoints/options/index.html`（API 供应商卡片 + CSS）
- Modify: `entrypoints/options/main.ts`（buildForm 协议下拉、buildRow 协议标签、导入逻辑）

**Interfaces:**
- Consumes: `ApiProtocol`（Task 1）、`parseCcSwitchProviders` / `ImportedProvider`（Task 3）、`readCcSwitchDb`（Task 4）
- Produces: 页面上供 E2E 断言的元素：`#import-ccswitch` 按钮、`#ccswitch-file`（hidden file input）、`#import-list .import-row` 候选行、`#import-list button[data-act="import"]` 导入按钮

本任务无新单测（UI 集成），验证靠 typecheck + build；行为由 Task 6 的 E2E 守护。

- [ ] **Step 1: index.html 修改**

「API 供应商」卡片内、`<button id="add-provider">` 之后加：

```html
      <button id="import-ccswitch">从 CC Switch 导入</button>
      <div class="hint">CC Switch 数据库默认位于：Windows C:\Users\&lt;用户名&gt;\.cc-switch\cc-switch.db；macOS / Linux ~/.cc-switch/cc-switch.db</div>
      <input type="file" id="ccswitch-file" accept=".db" hidden>
      <div id="import-list"></div>
```

CSS 区（`#add-provider:hover` 规则之后）加：

```css
  #import-ccswitch { width: 100%; margin-top: 8px; padding: 9px; border: 1px dashed #ccd1d9; border-radius: 8px; background: none; color: var(--text-secondary); font-size: 13.5px; cursor: pointer; }
  #import-ccswitch:hover { border-color: var(--primary); color: var(--primary); }
  .hint { font-size: 12px; color: var(--text-secondary); margin-top: 6px; line-height: 1.5; }
  .import-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid var(--border); font-weight: 400; }
  .import-row input[type="checkbox"] { width: auto; margin: 0; flex: none; }
  #import-list .btn-primary { margin-top: 10px; }
  #import-list .form-error { padding: 8px 0; }
```

- [ ] **Step 2: main.ts 修改**

导入区加：

```ts
import { readCcSwitchDb } from '../../lib/import/ccswitch-db';
import { parseCcSwitchProviders } from '../../lib/import/ccswitch';
import type { ImportedProvider } from '../../lib/import/ccswitch';
import type { ApiProtocol } from '../../lib/settings';
```

`buildRow` 中 pv-sub 赋值改为：

```ts
  row.querySelector('.pv-sub')!.textContent = `[${p.protocol === 'claude' ? 'Claude' : 'OpenAI'}] ${resolveModelLabel(p)} · ${p.baseUrl}`;
```

`buildForm` 的 `form.innerHTML` 模板中，在「名称」label **之前**插入协议下拉：

```html
    <label>协议 <select data-f="protocol">
      <option value="openai">OpenAI 兼容</option>
      <option value="claude">Claude</option>
    </select></label>
```

`buildForm` 内 `val('name').value = p.name;` 之前加：

```ts
  const protoSel = form.querySelector<HTMLSelectElement>('[data-f="protocol"]')!;
  protoSel.value = p.protocol;
  const syncPlaceholder = () => {
    val('baseUrl').placeholder = protoSel.value === 'claude' ? 'https://api.anthropic.com' : 'https://api.deepseek.com';
  };
  protoSel.addEventListener('change', syncPlaceholder);
  syncPlaceholder();
```

save 处理器中 `await saveProvider({...})` 的对象加一行：

```ts
      protocol: protoSel.value as ApiProtocol,
```

文件末尾（`void loadGlobals()...` 之前）加导入逻辑：

```ts
async function renderImportCandidates(cands: ImportedProvider[]): Promise<void> {
  const s = await getSettings();
  const box = $('import-list');
  box.innerHTML = '';
  if (cands.length === 0) {
    const d = document.createElement('div');
    d.className = 'empty-hint';
    d.textContent = '未在数据库中找到可导入的供应商';
    box.appendChild(d);
    return;
  }
  for (const [i, c] of cands.entries()) {
    const exists = s.providers.some(p => p.baseUrl === c.baseUrl && p.apiKey === c.apiKey);
    const row = document.createElement('label');
    row.className = 'import-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !exists;
    cb.disabled = exists;
    cb.dataset.idx = String(i);
    const text = document.createElement('span');
    text.textContent = `${c.name} · ${c.protocol === 'claude' ? 'Claude' : 'OpenAI'} · ${c.baseUrl}`
      + `${exists ? '（已存在）' : ''}${c.isCurrent ? '（CC Switch 当前）' : ''}`;
    row.append(cb, text);
    box.appendChild(row);
  }
  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.dataset.act = 'import';
  btn.textContent = '导入所选';
  btn.addEventListener('click', async () => {
    const checked = [...box.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')];
    let activeId = '';
    for (const el of checked) {
      const c = cands[Number(el.dataset.idx)]!;
      const id = `pv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await saveProvider({
        id, name: c.name, protocol: c.protocol, baseUrl: c.baseUrl,
        apiKey: c.apiKey, models: c.models, activeModel: c.activeModel,
      });
      if (c.isCurrent) activeId = id;
    }
    if (activeId) await setActiveProvider(activeId);
    box.innerHTML = '';
    await renderProviders();
  });
  box.appendChild(btn);
}

$('import-ccswitch').addEventListener('click', () => $('ccswitch-file').click());
$('ccswitch-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const box = $('import-list');
  try {
    const rows = await readCcSwitchDb(await file.arrayBuffer());
    await renderImportCandidates(parseCcSwitchProviders(rows));
  } catch (err) {
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'form-error';
    d.textContent = err instanceof Error ? err.message : String(err);
    box.appendChild(d);
  }
});
```

- [ ] **Step 3: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 均通过

- [ ] **Step 4: 全量单测（回归）+ Commit**

Run: `npm test`
Expected: 全绿

```bash
git add entrypoints/options/index.html entrypoints/options/main.ts
git commit -m "feat: 设置页协议下拉与 CC Switch 导入 UI"
```

---

### Task 6: 品牌改名 + stub /v1/messages + E2E + 全量回归

**Files:**
- Modify: `wxt.config.ts:5`（manifest name）
- Modify: `entrypoints/popup/index.html:2,91`（title 与 .title）
- Modify: `entrypoints/options/index.html:3,50`（title 与 h1）
- Modify: `README.md`（标题与首段）
- Modify: `e2e/stub-server.ts:55-73`（/v1/messages 分支）
- Modify: `e2e/translate.spec.ts:8-21`（BASE_SETTINGS 补 protocol）、文件末尾追加两条用例

**Interfaces:**
- Consumes: Task 5 的 `#ccswitch-file` / `#import-list .import-row` / `button[data-act="import"]`；`e2e/fixtures/cc-switch-test.db`（Task 4）
- Produces: 无（特性收尾）

- [ ] **Step 1: 品牌改名**

- `wxt.config.ts`：`name: 'LLM Translate'` → `name: '极简翻译',`
- `entrypoints/popup/index.html`：`<html lang="zh-CN">` 不变；`<div class="title">LLM Translate</div>` → `<div class="title">极简翻译</div>`（无 `<title>` 标签则只改这处）
- `entrypoints/options/index.html`：`<title>LLM Translate 设置</title>` → `<title>极简翻译 设置</title>`；`<h1>LLM Translate 设置</h1>` → `<h1>极简翻译 设置</h1>`
- `README.md`：标题 `# LLM Translate` → `# 极简翻译（Minimal Translate）`；正文中「LLM Translate」提及处同步替换为「极简翻译」

- [ ] **Step 2: stub server 加 /v1/messages**

`e2e/stub-server.ts` 中把 `/chat/completions` 分支的路径判断与响应逻辑改为（Claude 走 plain 文本 `[i] 译文i`，OpenAI 走 JSON）：

```ts
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
```

（`collectIndices` 对两种 body 都适用：Claude 与 OpenAI 的 user 消息结构相同。）

- [ ] **Step 3: e2e/translate.spec.ts 修改**

`BASE_SETTINGS` 的 providers[0] 字面量加一行 `protocol: 'openai',`。文件末尾追加两条用例：

```ts
test('Claude 协议供应商：全文翻译走 /v1/messages', async ({ context, extensionId }) => {
  await seedSettings(context, extensionId, {
    providers: [{
      id: 'pv-claude', name: 'Claude', protocol: 'claude', baseUrl: STUB_ORIGIN,
      apiKey: 'sk-ant', models: ['claude-x'], activeModel: 'claude-x',
    }],
    activeProviderId: 'pv-claude',
  });
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await sendToTestPage(driver, { kind: 'start' });

  const hosts = page.locator(HOST);
  await expect(hosts).toHaveCount(2, { timeout: 15_000 });
  await expect(hosts.first()).toContainText('译文', { timeout: 15_000 });
  await expect(hosts.nth(1)).toContainText('译文');
});

test('设置页从 CC Switch 数据库导入供应商', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await page.setInputFiles('#ccswitch-file', 'e2e/fixtures/cc-switch-test.db');
  const rows = page.locator('#import-list .import-row');
  // official 行被跳过：只剩 claude + codex 两条
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(rows.first()).toContainText('TestClaude');
  await expect(rows.first()).toContainText('Claude');

  await page.locator('#import-list button[data-act="import"]').click();
  // seed 的 Stub 供应商 + 导入的 2 个 = 3 行；is_current=1 的 TestClaude 被设为当前
  const pvRows = page.locator('.pv-row');
  await expect(pvRows).toHaveCount(3);
  await expect(pvRows.nth(1)).toContainText('TestClaude');
  await expect(pvRows.nth(1)).toContainText('当前');
  await page.close();
});
```

- [ ] **Step 4: build + E2E**

Run: `npm run build && npm run e2e`
Expected: 7 条 E2E 全绿（旧 5 + Claude 协议 + CC Switch 导入）。若导入用例失败且报 wasm 加载错误，回到 Task 4 Step 5 检查资产打包。

- [ ] **Step 5: 全量回归 + Commit**

Run: `npm test && npm run typecheck`
Expected: 全绿

```bash
git add wxt.config.ts entrypoints/popup/index.html entrypoints/options/index.html README.md e2e/stub-server.ts e2e/translate.spec.ts
git commit -m "feat: 品牌改名极简翻译，stub /v1/messages 与 Claude/导入 E2E"
```
