import { describe, it, expect, vi } from 'vitest';
import { handleTranslateRequest, handleLookupRequest, type SchedulerDeps } from '../lib/translation/scheduler';
import type { TranslateRequest, LookupRequest } from '../lib/messaging/protocol';
import { AuthError } from '../lib/translation/llm-client';

function makeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    translate: vi.fn(async (_cfg: any, texts: string[]) => ({
      translations: texts.map(t => `译:${t}`),
      useJsonFormat: true,
    })),
    getCached: vi.fn(async () => undefined),
    setCached: vi.fn(async () => {}),
    getSettings: vi.fn(async () => ({
      providers: [{
        id: 'pv-1', name: 'Test', protocol: 'openai', baseUrl: 'https://api.test.com',
        apiKey: 'sk-x', models: ['m1'], activeModel: 'm1',
      }],
      activeProviderId: 'pv-1',
      sourceLang: 'auto',
      systemPrompt: 'SYS', targetLang: '中文',
      blacklist: [], disabledSites: [], minLength: 20, cjkRatioThreshold: 0.3,
      baseUrl: '', apiKey: '', model: '',
    })),
    jsonFormatSupported: { value: true },
    lookup: vi.fn(async () => ({ word: 'raise', senses: [], related: [], contextual: 'x' })),
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

  it('无供应商时返回 code=auth 且不调用 LLM', async () => {
    const deps = makeDeps({
      getSettings: vi.fn(async () => ({
        providers: [], activeProviderId: '', sourceLang: 'auto',
        systemPrompt: 'SYS', targetLang: '中文',
        blacklist: [], disabledSites: [], minLength: 20, cjkRatioThreshold: 0.3,
        baseUrl: '', apiKey: '', model: '',
      })) as any,
    });
    const r = await handleTranslateRequest(REQ, deps);
    expect(r).toMatchObject({ kind: 'error', code: 'auth' });
    expect(deps.translate).not.toHaveBeenCalled();
  });

  it('使用解析后的供应商与模型，并透传 sourceLang', async () => {
    const deps = makeDeps();
    await handleTranslateRequest(REQ, deps);
    const call = (deps.translate as any).mock.calls[0];
    expect(call[0]).toEqual({ baseUrl: 'https://api.test.com', apiKey: 'sk-x', model: 'm1', protocol: 'openai' });
    expect(call[2].sourceLang).toBe('auto');
  });

  it('req.targetLang 覆盖：translate 与 cacheKey 均用覆盖值', async () => {
    const deps = makeDeps();
    await handleTranslateRequest({ ...REQ, targetLang: 'English' }, deps);
    const call = (deps.translate as any).mock.calls[0];
    expect(call[2].targetLang).toBe('English');
    const { cacheKey } = await import('../lib/cache/store');
    const { PROMPT_VERSION } = await import('../lib/translation/prompt');
    expect(deps.getCached).toHaveBeenCalledWith(cacheKey('Hello world.', PROMPT_VERSION, 'm1', 'English'));
  });

  it('缺省 targetLang 回退 settings.targetLang', async () => {
    const deps = makeDeps();
    await handleTranslateRequest(REQ, deps);
    const call = (deps.translate as any).mock.calls[0];
    expect(call[2].targetLang).toBe('中文');
  });

  it('cfg 透传供应商 protocol（claude）', async () => {
    const deps = makeDeps({
      getSettings: vi.fn(async () => ({
        providers: [{
          id: 'pv-1', name: 'Claude', protocol: 'claude', baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant', models: ['claude-x'], activeModel: 'claude-x',
        }],
        activeProviderId: 'pv-1', sourceLang: 'auto',
        systemPrompt: 'SYS', targetLang: '中文',
        blacklist: [], disabledSites: [], minLength: 20, cjkRatioThreshold: 0.3,
        baseUrl: '', apiKey: '', model: '',
      })) as any,
    });
    await handleTranslateRequest(REQ, deps);
    expect((deps.translate as any).mock.calls[0][0].protocol).toBe('claude');
  });

  it('claude 供应商恒 plain 返回不翻转 jsonFormatSupported', async () => {
    const deps = makeDeps({
      getSettings: vi.fn(async () => ({
        providers: [{
          id: 'pv-1', name: 'Claude', protocol: 'claude', baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-ant', models: ['claude-x'], activeModel: 'claude-x',
        }],
        activeProviderId: 'pv-1', sourceLang: 'auto',
        systemPrompt: 'SYS', targetLang: '中文',
        blacklist: [], disabledSites: [], minLength: 20, cjkRatioThreshold: 0.3,
        baseUrl: '', apiKey: '', model: '',
      })) as any,
      translate: vi.fn(async (_cfg: any, texts: string[]) => ({
        translations: texts.map(t => `译:${t}`),
        useJsonFormat: false,
      })),
    });
    const r = await handleTranslateRequest(REQ, deps);
    expect(r.kind).toBe('result');
    expect(deps.jsonFormatSupported.value).toBe(true);
  });

  it('流式：onDelta 的下标映射回 unit 的 paragraphId/sliceIndex', async () => {
    const seen: [string, number, number, string][] = [];
    const deps = makeDeps({
      translate: vi.fn(async (_cfg: any, texts: string[], _opts: any, _deps: any, onDelta?: any) => {
        onDelta?.(1, '乙');
        onDelta?.(0, '甲');
        return { translations: texts.map((t: string) => `译:${t}`), useJsonFormat: false };
      }),
    });
    const r = await handleTranslateRequest({ ...REQ, stream: true }, deps, (p, s, st, t) => seen.push([p, s, st, t]));
    expect(r.kind).toBe('result');
    expect(seen).toEqual([['p1', 0, 1, '乙'], ['p0', 0, 1, '甲']]);
  });

  it('流式：缓存命中的段落不产生 delta，但下标仍对齐', async () => {
    const seen: [string, string][] = [];
    const deps = makeDeps({
      getCached: (vi.fn(async () => undefined) as any)
        .mockResolvedValueOnce('缓存译文')
        .mockResolvedValueOnce(undefined),
      translate: vi.fn(async (_cfg: any, texts: string[], _opts: any, _deps: any, onDelta?: any) => {
        expect(texts).toEqual(['Goodbye world.']); // 只翻未命中的那段
        onDelta?.(0, '乙');
        return { translations: ['译:Goodbye world.'], useJsonFormat: false };
      }),
    });
    await handleTranslateRequest({ ...REQ, stream: true }, deps, (p, _s, _st, t) => seen.push([p, t]));
    expect(seen).toEqual([['p1', '乙']]);
  });

  it('流式：即使返回 useJsonFormat=false 也不翻转 jsonFormatSupported', async () => {
    const deps = makeDeps({
      translate: vi.fn(async (_cfg: any, texts: string[], opts: any) => {
        expect(opts.useJsonFormat).toBe(false); // 流式恒 plain
        return { translations: texts.map((t: string) => `译:${t}`), useJsonFormat: false };
      }),
    });
    // mock 里的断言一旦不成立会抛错，被调度器的 catch 吞成 error 响应——必须断言是 result，
    // 否则这条用例在实现之前也会「通过」
    const r = await handleTranslateRequest({ ...REQ, stream: true }, deps, () => {});
    expect(r.kind).toBe('result');
    expect(deps.jsonFormatSupported.value).toBe(true);
  });

  it('非流式请求（无 onDelta）行为不变：仍按 useJsonFormat=false 记忆降级', async () => {
    const deps = makeDeps({
      translate: vi.fn(async (_cfg: any, texts: string[], opts: any, _deps: any, onDelta?: any) => {
        expect(opts.useJsonFormat).toBe(true); // 非流式仍尊重全局记忆
        expect(onDelta).toBeUndefined(); // 没传 onDelta 就不该传下去
        return { translations: texts.map((t: string) => `译:${t}`), useJsonFormat: false };
      }),
    });
    const r = await handleTranslateRequest(REQ, deps);
    expect(r.kind).toBe('result');
    expect(deps.jsonFormatSupported.value).toBe(false);
  });

  it('req.stream 缺省时不传 onDelta（老链路不变成流式）', async () => {
    const deps = makeDeps({
      translate: vi.fn(async (_cfg: any, texts: string[], _opts: any, _deps: any, onDelta?: any) => {
        expect(onDelta).toBeUndefined();
        return { translations: texts.map((t: string) => `译:${t}`), useJsonFormat: true };
      }),
    });
    const r = await handleTranslateRequest(REQ, deps, () => {});
    expect(r.kind).toBe('result');
    expect(deps.jsonFormatSupported.value).toBe(true);
  });
});

const LOOKUP_REQ: LookupRequest = { kind: 'lookup', taskId: 'sel-1', word: 'raise', sentence: 'Please raise your hand.' };

describe('handleLookupRequest', () => {
  it('正常路径：返回 lookup-result，word 为空时回填请求词', async () => {
    const deps = makeDeps();
    (deps.lookup as any).mockResolvedValue({ word: '', senses: [{ pos: 'v.', meaning: '举起' }], related: [], contextual: '本句指举起手' });
    const r = await handleLookupRequest(LOOKUP_REQ, deps);
    expect(r.kind).toBe('lookup-result');
    if (r.kind === 'lookup-result') {
      expect(r.entry.word).toBe('raise');
      expect(r.entry.contextual).toBe('本句指举起手');
    }
  });

  it('解析失败（null）返回 failed 错误', async () => {
    const deps = makeDeps();
    (deps.lookup as any).mockResolvedValue(null);
    const r = await handleLookupRequest(LOOKUP_REQ, deps);
    expect(r).toEqual({ kind: 'error', taskId: 'sel-1', code: 'failed', message: '词典响应解析失败，请重试' });
  });

  it('AuthError 返回 auth 错误', async () => {
    const deps = makeDeps();
    (deps.lookup as any).mockRejectedValue(new AuthError('LLM auth failed: 401'));
    const r = await handleLookupRequest(LOOKUP_REQ, deps);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.code).toBe('auth');
  });

  it('未配置供应商返回 auth 错误', async () => {
    const deps = makeDeps();
    (deps.getSettings as any).mockResolvedValue({
      providers: [], activeProviderId: '', sourceLang: 'auto', systemPrompt: 'SYS',
      targetLang: '中文', blacklist: [], disabledSites: [], minLength: 20,
      cjkRatioThreshold: 0.3, selectionTranslate: true, baseUrl: '', apiKey: '', model: '',
    });
    const r = await handleLookupRequest(LOOKUP_REQ, deps);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.code).toBe('auth');
  });
});
