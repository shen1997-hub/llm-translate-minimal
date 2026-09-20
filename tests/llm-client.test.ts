import { describe, it, expect, vi } from 'vitest';
import { translateUnits, AuthError } from '../lib/translation/llm-client';

const CFG = { baseUrl: 'https://api.test.com', apiKey: 'sk-x', model: 'm1', protocol: 'openai' as const };
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

  it('sourceLang 透传进请求体提示词', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse('{"items":[{"i":0,"t":"甲"}]}')) as any;
    await translateUnits(CFG, ['A'], { ...OPTS, sourceLang: 'English' }, { fetchImpl, sleep: noSleep });
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content).toContain('from English to 中文');
  });
});

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
