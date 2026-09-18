import { describe, it, expect, vi } from 'vitest';
import { handleTranslateRequest, type SchedulerDeps } from '../lib/translation/scheduler';
import type { TranslateRequest } from '../lib/messaging/protocol';

function makeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    translate: vi.fn(async (_cfg: any, texts: string[]) => ({
      translations: texts.map(t => `译:${t}`),
      useJsonFormat: true,
    })),
    getCached: vi.fn(async () => undefined),
    setCached: vi.fn(async () => {}),
    getSettings: vi.fn(async () => ({
      baseUrl: 'https://api.test.com', apiKey: 'sk-x', model: 'm1',
      systemPrompt: 'SYS', targetLang: '中文',
    })),
    jsonFormatSupported: { value: true },
    ...overrides,
  } as unknown as SchedulerDeps;
}

const REQ: TranslateRequest = {
  kind: 'translate', taskId: 't1', chunkId: 'c1',
  units: [
    { paragraphId: 'p0', text: 'Hello world.', sliceIndex: 0, sliceTotal: 1 },
    { paragraphId: 'p1', text: 'Goodbye world.', sliceIndex: 0, sliceTotal: 1 },
  ],
};

describe('handleTranslateRequest', () => {
  it('正常路径：调 LLM、写缓存、返回结果', async () => {
    const deps = makeDeps();
    const r = await handleTranslateRequest(REQ, deps);
    expect(r.kind).toBe('result');
    if (r.kind === 'result') {
      expect(r.translations.map(t => t.text)).toEqual(['译:Hello world.', '译:Goodbye world.']);
    }
    expect(deps.setCached).toHaveBeenCalledTimes(2);
  });

  it('缓存命中的段落不调 LLM', async () => {
    const deps = makeDeps({
      getCached: vi.fn(async (key: string) => (key.includes('Hello') || true ? undefined : undefined)),
    });
    // 第一个段落命中缓存
    (deps.getCached as any).mockResolvedValueOnce('缓存译文').mockResolvedValueOnce(undefined);
    const r = await handleTranslateRequest(REQ, deps);
    expect(deps.translate).toHaveBeenCalledTimes(1);
    expect((deps.translate as any).mock.calls[0][1]).toEqual(['Goodbye world.']);
    expect(r.kind).toBe('result');
    if (r.kind === 'result') expect(r.translations[0]?.text).toBe('缓存译文');
  });

  it('AuthError 返回 code=auth 的错误响应', async () => {
    const { AuthError } = await import('../lib/translation/llm-client');
    const deps = makeDeps({ translate: vi.fn(async () => { throw new AuthError('401'); }) });
    const r = await handleTranslateRequest(REQ, deps);
    expect(r).toMatchObject({ kind: 'error', code: 'auth', taskId: 't1', chunkId: 'c1' });
  });

  it('其他异常返回 code=failed', async () => {
    const deps = makeDeps({ translate: vi.fn(async () => { throw new Error('LLM request failed: 500'); }) });
    const r = await handleTranslateRequest(REQ, deps);
    expect(r).toMatchObject({ kind: 'error', code: 'failed' });
  });

  it('400 降级后 jsonFormatSupported 被记忆', async () => {
    const deps = makeDeps({
      translate: vi.fn(async () => ({ translations: ['译:A', '译:B'], useJsonFormat: false })),
    });
    await handleTranslateRequest(REQ, deps);
    expect(deps.jsonFormatSupported.value).toBe(false);
  });

  it('null 译文（逐段补齐也失败）映射为 error', async () => {
    const deps = makeDeps({
      translate: vi.fn(async () => ({ translations: ['译:A', null], useJsonFormat: true })),
    });
    const r = await handleTranslateRequest(REQ, deps);
    expect(r).toMatchObject({ kind: 'error', code: 'failed' });
  });
});
