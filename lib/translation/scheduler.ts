import type { TranslateRequest, TranslateResponse, LookupRequest, LookupResponse } from '../messaging/protocol';
import { translateUnits, lookupWord, AuthError, type LlmConfig } from './llm-client';
import { PROMPT_VERSION } from './prompt';
import { cacheKey } from '../cache/store';
import { getActiveProvider, resolveModel } from '../settings';
import type { Settings } from '../settings';

export interface SchedulerDeps {
  translate: typeof translateUnits;
  lookup: typeof lookupWord;
  getCached: (key: string) => Promise<string | undefined>;
  setCached: (key: string, translation: string, meta: { model: string; promptVersion: string }) => Promise<void>;
  getSettings: () => Promise<Settings>;
  jsonFormatSupported: { value: boolean };
}

export type DeltaSink = (paragraphId: string, sliceIndex: number, sliceTotal: number, text: string) => void;

export async function handleTranslateRequest(
  req: TranslateRequest,
  deps: SchedulerDeps,
  onDelta?: DeltaSink,
): Promise<TranslateResponse> {
  const settings = await deps.getSettings();
  const provider = getActiveProvider(settings);
  if (!provider) {
    return { kind: 'error', taskId: req.taskId, chunkId: req.chunkId, code: 'auth', message: '尚未配置 API 供应商，请前往设置页添加' };
  }
  const cfg: LlmConfig = { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: resolveModel(provider), protocol: provider.protocol };
  const targetLang = req.targetLang ?? settings.targetLang;
  const texts = req.units.map(u => u.text);
  const keys = texts.map(t => cacheKey(t, PROMPT_VERSION, cfg.model, targetLang));

  // 只有请求显式要求流式、且调用方提供了回调时才走流式；其余保持一次性响应
  const streaming = req.stream === true && onDelta !== undefined;

  const translations: (string | null)[] = new Array<string | null>(texts.length).fill(null);
  const pendingIdx: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = await deps.getCached(keys[i]!);
    if (hit !== undefined) translations[i] = hit;
    else pendingIdx.push(i);
  }

  try {
    if (pendingIdx.length > 0) {
      const r = await deps.translate(
        cfg,
        pendingIdx.map(i => texts[i]!),
        {
          targetLang,
          systemPrompt: settings.systemPrompt,
          useJsonFormat: streaming ? false : deps.jsonFormatSupported.value,
          sourceLang: settings.sourceLang,
        },
        {},
        // demux 的下标对应 pendingIdx 的第 k 个元素，这里映射回该 unit 的段落与分片信息
        streaming
          ? (k: number, text: string) => {
              const u = req.units[pendingIdx[k]!]!;
              onDelta!(u.paragraphId, u.sliceIndex, u.sliceTotal, text);
            }
          : undefined,
      );
      // 流式恒 plain 是「流式解析的必然」而非「该供应商不支持 json」，
      // 写进全局记忆会把后续非流式请求也永久降级（见 d952590 / 6f7b392）
      if (!streaming && !r.useJsonFormat && provider.protocol !== 'claude') deps.jsonFormatSupported.value = false;
      for (let k = 0; k < pendingIdx.length; k++) {
        translations[pendingIdx[k]!] = r.translations[k] ?? null;
      }
    }
  } catch (e) {
    if (e instanceof AuthError) {
      return { kind: 'error', taskId: req.taskId, chunkId: req.chunkId, code: 'auth', message: 'API Key 无效或权限不足，请检查设置页' };
    }
    return { kind: 'error', taskId: req.taskId, chunkId: req.chunkId, code: 'failed', message: e instanceof Error ? e.message : String(e) };
  }

  if (translations.some(t => t === null)) {
    return { kind: 'error', taskId: req.taskId, chunkId: req.chunkId, code: 'failed', message: '部分段落翻译失败（重试与逐段降级均未成功）' };
  }

  for (const i of pendingIdx) {
    await deps.setCached(keys[i]!, translations[i]!, { model: cfg.model, promptVersion: PROMPT_VERSION });
  }

  return {
    kind: 'result',
    taskId: req.taskId,
    chunkId: req.chunkId,
    translations: req.units.map((u, i) => ({
      paragraphId: u.paragraphId,
      sliceIndex: u.sliceIndex,
      sliceTotal: u.sliceTotal,
      text: translations[i]!,
    })),
  };
}

export async function handleLookupRequest(
  req: LookupRequest,
  deps: SchedulerDeps,
): Promise<LookupResponse> {
  const settings = await deps.getSettings();
  const provider = getActiveProvider(settings);
  if (!provider) {
    return { kind: 'error', taskId: req.taskId, code: 'auth', message: '尚未配置 API 供应商，请前往设置页添加' };
  }
  const cfg: LlmConfig = { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: resolveModel(provider), protocol: provider.protocol };
  try {
    const entry = await deps.lookup(cfg, req.word, req.sentence, {
      targetLang: req.targetLang ?? settings.targetLang,
      useJsonFormat: deps.jsonFormatSupported.value,
    });
    if (!entry) return { kind: 'error', taskId: req.taskId, code: 'failed', message: '词典响应解析失败，请重试' };
    if (entry.word === '') entry.word = req.word;
    return { kind: 'lookup-result', taskId: req.taskId, entry };
  } catch (e) {
    if (e instanceof AuthError) {
      return { kind: 'error', taskId: req.taskId, code: 'auth', message: 'API Key 无效或权限不足，请检查设置页' };
    }
    return { kind: 'error', taskId: req.taskId, code: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}
