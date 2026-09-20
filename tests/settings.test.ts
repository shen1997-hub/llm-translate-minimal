import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_SETTINGS, LANGUAGES, getSettings, saveSettings, apiOriginPattern,
  getActiveProvider, resolveModel, saveProvider, deleteProvider,
  setActiveProvider, setActiveModel,
} from '../lib/settings';
import type { Provider } from '../lib/settings';

const store = new Map<string, unknown>();
(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store.get(key) }),
      set: async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) store.set(k, v); },
    },
  },
};

beforeEach(() => store.clear());

const PV: Provider = {
  id: 'pv-1', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
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

  it('默认 selectionTranslate 为 true，且可读写', async () => {
    const s = await getSettings();
    expect(s.selectionTranslate).toBe(true);
    await saveSettings({ selectionTranslate: false });
    expect((await getSettings()).selectionTranslate).toBe(false);
  });

  it('LANGUAGES 含简体中文与 English', () => {
    expect(LANGUAGES).toContain('简体中文');
    expect(LANGUAGES).toContain('English');
  });

  it('旧供应商数据无 protocol 字段时读取补 openai', async () => {
    store.set('settings', {
      providers: [{ id: 'p1', name: 'A', baseUrl: 'https://a.com', apiKey: 'k', models: ['m'], activeModel: 'm' }],
      activeProviderId: 'p1',
    });
    const s = await getSettings();
    expect(s.providers[0]!.protocol).toBe('openai');
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
