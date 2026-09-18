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
