import { buildMessages, parseJsonResponse, parsePlainResponse, type ChatMessage } from './prompt';
import type { ApiProtocol } from '../settings';

export interface LlmConfig { baseUrl: string; apiKey: string; model: string; protocol: ApiProtocol }

export class AuthError extends Error {}
export class FormatUnsupportedError extends Error {}

interface Deps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }

const RETRY_DELAYS = [1000, 2000, 4000];
const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// 共用的重试循环：401/403 → AuthError；429/5xx 退避 [1s,2s,4s]；其余错误直接抛
async function requestWithRetry(
  doFetch: (fetchImpl: typeof fetch) => Promise<Response>,
  deps: Deps,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(fetchImpl);
    if (res.ok) return res;
    if (res.status === 401 || res.status === 403) throw new AuthError(`LLM auth failed: ${res.status}`);
    if ((res.status === 429 || res.status >= 500) && attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt]!);
      continue;
    }
    return res; // 4xx（非 401/403）交回调用方读 body 抛错
  }
}

async function openaiChat(cfg: LlmConfig, messages: ChatMessage[], useJsonFormat: boolean, deps: Deps): Promise<string> {
  const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0.3 };
  if (useJsonFormat) body.response_format = { type: 'json_object' };
  const res = await requestWithRetry(
    (f) => f(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    }),
    deps,
  );
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && useJsonFormat && /response_format/i.test(text)) throw new FormatUnsupportedError(text);
    throw new Error(`LLM request failed: ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.choices[0].message.content as string;
}

async function claudeChat(cfg: LlmConfig, messages: ChatMessage[], deps: Deps): Promise<string> {
  const system = messages.find(m => m.role === 'system')?.content ?? '';
  const user = messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
  const body = {
    model: cfg.model, max_tokens: 4096, system,
    messages: [{ role: 'user', content: user }], temperature: 0.3,
  };
  const res = await requestWithRetry(
    (f) => f(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed: ${res.status}: ${text}`);
  }
  const data = await res.json();
  const blocks = data.content as { type?: string; text?: string }[] | undefined;
  // 无 text 块 → 返回空串，让上层按解析失败走逐段补齐
  return blocks?.find(b => b.type === 'text')?.text ?? '';
}

async function chatCompletion(cfg: LlmConfig, messages: ChatMessage[], useJsonFormat: boolean, deps: Deps): Promise<string> {
  return cfg.protocol === 'claude' ? claudeChat(cfg, messages, deps) : openaiChat(cfg, messages, useJsonFormat, deps);
}

async function translateSingle(cfg: LlmConfig, text: string, opts: { targetLang: string; systemPrompt: string; sourceLang?: string }, useJsonFormat: boolean, deps: Deps): Promise<string | null> {
  try {
    const content = await chatCompletion(cfg, buildMessages([text], opts.targetLang, opts.systemPrompt, useJsonFormat ? 'json' : 'plain', opts.sourceLang), useJsonFormat, deps);
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
  opts: { targetLang: string; systemPrompt: string; useJsonFormat: boolean; sourceLang?: string },
  deps: Deps = {},
): Promise<{ translations: (string | null)[]; useJsonFormat: boolean }> {
  let mode = opts.useJsonFormat && cfg.protocol !== 'claude'; // Claude 无 response_format，强制 plain
  let content: string;
  try {
    content = await chatCompletion(cfg, buildMessages(texts, opts.targetLang, opts.systemPrompt, mode ? 'json' : 'plain', opts.sourceLang), mode, deps);
  } catch (e) {
    if (e instanceof FormatUnsupportedError) {
      mode = false;
      content = await chatCompletion(cfg, buildMessages(texts, opts.targetLang, opts.systemPrompt, 'plain', opts.sourceLang), false, deps);
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
