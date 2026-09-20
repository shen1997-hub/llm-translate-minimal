# 多 API 供应商 + 模型/语言选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单一 LLM 配置升级为多供应商（每供应商多模型、popup 两级选择），并新增原文/目标语言选择（原文默认自动检测，目标默认简体中文）。

**Architecture:** 数据层（`lib/settings.ts`）新增 `providers[]`/`activeProviderId`/`sourceLang` 与惰性迁移；调度器改为解析当前供应商+模型；提示词按 sourceLang 生成措辞；设置页改为供应商列表（保存后折叠）；popup 加语言卡与供应商/模型两级下拉。

**Tech Stack:** 既有栈不变（WXT + TS strict + Vitest/jsdom + Playwright）。无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-20-multi-provider-design.md`

## Global Constraints

- TypeScript `strict: true`，vanilla TS，不引入 UI 框架
- `saveSettings` 不再写入废弃字段 `baseUrl`/`apiKey`/`model`（接口保留以兼容旧数据读取合并）
- TDD：`lib/` 改动先写失败测试再实现
- 每任务结束提交一次 commit，message 用 `feat:`/`test:`/`fix:` 前缀
- 现有 77 单测 + 4 E2E 保持绿（E2E seed 结构在 Task 6 更新）

## File Structure

```
lib/settings.ts                  # Provider/Settings/LANGUAGES/迁移/CRUD（Task 1）
tests/settings.test.ts           # 重写（Task 1）
lib/translation/prompt.ts        # buildMessages 加 sourceLang（Task 2）
lib/translation/llm-client.ts    # translateUnits opts 透传 sourceLang（Task 2）
tests/prompt.test.ts             # sourceLang 用例（Task 2）
tests/llm-client.test.ts         # 透传用例（Task 2）
lib/translation/scheduler.ts     # getActiveProvider/resolveModel 接入（Task 3）
tests/scheduler.test.ts          # mock 改新结构 + auth 用例（Task 3）
entrypoints/options/index.html   # 供应商列表 UI（Task 4）
entrypoints/options/main.ts      # 列表/编辑/折叠逻辑（Task 4）
entrypoints/popup/index.html     # 语言卡 + 两级下拉（Task 5）
entrypoints/popup/main.ts        # 下拉数据与事件（Task 5）
e2e/translate.spec.ts            # BASE_SETTINGS 改新结构（Task 6）
```

---

### Task 1: 设置数据模型与迁移 `lib/settings.ts`

**Files:**
- Modify: `lib/settings.ts`（整体重写）
- Test: `tests/settings.test.ts`（整体重写）

**Interfaces:**
- Produces（Task 3/4/5 消费）:
  - `interface Provider { id: string; name: string; baseUrl: string; apiKey: string; models: string[]; activeModel: string }`
  - `interface Settings`：新增 `providers: Provider[]`、`activeProviderId: string`、`sourceLang: string`；保留 `baseUrl/apiKey/model`（废弃，仅读取合并）
  - `const LANGUAGES: string[]`（12 种语言）
  - `getSettings()`（含惰性迁移 + 回写）、`saveSettings(patch)`（剥离废弃字段）
  - `getActiveProvider(s: Settings): Provider | null`、`resolveModel(p: Provider): string`
  - `saveProvider(p: Provider)`、`deleteProvider(id: string)`、`setActiveProvider(id: string)`、`setActiveModel(providerId: string, model: string)`
  - `apiOriginPattern(baseUrl: string)`（保留不变）

- [ ] **Step 1: 重写失败测试**

`tests/settings.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_SETTINGS, LANGUAGES, getSettings, saveSettings, apiOriginPattern,
  getActiveProvider, resolveModel, saveProvider, deleteProvider,
  setActiveProvider, setActiveModel, Provider,
} from '../lib/settings';

const store = new Map<string, unknown>();
(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store.get(key) }),
      set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
    },
  },
};

beforeEach(() => store.clear());

const PV: Provider = {
  id: 'pv-1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-x', models: ['deepseek-chat', 'deepseek-reasoner'], activeModel: 'deepseek-chat',
};

describe('默认值与读写', () => {
  it('无存储时返回默认值（providers 为空，sourceLang auto，targetLang 简体中文）', async () => {
    const s = await getSettings();
    expect(s.providers).toEqual([]);
    expect(s.activeProviderId).toBe('');
    expect(s.sourceLang).toBe('auto');
    expect(s.targetLang).toBe('简体中文');
  });

  it('saveSettings 不写入废弃字段 baseUrl/apiKey/model', async () => {
    await saveSettings({ targetLang: 'English' });
    const raw = store.get('settings') as Record<string, unknown>;
    expect(raw.targetLang).toBe('English');
    expect('baseUrl' in raw).toBe(false);
    expect('apiKey' in raw).toBe(false);
    expect('model' in raw).toBe(false);
  });

  it('apiOriginPattern 生成 origin 通配', () => {
    expect(apiOriginPattern('https://api.deepseek.com/')).toBe('https://api.deepseek.com/*');
    expect(apiOriginPattern('http://localhost:11434/v1')).toBe('http://localhost:11434/*');
  });

  it('LANGUAGES 含简体中文与 English', () => {
    expect(LANGUAGES).toContain('简体中文');
    expect(LANGUAGES).toContain('English');
  });
});

describe('旧单配置迁移', () => {
  it('旧字段迁移为单个供应商并回写存储', async () => {
    store.set('settings', {
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-old', model: 'deepseek-chat',
      systemPrompt: 'SYS', targetLang: '中文', blacklist: [], disabledSites: [],
      minLength: 20, cjkRatioThreshold: 0.3,
    });
    const s = await getSettings();
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0]).toMatchObject({
      id: 'pv-legacy', name: 'deepseek.com', baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-old', models: ['deepseek-chat'], activeModel: 'deepseek-chat',
    });
    expect(s.activeProviderId).toBe('pv-legacy');
    // 已回写：再次读取不重复迁移
    const again = await getSettings();
    expect(again.providers).toHaveLength(1);
  });

  it('URL 非法时名称回退「默认供应商」', async () => {
    store.set('settings', { baseUrl: 'not-a-url', apiKey: 'k', model: 'm' });
    const s = await getSettings();
    expect(s.providers[0]!.name).toBe('默认供应商');
  });

  it('空存储（纯默认值）不触发迁移', async () => {
    const s = await getSettings();
    expect(s.providers).toEqual([]);
  });
});

describe('getActiveProvider / resolveModel', () => {
  it('命中 activeProviderId；悬空回退第一个；空列表 null', async () => {
    const s = await getSettings();
    const p2 = { ...PV, id: 'pv-2', name: 'GLM' };
    expect(getActiveProvider({ ...s, providers: [PV, p2], activeProviderId: 'pv-2' })?.name).toBe('GLM');
    expect(getActiveProvider({ ...s, providers: [PV, p2], activeProviderId: 'gone' })?.id).toBe('pv-1');
    expect(getActiveProvider({ ...s, providers: [], activeProviderId: '' })).toBeNull();
  });

  it('resolveModel：命中 / 悬空回退首个 / 空列表空串', () => {
    expect(resolveModel(PV)).toBe('deepseek-chat');
    expect(resolveModel({ ...PV, activeModel: 'gone' })).toBe('deepseek-chat');
    expect(resolveModel({ ...PV, models: [], activeModel: '' })).toBe('');
  });
});

describe('providers CRUD', () => {
  it('saveProvider 追加并自动设为当前（首个）；同 id 则更新', async () => {
    await saveProvider(PV);
    let s = await getSettings();
    expect(s.providers).toHaveLength(1);
    expect(s.activeProviderId).toBe('pv-1');
    await saveProvider({ ...PV, apiKey: 'sk-new' });
    s = await getSettings();
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0]!.apiKey).toBe('sk-new');
  });

  it('deleteProvider 删除当前供应商时回退到剩余第一个', async () => {
    await saveProvider(PV);
    await saveProvider({ ...PV, id: 'pv-2', name: 'GLM' });
    await deleteProvider('pv-1');
    const s = await getSettings();
    expect(s.providers.map(p => p.id)).toEqual(['pv-2']);
    expect(s.activeProviderId).toBe('pv-2');
  });

  it('setActiveProvider / setActiveModel', async () => {
    await saveProvider(PV);
    await saveProvider({ ...PV, id: 'pv-2', name: 'GLM' });
    await setActiveProvider('pv-2');
    await setActiveModel('pv-2', 'glm-4-flash');
    const s = await getSettings();
    expect(s.activeProviderId).toBe('pv-2');
    expect(s.providers.find(p => p.id === 'pv-2')!.activeModel).toBe('glm-4-flash');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- settings`
Expected: FAIL（导出名不存在）

- [ ] **Step 3: 重写 `lib/settings.ts`**

```ts
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  activeModel: string;
}

export interface Settings {
  providers: Provider[];
  activeProviderId: string;
  sourceLang: string;
  systemPrompt: string;
  targetLang: string;
  blacklist: string[];
  disabledSites: string[];
  minLength: number;
  cjkRatioThreshold: number;
  /** 废弃：仅用于读取合并与旧数据迁移，saveSettings 不再写入 */
  baseUrl: string;
  /** 废弃：同上 */
  apiKey: string;
  /** 废弃：同上 */
  model: string;
}

export const LANGUAGES: string[] = [
  '简体中文', '繁体中文', 'English', '日本語', '한국어', 'Français',
  'Deutsch', 'Español', 'Русский', 'Português', 'العربية', 'हिन्दी',
];

export const DEFAULT_SETTINGS: Settings = {
  providers: [],
  activeProviderId: '',
  sourceLang: 'auto',
  systemPrompt: 'You are a professional translator. Translate faithfully and fluently, preserving meaning, tone, and formatting markers.',
  targetLang: '简体中文',
  blacklist: [],
  disabledSites: [],
  minLength: 20,
  cjkRatioThreshold: 0.3,
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
};

const KEY = 'settings';

function stripDeprecated(s: Settings): Record<string, unknown> {
  const { baseUrl: _b, apiKey: _k, model: _m, ...rest } = s;
  return rest;
}

function inferProviderName(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/^api\./, '') || '默认供应商';
  } catch {
    return '默认供应商';
  }
}

export async function getSettings(): Promise<Settings> {
  const stored = ((await chrome.storage.local.get(KEY))[KEY] ?? {}) as Partial<Settings>;
  const merged: Settings = { ...DEFAULT_SETTINGS, ...stored };
  // 惰性迁移：旧单配置 → 单供应商。只认存储里真实存在的旧字段，纯默认值不触发
  if (merged.providers.length === 0 && (stored.baseUrl || stored.apiKey || stored.model)) {
    const legacy: Provider = {
      id: 'pv-legacy',
      name: inferProviderName(stored.baseUrl ?? ''),
      baseUrl: stored.baseUrl ?? DEFAULT_SETTINGS.baseUrl,
      apiKey: stored.apiKey ?? '',
      models: stored.model ? [stored.model] : [],
      activeModel: stored.model ?? '',
    };
    const migrated: Settings = { ...merged, providers: [legacy], activeProviderId: legacy.id };
    await chrome.storage.local.set({ [KEY]: stripDeprecated(migrated) });
    return migrated;
  }
  return merged;
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({ [KEY]: stripDeprecated({ ...current, ...patch }) });
}

export function apiOriginPattern(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.origin}/*`;
}

export function getActiveProvider(s: Settings): Provider | null {
  return s.providers.find(p => p.id === s.activeProviderId) ?? s.providers[0] ?? null;
}

export function resolveModel(p: Provider): string {
  return p.models.includes(p.activeModel) ? p.activeModel : (p.models[0] ?? '');
}

export async function saveProvider(provider: Provider): Promise<void> {
  const s = await getSettings();
  const exists = s.providers.some(p => p.id === provider.id);
  const providers = exists
    ? s.providers.map(p => (p.id === provider.id ? provider : p))
    : [...s.providers, provider];
  await saveSettings({ providers, activeProviderId: s.activeProviderId || provider.id });
}

export async function deleteProvider(id: string): Promise<void> {
  const s = await getSettings();
  const providers = s.providers.filter(p => p.id !== id);
  const activeProviderId = s.activeProviderId === id ? (providers[0]?.id ?? '') : s.activeProviderId;
  await saveSettings({ providers, activeProviderId });
}

export async function setActiveProvider(id: string): Promise<void> {
  await saveSettings({ activeProviderId: id });
}

export async function setActiveModel(providerId: string, model: string): Promise<void> {
  const s = await getSettings();
  await saveSettings({
    providers: s.providers.map(p => (p.id === providerId ? { ...p, activeModel: model } : p)),
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- settings`
Expected: 12 passed

- [ ] **Step 5: 确认其他测试无连带破坏**

Run: `npm test`
Expected: scheduler 测试因 getSettings mock 结构变化可能失败——**允许红，Task 3 修复**；其余全绿

- [ ] **Step 6: Commit**

```bash
git add lib/settings.ts tests/settings.test.ts
git commit -m "feat: 设置数据模型升级——多供应商/多模型/sourceLang + 旧配置惰性迁移"
```

---

### Task 2: 提示词 sourceLang 与透传

**Files:**
- Modify: `lib/translation/prompt.ts`、`lib/translation/llm-client.ts`
- Test: `tests/prompt.test.ts`、`tests/llm-client.test.ts`

**Interfaces:**
- Consumes: 无新依赖
- Produces（Task 3 消费）:
  - `buildMessages(texts, targetLang, systemPrompt, mode, sourceLang?)` — sourceLang 缺省或 `'auto'` 维持原措辞；否则生成 `Translate the following texts from {sourceLang} to {targetLang}.`
  - `translateUnits(cfg, texts, opts, deps?)` 的 `opts` 新增可选 `sourceLang?: string`

- [ ] **Step 1: 追加失败测试**

`tests/prompt.test.ts` 的 `describe('buildMessages')` 内追加：

```ts
  it('sourceLang 为 auto 或缺省时措辞不变', () => {
    const m1 = buildMessages(['Hello world here'], '中文', 'SYS', 'json', 'auto');
    const m2 = buildMessages(['Hello world here'], '中文', 'SYS', 'json');
    expect(m1[0].content).toContain('to 中文');
    expect(m1[0].content).not.toContain('from');
    expect(m2[0].content).toBe(m1[0].content);
  });

  it('指定 sourceLang 时生成 from X to Y 措辞', () => {
    const m = buildMessages(['Hello world here'], '简体中文', 'SYS', 'plain', 'English');
    expect(m[0].content).toContain('from English to 简体中文');
  });
```

`tests/llm-client.test.ts` 的 `describe('translateUnits')` 内追加：

```ts
  it('sourceLang 透传进请求体提示词', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"items":[{"i":0,"t":"甲"}]}')) as any;
    await translateUnits(CFG, ['A'], { ...OPTS, sourceLang: 'English' }, { fetchImpl, sleep: noSleep });
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content).toContain('from English to 中文');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- prompt llm-client`
Expected: FAIL（参数未使用/不存在）

- [ ] **Step 3: 实现**

`lib/translation/prompt.ts` 的 `buildMessages` 改为：

```ts
export function buildMessages(
  texts: string[],
  targetLang: string,
  systemPrompt: string,
  mode: PromptMode,
  sourceLang?: string,
): ChatMessage[] {
  const numbered = texts.map((t, i) => `[${i}] ${t}`).join('\n\n');
  const format = mode === 'json'
    ? 'Respond with JSON only, no other text: {"items":[{"i":0,"t":"translation of item 0"}]}. Include every input index.'
    : 'Respond with each translation prefixed by the same [i] marker as its input, one item per block. No other text.';
  const langDirective = sourceLang && sourceLang !== 'auto'
    ? `Translate the following texts from ${sourceLang} to ${targetLang}.`
    : `Translate the following texts to ${targetLang}.`;
  return [
    { role: 'system', content: `${systemPrompt}\n${langDirective} ${format}` },
    { role: 'user', content: numbered },
  ];
}
```

`lib/translation/llm-client.ts`：

- `translateSingle` 与 `translateUnits` 的 `opts` 类型加 `sourceLang?: string`
- 三处 `buildMessages(...)` 调用末尾追加 `opts.sourceLang` 实参（translateSingle 内部用同一 opts 对象）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- prompt llm-client`
Expected: 全部通过（prompt 11、llm-client 7）

- [ ] **Step 5: Commit**

```bash
git add lib/translation/prompt.ts lib/translation/llm-client.ts tests/prompt.test.ts tests/llm-client.test.ts
git commit -m "feat: 提示词支持指定原文语言（auto 时措辞不变）"
```

---

### Task 3: 调度器接入供应商解析

**Files:**
- Modify: `lib/translation/scheduler.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `getActiveProvider`、`resolveModel`、`Settings`、`Provider`（Task 1）；`translateUnits` 的 `sourceLang`（Task 2）
- Produces: `SchedulerDeps.getSettings: () => Promise<Settings>`（完整 Settings）；无供应商时返回 `{ kind: 'error', code: 'auth' }`

- [ ] **Step 1: 更新 mock 并追加失败测试**

`tests/scheduler.test.ts` 的 `makeDeps` 中 `getSettings` mock 改为完整 Settings：

```ts
    getSettings: vi.fn(async () => ({
      providers: [{
        id: 'pv-1', name: 'Test', baseUrl: 'https://api.test.com',
        apiKey: 'sk-x', models: ['m1'], activeModel: 'm1',
      }],
      activeProviderId: 'pv-1',
      sourceLang: 'auto',
      systemPrompt: 'SYS', targetLang: '中文',
      blacklist: [], disabledSites: [], minLength: 20, cjkRatioThreshold: 0.3,
      baseUrl: '', apiKey: '', model: '',
    })),
```

`describe('handleTranslateRequest')` 内追加：

```ts
  it('无供应商时返回 code=auth 且不调用 LLM', async () => {
    const deps = makeDeps({
      getSettings: vi.fn(async () => ({
        providers: [], activeProviderId: '', sourceLang: 'auto',
        systemPrompt: 'SYS', targetLang: '中文',
        blacklist: [], disabledSites: [], minLength: 20, cjkRatioThreshold: 0.3,
        baseUrl: '', apiKey: '', model: '',
      })) as any,
    });
    const r = await handleTranslateRequest(REQ, deps);
    expect(r).toMatchObject({ kind: 'error', code: 'auth' });
    expect(deps.translate).not.toHaveBeenCalled();
  });

  it('使用解析后的供应商与模型，并透传 sourceLang', async () => {
    const deps = makeDeps();
    await handleTranslateRequest(REQ, deps);
    const call = (deps.translate as any).mock.calls[0];
    expect(call[0]).toEqual({ baseUrl: 'https://api.test.com', apiKey: 'sk-x', model: 'm1' });
    expect(call[2].sourceLang).toBe('auto');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- scheduler`
Expected: 新用例 FAIL（mock 结构与实现不匹配）

- [ ] **Step 3: 修改 `lib/translation/scheduler.ts`**

改动点（其余逻辑不变）：

```ts
import { getActiveProvider, resolveModel, Settings } from '../settings';

export interface SchedulerDeps {
  translate: typeof translateUnits;
  getCached: (key: string) => Promise<string | undefined>;
  setCached: (key: string, translation: string, meta: { model: string; promptVersion: string }) => Promise<void>;
  getSettings: () => Promise<Settings>;
  jsonFormatSupported: { value: boolean };
}
```

`handleTranslateRequest` 开头改为：

```ts
  const settings = await deps.getSettings();
  const provider = getActiveProvider(settings);
  if (!provider) {
    return { kind: 'error', taskId: req.taskId, chunkId: req.chunkId, code: 'auth', message: '尚未配置 API 供应商，请前往设置页添加' };
  }
  const cfg: LlmConfig = { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: resolveModel(provider) };
```

- `cacheKeyOf(...)` 调用处的 `settings.model` 改为 `cfg.model`
- `deps.translate(...)` 的 opts 加 `sourceLang: settings.sourceLang`
- 写缓存的 `meta: { model: settings.model, ... }` 改为 `{ model: cfg.model, ... }`

- [ ] **Step 4: 跑全部单测确认通过**

Run: `npm test`
Expected: 全部通过（含 Task 1 可能连带红掉的 scheduler 旧用例）

- [ ] **Step 5: Commit**

```bash
git add lib/translation/scheduler.ts tests/scheduler.test.ts
git commit -m "feat: 调度器按当前供应商+模型解析配置，无供应商返回 auth 错误"
```

---

### Task 4: 设置页供应商管理 UI

**Files:**
- Modify: `entrypoints/options/index.html`、`entrypoints/options/main.ts`
- Test: 无单测（列表交互由手动验收覆盖；Task 6 全量回归兜底）

**Interfaces:**
- Consumes: `getSettings`、`saveSettings`、`saveProvider`、`deleteProvider`、`setActiveProvider`、`Provider`、`LANGUAGES`（Task 1）
- Produces: 供应商列表（摘要行 ⇄ 编辑表单，保存后折叠）；全局项（系统提示词/目标语言下拉/阈值/黑名单）仍由底部保存按钮持久化

- [ ] **Step 1: 重写 `entrypoints/options/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>LLM Translate 设置</title>
<style>
  :root {
    --primary: #e91e63; --primary-hover: #d81b60; --bg: #f2f4f8; --card: #ffffff;
    --text: #333333; --text-secondary: #999999; --border: #eeeeee; --danger: #e06c75;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--text); font-size: 14px; }
  .container { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
  .header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  .header .logo { width: 32px; height: 32px; border-radius: 9px; background: var(--primary); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .card { background: var(--card); border-radius: 12px; padding: 6px 18px 14px; margin-bottom: 14px; }
  .card h2 { font-size: 13px; color: var(--text-secondary); font-weight: 500; padding: 12px 0 4px; }
  label { display: block; margin-top: 10px; font-size: 13.5px; font-weight: 500; }
  input, textarea, select { width: 100%; box-sizing: border-box; margin-top: 5px; padding: 9px 11px; border: 1px solid #dde1e7; border-radius: 8px; font-size: 13.5px; font-family: inherit; background: #fafbfc; color: var(--text); }
  input:focus, textarea:focus, select:focus { outline: 2px solid #f8bbd0; border-color: var(--primary); }
  textarea { min-height: 76px; resize: vertical; }
  .row { display: flex; gap: 12px; } .row > div { flex: 1; }

  /* 供应商列表 */
  .pv-row { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-top: 1px solid var(--border); }
  .pv-row:first-of-type { border-top: none; }
  .pv-info { flex: 1; min-width: 0; }
  .pv-name { font-weight: 600; font-size: 14px; }
  .pv-sub { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pv-badge { font-size: 11px; color: var(--primary); border: 1px solid var(--primary); border-radius: 6px; padding: 1px 6px; flex: none; }
  .pv-actions { display: flex; gap: 6px; flex: none; }
  .btn-text { border: none; background: none; color: var(--primary); font-size: 13px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
  .btn-text:hover { background: #fdeef4; }
  .btn-text.danger { color: var(--danger); }
  .btn-text.danger:hover { background: #fdeeef; }
  .pv-form { border-top: 1px dashed var(--border); padding: 4px 0 12px; }
  .pv-form .form-actions { display: flex; gap: 10px; margin-top: 12px; }
  .form-error { color: var(--danger); font-size: 12.5px; margin-top: 8px; }
  #add-provider { width: 100%; margin-top: 12px; padding: 9px; border: 1px dashed #ccd1d9; border-radius: 8px; background: none; color: var(--text-secondary); font-size: 13.5px; cursor: pointer; }
  #add-provider:hover { border-color: var(--primary); color: var(--primary); }
  .empty-hint { padding: 14px 0; color: var(--text-secondary); font-size: 13px; text-align: center; }

  .btn-primary { padding: 9px 22px; border: none; border-radius: 10px; cursor: pointer; background: var(--primary); color: #fff; font-size: 14px; font-weight: 600; }
  .btn-primary:hover { background: var(--primary-hover); }
  .btn-secondary { padding: 8px 16px; border: 1px solid #ccd1d9; border-radius: 10px; cursor: pointer; background: #fff; color: var(--text); font-size: 13.5px; }
  .actions { display: flex; align-items: center; gap: 10px; margin-top: 18px; }
  #status { margin-left: auto; font-size: 13px; color: #2a7; }
</style></head>
<body>
  <div class="container">
    <div class="header"><div class="logo">译</div><h1>LLM Translate 设置</h1></div>

    <div class="card">
      <h2>API 供应商</h2>
      <div id="provider-list"></div>
      <button id="add-provider">+ 添加供应商</button>
    </div>

    <div class="card">
      <h2>翻译偏好</h2>
      <label>系统提示词 <textarea id="systemPrompt"></textarea></label>
      <div class="row">
        <div><label>目标语言 <select id="targetLang"></select></label></div>
        <div><label>最短段落长度 <input id="minLength" type="number"></label></div>
        <div><label>中文占比阈值 <input id="cjkRatioThreshold" type="number" step="0.05" min="0" max="1"></label></div>
      </div>
    </div>

    <div class="card">
      <h2>站点管理</h2>
      <label>网站黑名单（每行一个域名）<textarea id="blacklist"></textarea></label>
    </div>

    <div class="actions">
      <button id="save" class="btn-primary">保存</button>
      <span id="status"></span>
    </div>
  </div>
  <script type="module" src="./main.ts"></script>
</body>
</html>
```

- [ ] **Step 2: 重写 `entrypoints/options/main.ts`**

```ts
import {
  getSettings, saveSettings, saveProvider, deleteProvider, setActiveProvider,
  LANGUAGES, Provider, Settings,
} from '../../lib/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let editingId: string | null = null; // null = 全部折叠；'new' = 新增表单

function newProviderDraft(): Provider {
  return {
    id: `pv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '', baseUrl: '', apiKey: '', models: [], activeModel: '',
  };
}

async function renderProviders(): Promise<void> {
  const s = await getSettings();
  const list = $('provider-list');
  list.innerHTML = '';
  if (s.providers.length === 0 && editingId !== 'new') {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = '尚未配置供应商，点击下方按钮添加';
    list.appendChild(hint);
  }
  for (const p of s.providers) {
    list.appendChild(editingId === p.id ? buildForm(p) : buildRow(p, s));
  }
  if (editingId === 'new') list.appendChild(buildForm(newProviderDraft()));
}

function buildRow(p: Provider, s: Settings): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pv-row';
  const isActive = p.id === s.activeProviderId;
  row.innerHTML = `
    <div class="pv-info">
      <div class="pv-name"></div>
      <div class="pv-sub"></div>
    </div>
    ${isActive ? '<span class="pv-badge">当前</span>' : ''}
    <div class="pv-actions">
      ${isActive ? '' : '<button class="btn-text" data-act="use">设为当前</button>'}
      <button class="btn-text" data-act="edit">编辑</button>
      <button class="btn-text danger" data-act="del">删除</button>
    </div>`;
  row.querySelector('.pv-name')!.textContent = p.name;
  row.querySelector('.pv-sub')!.textContent = `${resolveModelLabel(p)} · ${p.baseUrl}`;
  row.querySelector('[data-act="use"]')?.addEventListener('click', async () => {
    await setActiveProvider(p.id);
    await renderProviders();
  });
  row.querySelector('[data-act="edit"]')!.addEventListener('click', async () => {
    editingId = p.id;
    await renderProviders();
  });
  row.querySelector('[data-act="del"]')!.addEventListener('click', async () => {
    await deleteProvider(p.id);
    if (editingId === p.id) editingId = null;
    await renderProviders();
  });
  return row;
}

function resolveModelLabel(p: Provider): string {
  return p.models.includes(p.activeModel) ? p.activeModel : (p.models[0] ?? '（无模型）');
}

function buildForm(p: Provider): HTMLElement {
  const form = document.createElement('div');
  form.className = 'pv-form';
  form.innerHTML = `
    <label>名称 <input data-f="name" placeholder="如 DeepSeek"></label>
    <label>API Base URL <input data-f="baseUrl" placeholder="https://api.deepseek.com"></label>
    <label>API Key <input data-f="apiKey" type="password"></label>
    <label>模型列表（逗号分隔，首个为默认选中） <input data-f="models" placeholder="deepseek-chat, deepseek-reasoner"></label>
    <div class="form-error" hidden></div>
    <div class="form-actions">
      <button class="btn-primary" data-act="save">保存</button>
      <button class="btn-secondary" data-act="cancel">取消</button>
    </div>`;
  const val = (f: string) => form.querySelector<HTMLInputElement>(`[data-f="${f}"]`)!;
  val('name').value = p.name;
  val('baseUrl').value = p.baseUrl;
  val('apiKey').value = p.apiKey;
  val('models').value = p.models.join(', ');

  form.querySelector('[data-act="cancel"]')!.addEventListener('click', async () => {
    editingId = null;
    await renderProviders();
  });
  form.querySelector('[data-act="save"]')!.addEventListener('click', async () => {
    const name = val('name').value.trim();
    const baseUrl = val('baseUrl').value.trim().replace(/\/+$/, '');
    const apiKey = val('apiKey').value.trim();
    const models = val('models').value.split(/[,，]/).map(m => m.trim()).filter(Boolean);
    const err = form.querySelector<HTMLElement>('.form-error')!;
    const fail = (msg: string) => { err.textContent = msg; err.hidden = false; };
    if (!name) return fail('请填写名称');
    try { new URL(baseUrl); } catch { return fail('Base URL 不是合法 URL'); }
    if (models.length === 0) return fail('请至少填写一个模型');
    await saveProvider({
      ...p, name, baseUrl, apiKey, models,
      activeModel: models.includes(p.activeModel) ? p.activeModel : models[0]!,
    });
    editingId = null; // 保存后折叠回摘要行
    await renderProviders();
  });
  return form;
}

async function loadGlobals(): Promise<void> {
  const s = await getSettings();
  ($('systemPrompt') as HTMLTextAreaElement).value = s.systemPrompt;
  const langSelect = $('targetLang') as HTMLSelectElement;
  langSelect.innerHTML = '';
  for (const lang of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = lang;
    langSelect.appendChild(opt);
  }
  // 旧数据可能是自由文本（如「中文」），保留为可选中的附加项
  if (s.targetLang && !LANGUAGES.includes(s.targetLang)) {
    const opt = document.createElement('option');
    opt.value = s.targetLang;
    opt.textContent = `${s.targetLang}（自定义）`;
    langSelect.appendChild(opt);
  }
  langSelect.value = s.targetLang;
  ($('minLength') as HTMLInputElement).value = String(s.minLength);
  ($('cjkRatioThreshold') as HTMLInputElement).value = String(s.cjkRatioThreshold);
  ($('blacklist') as HTMLTextAreaElement).value = s.blacklist.join('\n');
}

$('save').addEventListener('click', async () => {
  await saveSettings({
    systemPrompt: ($('systemPrompt') as HTMLTextAreaElement).value,
    targetLang: ($('targetLang') as HTMLSelectElement).value || '简体中文',
    minLength: Number(($('minLength') as HTMLInputElement).value) || 20,
    cjkRatioThreshold: Number(($('cjkRatioThreshold') as HTMLInputElement).value) || 0.3,
    blacklist: ($('blacklist') as HTMLTextAreaElement).value.split('\n').map(x => x.trim()).filter(Boolean),
  });
  $('status').textContent = '已保存';
});

$('add-provider').addEventListener('click', async () => {
  editingId = 'new';
  await renderProviders();
});

void loadGlobals().then(renderProviders);
```

- [ ] **Step 3: 验证构建与类型**

Run: `npm run build && npm run typecheck`
Expected: build 成功，typecheck 无错误

- [ ] **Step 4: Commit**

```bash
git add entrypoints/options
git commit -m "feat: 设置页供应商列表管理（编辑/保存折叠/设为当前/删除）"
```

---

### Task 5: Popup 语言卡与两级下拉

**Files:**
- Modify: `entrypoints/popup/index.html`、`entrypoints/popup/main.ts`
- Test: 无单测（Task 6 全量回归兜底）

**Interfaces:**
- Consumes: `getSettings`、`saveSettings`、`setActiveProvider`、`setActiveModel`、`getActiveProvider`、`resolveModel`、`LANGUAGES`（Task 1）
- Produces: 语言卡（`#source-lang`/`#target-lang` 下拉）；服务卡（`#provider-select`/`#model-select` 下拉 + 站点开关行保留）

- [ ] **Step 1: 修改 `entrypoints/popup/index.html`**

在 `.header` 之后、服务卡之前插入语言卡；服务卡前两行改为下拉。替换原 `<div class="card">…</div>` 整块为：

```html
  <div class="card">
    <div class="row"><span class="label">原文语言</span><select id="source-lang" class="lang-select"></select></div>
    <div class="row"><span class="label">目标语言</span><select id="target-lang" class="lang-select"></select></div>
  </div>

  <div class="card">
    <div class="row"><span class="label">翻译服务</span><select id="provider-select" class="lang-select"></select></div>
    <div class="row"><span class="label">模型</span><select id="model-select" class="lang-select"></select></div>
    <div class="row">
      <span>在此站点启用</span>
      <label class="switch"><input type="checkbox" id="site-toggle" checked><span class="slider"></span></label>
    </div>
  </div>
```

`<style>` 内追加：

```css
  .lang-select {
    max-width: 170px; padding: 5px 8px; border: 1px solid #dde1e7; border-radius: 8px;
    font-size: 13px; background: #fafbfc; color: var(--text); font-family: inherit;
  }
  .lang-select:disabled { color: var(--text-secondary); }
  .card .row .link { color: var(--primary); font-size: 13px; cursor: pointer; text-decoration: none; }
```

同时删除 `.card .value` 样式规则（不再使用），并删除 `<style>` 中不再引用的规则无需清理其他。

- [ ] **Step 2: 修改 `entrypoints/popup/main.ts`**

import 改为：

```ts
import {
  getSettings, saveSettings, setActiveProvider, setActiveModel,
  getActiveProvider, resolveModel, LANGUAGES,
} from '../../lib/settings';
```

`refresh()` 中删除 `$('model-name')`/`$('target-lang')` 赋值与授权检查块（静态 host_permissions 后恒已授权，`#grant` 元素保留但始终 hidden——保留原逻辑也可，但 `$('grant')` 相关代码删除，HTML 中保留 `<button id="grant" hidden>` 不再使用则一并从 HTML 删除），并替换为：

```ts
  currentTabId = tab.id;
  const host = new URL(tab.url).hostname;
  const s = await getSettings();
  ($('site-toggle') as HTMLInputElement).checked = !s.disabledSites.includes(host);

  // 语言下拉
  fillLangSelect($('source-lang') as HTMLSelectElement, ['自动检测', ...LANGUAGES], s.sourceLang === 'auto' ? '自动检测' : s.sourceLang);
  fillLangSelect($('target-lang') as HTMLSelectElement, LANGUAGES, s.targetLang);

  // 供应商/模型两级下拉
  const providerSelect = $('provider-select') as HTMLSelectElement;
  const modelSelect = $('model-select') as HTMLSelectElement;
  providerSelect.innerHTML = '';
  if (s.providers.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '未配置，点击前往设置';
    providerSelect.appendChild(opt);
    providerSelect.disabled = true;
    modelSelect.innerHTML = '';
    modelSelect.disabled = true;
  } else {
    providerSelect.disabled = false;
    modelSelect.disabled = false;
    const active = getActiveProvider(s);
    for (const p of s.providers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      providerSelect.appendChild(opt);
    }
    providerSelect.value = active?.id ?? '';
    fillModelSelect(modelSelect, active?.models ?? [], active ? resolveModel(active) : '');
  }

  if (!getActiveProvider(s)?.apiKey) { $('message').textContent = '请先在设置页填写 API Key'; $('message').className = 'error'; }
```

新增辅助函数（文件内）：

```ts
function fillLangSelect(select: HTMLSelectElement, options: string[], current: string): void {
  select.innerHTML = '';
  for (const label of options) {
    const opt = document.createElement('option');
    opt.value = label === '自动检测' ? 'auto' : label;
    opt.textContent = label;
    select.appendChild(opt);
  }
  // 旧数据自由文本（如「中文」）保留为可选项
  if (current !== 'auto' && ![...select.options].some(o => o.value === current)) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = `${current}（自定义）`;
    select.appendChild(opt);
  }
  select.value = current;
}

function fillModelSelect(select: HTMLSelectElement, models: string[], current: string): void {
  select.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  }
  select.value = current;
}
```

新增事件（`refresh()` 之外，与其他 listener 并列）：

```ts
$('source-lang').addEventListener('change', async (e) => {
  await saveSettings({ sourceLang: (e.target as HTMLSelectElement).value });
});
$('target-lang').addEventListener('change', async (e) => {
  await saveSettings({ targetLang: (e.target as HTMLSelectElement).value });
});
$('provider-select').addEventListener('change', async (e) => {
  const id = (e.target as HTMLSelectElement).value;
  if (!id) return;
  await setActiveProvider(id);
  await refresh();
});
$('model-select').addEventListener('change', async (e) => {
  const s = await getSettings();
  const active = getActiveProvider(s);
  if (active) await setActiveModel(active.id, (e.target as HTMLSelectElement).value);
});
```

删除：`apiOriginPattern` 相关 import 与 `$('grant')` 事件与逻辑；从 HTML 删除 `<button id="grant" hidden>授权 API 域名</button>`。

- [ ] **Step 3: 验证构建与类型**

Run: `npm run build && npm run typecheck`
Expected: 成功无错误

- [ ] **Step 4: Commit**

```bash
git add entrypoints/popup
git commit -m "feat: popup 语言卡（自动检测/多语言）与供应商·模型两级下拉"
```

---

### Task 6: E2E seed 更新与全量回归

**Files:**
- Modify: `e2e/translate.spec.ts:8-18`（BASE_SETTINGS）

**Interfaces:**
- Consumes: Task 1 的 Settings 结构

- [ ] **Step 1: 更新 BASE_SETTINGS**

```ts
const BASE_SETTINGS = {
  providers: [{
    id: 'pv-1', name: 'Stub', baseUrl: STUB_ORIGIN,
    apiKey: 'sk-test', models: ['m1'], activeModel: 'm1',
  }],
  activeProviderId: 'pv-1',
  sourceLang: 'auto',
  systemPrompt: 'SYS',
  targetLang: '中文',
  blacklist: [],
  disabledSites: [] as string[],
  minLength: 20,
  cjkRatioThreshold: 0.3,
};
```

- [ ] **Step 2: 全量回归**

Run: `npm test && npm run build && npm run e2e`
Expected: 单测全过（约 100 个）、build 成功、E2E 4 passed

- [ ] **Step 3: Commit**

```bash
git add e2e/translate.spec.ts
git commit -m "test: E2E seed 升级为多供应商结构"
```

- [ ] **Step 4: 手动验收清单（真实浏览器）**

- [ ] 旧配置用户重载扩展后自动迁移出供应商（设置页可见摘要行）
- [ ] 设置页：添加/编辑供应商 → 保存后表单折叠回摘要行；设为当前/删除生效
- [ ] popup：语言卡两级下拉切换即时生效；供应商/模型两级联动正确
- [ ] 指定原文语言后翻译正常；缓存命中不受语言切换污染（key 含 targetLang）

---

## 自审记录

- Spec 覆盖：数据模型/迁移（T1）、CRUD（T1）、resolveModel/getActiveProvider（T1/T3）、prompt sourceLang（T2）、scheduler 供应商解析与 auth 错误（T3）、设置页列表+保存折叠+系统提示词迁移+目标语言下拉（T4）、popup 语言卡+两级下拉+未配置兜底（T5）、E2E seed（T6）
- 类型一致性：`Provider`（T1 定义，T3/T4/T5 使用）、`resolveModel`（T1 定义，T3/T5 使用；T4 内有同名局部展示函数 `resolveModelLabel` 避免冲突）、`setActiveModel(providerId, model)`（T1 定义，T5 使用）、`buildMessages` 五参签名（T2 定义，T3 透传）、`SchedulerDeps.getSettings: () => Promise<Settings>`（T3 定义，background.ts 传入的 `getSettings` 签名天然兼容）
- 注意点：T1 后 scheduler 旧 mock 会红属预期（T3 修复）；popup 的 `#grant` 授权按钮随静态 host_permissions 移除；options 页 `apiOriginPattern` 授权状态区随 UI 重写移除（静态权限后无意义）
