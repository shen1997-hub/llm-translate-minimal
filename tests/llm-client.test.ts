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

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function openaiFrames(text: string, size = 3): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return [
    ...parts.map(p => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`),
    'data: [DONE]\n\n',
  ];
}

describe('translateUnits（流式）', () => {
  it('按 plain 标记流式解析：onDelta 逐段吐出，最终结果与解析一致', async () => {
    const deltas: [number, string][] = [];
    const fetchImpl = vi.fn(async () => sseResponse(openaiFrames('[0] 甲\n\n[1] 乙'))) as any;
    const r = await translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep }, (i, t) => deltas.push([i, t]));
    expect(r.translations).toEqual(['甲', '乙']);
    expect(r.useJsonFormat).toBe(false);
    // 帧按 3 字符硬切时，标记后的空白会跟着下一帧一起到，落在段首/段尾——
    // HTML 会折叠它、最终 result 也会被 parsePlainResponse trim，所以这里比对实质文本
    expect(deltas.filter(([i]) => i === 0).map(([, t]) => t).join('').trim()).toBe('甲');
    expect(deltas.filter(([i]) => i === 1).map(([, t]) => t).join('').trim()).toBe('乙');
    expect(new Set(deltas.map(([i]) => i))).toEqual(new Set([0, 1])); // 两段都有增量
    // 流式请求恒不带 response_format，且带 stream: true
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(body.response_format).toBeUndefined();
  });

  it('Claude 协议取 content_block_delta.delta.text', async () => {
    const deltas: [number, string][] = [];
    const frames = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"[0] 甲"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const fetchImpl = vi.fn(async () => sseResponse(frames)) as any;
    const r = await translateUnits(CLAUDE_CFG, ['A'], { ...OPTS, useJsonFormat: true }, { fetchImpl, sleep: noSleep }, (i, t) => deltas.push([i, t]));
    expect(r.translations).toEqual(['甲']);
    expect(r.useJsonFormat).toBe(false);
    expect(deltas.map(([, t]) => t).join('')).toBe('甲');
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
  });

  it('流式 401 抛 AuthError 且不重试', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 })) as any;
    await expect(translateUnits(CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep }, () => {})).rejects.toBeInstanceOf(AuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('流式 400 直接抛错（不降级重发）', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 })) as any;
    await expect(translateUnits(CFG, ['A'], OPTS, { fetchImpl, sleep: noSleep }, () => {})).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('流式缺段时逐段补齐兜底走非流式 plain 请求', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(sseResponse(openaiFrames('[0] 甲')))  // 流式只给了第 0 段
      .mockResolvedValueOnce(jsonResponse('[0] 乙')) as any;       // 补齐第 1 段：非流式，且恒为 plain 标记
    const r = await translateUnits(CFG, ['A', 'B'], OPTS, { fetchImpl, sleep: noSleep }, () => {});
    expect(r.translations).toEqual(['甲', '乙']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
    expect(body2.stream).toBeUndefined();
    expect(body2.response_format).toBeUndefined(); // 流式的兜底同样不带 JSON 模式
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
