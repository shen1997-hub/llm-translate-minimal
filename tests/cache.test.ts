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
  it('未超条数但超字节上限时按 LRU 淘汰', async () => {
    for (let i = 0; i < 5; i++) {
      await setCached(`b${i}`, 'x'.repeat(10), { model: 'm', promptVersion: 'v1' }); // 每条 20 字节
      await new Promise(r => setTimeout(r, 2));
    }
    await evictIfNeeded(1000, 60); // 条数远未超限，但累计 100 字节 > 60
    expect(await getCached('b0')).toBeUndefined();
    expect(await getCached('b1')).toBeUndefined();
    expect(await getCached('b2')).toBe('x'.repeat(10));
    expect(await getCached('b4')).toBe('x'.repeat(10));
  });
});
