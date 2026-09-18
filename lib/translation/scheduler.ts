import type { TranslateRequest, TranslateResponse } from '../messaging/protocol';
import { translateUnits, AuthError, type LlmConfig } from './llm-client';
import { PROMPT_VERSION } from './prompt';
import { cacheKey } from '../cache/store';

export interface SchedulerDeps {
  translate: typeof translateUnits;
  getCached: (key: string) => Promise<string | undefined>;
  setCached: (key: string, translation: string, meta: { model: string; promptVersion: string }) => Promise<void>;
  getSettings: () => Promise<{ baseUrl: string; apiKey: string; model: string; systemPrompt: string; targetLang: string }>;
  jsonFormatSupported: { value: boolean };
}

export async function handleTranslateRequest(req: TranslateRequest, deps: SchedulerDeps): Promise<TranslateResponse> {
  const settings = await deps.getSettings();
  const cfg: LlmConfig = { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model };
  const texts = req.units.map(u => u.text);
  const keys = texts.map(t => cacheKey(t, PROMPT_VERSION, settings.model, settings.targetLang));

  const translations: (string | null)[] = new Array<string | null>(texts.length).fill(null);
  const pendingIdx: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const hit = await deps.getCached(keys[i]!);
    if (hit !== undefined) translations[i] = hit;
    else pendingIdx.push(i);
  }

  try {
    if (pendingIdx.length > 0) {
      const r = await deps.translate(cfg, pendingIdx.map(i => texts[i]!), {
        targetLang: settings.targetLang,
        systemPrompt: settings.systemPrompt,
        useJsonFormat: deps.jsonFormatSupported.value,
      });
      if (!r.useJsonFormat) deps.jsonFormatSupported.value = false;
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
    await deps.setCached(keys[i]!, translations[i]!, { model: settings.model, promptVersion: PROMPT_VERSION });
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
