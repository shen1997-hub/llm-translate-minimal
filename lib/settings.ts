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
  selectionTranslate: boolean;
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
  selectionTranslate: true,
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
