import { describe, it, expect, vi } from 'vitest';
import { translateUnits, AuthError } from '../lib/translation/llm-client';

const CFG = { baseUrl: 'https://api.test.com', apiKey: 'sk-x', model: 'm1' };
const OPTS = { targetLang: '中文', systemPrompt: 'SYS', useJsonFormat: true };
const noSleep = () => Promise.resolve();

function jsonResponse(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
}

describe('translateUnits', () => {
  it('正常 JSON 响应按 i 对齐返回', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"items":[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]}')) as any;
    const r = await translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep });
    expect(r.translations).toEqual(['甲', '乙']);
    expect(r.useJsonFormat).toBe(true);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('400 涉及 response_format 时降级 plain 并重发', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"response_format not supported"}', { status: 400 }))
      .mockResolvedValueOnce(jsonResponse('[0] 甲\n[1] 乙')) as any;
    const r = await translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep });
    expect(r.useJsonFormat).toBe(false);
    expect(r.translations).toEqual(['甲', '乙']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
    expect(body2.response_format).toBeUndefined();
  });

  it('JSON 解析失败时逐段降级补齐', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse('garbage not json'))
      .mockResolvedValueOnce(jsonResponse('{"items":[{"i":0,"t":"甲"}]}'))
      .mockResolvedValueOnce(jsonResponse('{"items":[{"i":0,"t":"乙"}]}')) as any;
    const r = await translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep });
    expect(r.translations).toEqual(['甲', '乙']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('逐段补齐遇 401 时抛 AuthError 而非吞掉', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse('{"items":[{"i":0,"t":"甲"}]}'))
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 })) as any;
    await expect(translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(AuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('429 退避重试后成功', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse('{"items":[{"i":0,"t":"甲"}]}')) as any;
    const r = await translateUnits(CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep });
    expect(r.translations).toEqual(['甲']);
  });

  it('401 抛 AuthError 且不重试', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 })) as any;
    await expect(translateUnits(CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(AuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('持续 500 重试 3 次后抛错', async () => {
    const fetchImpl = vi.fn(async () => new Response('server error', { status: 500 })) as any;
    await expect(translateUnits(CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep })).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 首次 + 3 次重试
  });
});
