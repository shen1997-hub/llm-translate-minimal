import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS, getSettings, saveSettings, apiOriginPattern } from '../lib/settings';

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
