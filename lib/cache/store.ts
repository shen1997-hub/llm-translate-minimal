import { get, set, del, keys } from 'idb-keyval';

const PREFIX = 'tr:';
const META_KEY = 'tr-meta'; // 不带 tr: 前缀，不会被条目扫描匹配，也不会被淘汰
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

interface Meta {
  totalBytes: number;
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
  const existing = await get<Entry>(PREFIX + key);
  await set(PREFIX + key, entry);
  // 增量维护字节计数；覆盖写时先减去旧条目字节
  const metaRecord = (await get<Meta>(META_KEY)) ?? { totalBytes: 0 };
  await set(META_KEY, { totalBytes: metaRecord.totalBytes + entry.bytes - (existing?.bytes ?? 0) });
  await evictIfNeeded();
}

export async function evictIfNeeded(maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES): Promise<void> {
  const allKeys = (await keys()).filter(k => typeof k === 'string' && k.startsWith(PREFIX)) as string[];
  const meta = await get<Meta>(META_KEY);
  // 快路径：条数与字节数都未超限才直接返回；meta 缺失时走全量路径重建计数
  if (allKeys.length <= maxEntries && meta !== undefined && meta.totalBytes <= maxBytes) return;
  const entries = await Promise.all(allKeys.map(async k => ({ k, e: (await get<Entry>(k))! })));
  entries.sort((a, b) => a.e.accessedAt - b.e.accessedAt);
  // 增量计数允许毫秒级竞态漂移，这里按真实条目重算并回写，实现自愈
  let totalBytes = entries.reduce((n, x) => n + x.e.bytes, 0);
  let remaining = entries.length;
  for (const { k, e } of entries) {
    if (remaining <= maxEntries && totalBytes <= maxBytes) break;
    await del(k);
    totalBytes -= e.bytes;
    remaining--;
  }
  await set(META_KEY, { totalBytes });
}
