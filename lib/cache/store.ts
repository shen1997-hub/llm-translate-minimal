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
