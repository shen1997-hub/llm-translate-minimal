import { buildMessages, parseJsonResponse, parsePlainResponse, type ChatMessage } from './prompt';

export interface LlmConfig { baseUrl: string; apiKey: string; model: string }

export class AuthError extends Error {}
export class FormatUnsupportedError extends Error {}

interface Deps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }

const RETRY_DELAYS = [1000, 2000, 4000];
const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function chatCompletion(cfg: LlmConfig, messages: ChatMessage[], useJsonFormat: boolean, deps: Deps): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0.3 };
  if (useJsonFormat) body.response_format = { type: 'json_object' };
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content as string;
    }
    if (res.status === 401 || res.status === 403) throw new AuthError(`LLM auth failed: ${res.status}`);
    if (res.status === 400 && useJsonFormat) {
      const text = await res.text();
      if (/response_format/i.test(text)) throw new FormatUnsupportedError(text);
      throw new Error(`LLM bad request: ${text}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt]!);
      continue;
    }
    throw new Error(`LLM request failed: ${res.status}`);
  }
}

async function translateSingle(cfg: LlmConfig, text: string, opts: { targetLang: string; systemPrompt: string }, useJsonFormat: boolean, deps: Deps): Promise<string | null> {
  try {
    const content = await chatCompletion(cfg, buildMessages([text], opts.targetLang, opts.systemPrompt, useJsonFormat ? 'json' : 'plain'), useJsonFormat, deps);
    const parsed = useJsonFormat ? parseJsonResponse(content, 1) : parsePlainResponse(content, 1);
    return parsed?.[0] ?? null;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return null;
  }
}

export async function translateUnits(
  cfg: LlmConfig,
  texts: string[],
  opts: { targetLang: string; systemPrompt: string; useJsonFormat: boolean },
  deps: Deps = {},
): Promise<{ translations: (string | null)[]; useJsonFormat: boolean }> {
  let mode = opts.useJsonFormat;
  let content: string;
  try {
    content = await chatCompletion(cfg, buildMessages(texts, opts.targetLang, opts.systemPrompt, mode ? 'json' : 'plain'), mode, deps);
  } catch (e) {
    if (e instanceof FormatUnsupportedError) {
      mode = false;
      content = await chatCompletion(cfg, buildMessages(texts, opts.targetLang, opts.systemPrompt, 'plain'), false, deps);
    } else {
      throw e;
    }
  }
  const parsed = mode ? parseJsonResponse(content, texts.length) : parsePlainResponse(content, texts.length);
  const translations: (string | null)[] = parsed ?? new Array(texts.length).fill(null);
  // 缺项/解析失败 → 逐段补齐
  for (let i = 0; i < translations.length; i++) {
    if (translations[i] === null) {
      translations[i] = await translateSingle(cfg, texts[i]!, opts, mode, deps);
    }
  }
  return { translations, useJsonFormat: mode };
}
