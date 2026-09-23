import { buildMessages, buildLookupMessages, parseJsonResponse, parseLookupResponse, parsePlainResponse, type ChatMessage, type WordEntry } from './prompt';
import { readSse } from './sse';
import { createMarkerDemux } from './marker-demux';
import type { ApiProtocol } from '../settings';

export interface LlmConfig { baseUrl: string; apiKey: string; model: string; protocol: ApiProtocol }

export class AuthError extends Error {}
export class FormatUnsupportedError extends Error {}

interface Deps { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }
export type DeltaHandler = (unitIndex: number, text: string) => void;

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

// 请求构造只有这一处：非流式与流式的差别仅为 body 里的 stream 字段
function buildRequest(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: { useJsonFormat: boolean; stream: boolean },
): { url: string; init: RequestInit } {
  if (cfg.protocol === 'claude') {
    const system = messages.find(m => m.role === 'system')?.content ?? '';
    const user = messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
    return {
      url: `${cfg.baseUrl}/v1/messages`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: cfg.model, max_tokens: 4096, system,
          messages: [{ role: 'user', content: user }], temperature: 0.3,
          ...(opts.stream ? { stream: true } : {}),
        }),
      },
    };
  }
  const body: Record<string, unknown> = { model: cfg.model, messages, temperature: 0.3 };
  if (opts.useJsonFormat) body.response_format = { type: 'json_object' };
  if (opts.stream) body.stream = true;
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    },
  };
}

async function chatCompletion(
  cfg: LlmConfig,
  messages: ChatMessage[],
  useJsonFormat: boolean,
  deps: Deps,
): Promise<string> {
  const { url, init } = buildRequest(cfg, messages, { useJsonFormat: useJsonFormat && cfg.protocol !== 'claude', stream: false });
  const res = await requestWithRetry((f) => f(url, init), deps);
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && useJsonFormat && cfg.protocol !== 'claude' && /response_format/i.test(text)) {
      throw new FormatUnsupportedError(text);
    }
    throw new Error(`LLM request failed: ${res.status}: ${text}`);
  }
  if (cfg.protocol === 'claude') {
    const data = await res.json();
    const blocks = data.content as { type?: string; text?: string }[] | undefined;
    // 无 text 块 → 返回空串，让上层按解析失败走逐段补齐
    return blocks?.find(b => b.type === 'text')?.text ?? '';
  }
  const data = await res.json();
  return data.choices[0].message.content as string;
}

// 从一帧 SSE data 里取增量文本；非增量帧（role 帧、ping、message_start 等）返回空串
function pickDelta(protocol: ApiProtocol, data: string): string {
  let obj: { [k: string]: any };
  try {
    obj = JSON.parse(data);
  } catch {
    return '';
  }
  if (protocol === 'claude') {
    if (obj?.type !== 'content_block_delta') return '';
    return typeof obj?.delta?.text === 'string' ? obj.delta.text : '';
  }
  const c = obj?.choices?.[0]?.delta?.content;
  return typeof c === 'string' ? c : '';
}

// 流式请求：只把增量喂给 onText，正文由调用方的 demux 负责组装
async function chatCompletionStream(
  cfg: LlmConfig,
  messages: ChatMessage[],
  deps: Deps,
  onText: (text: string) => void,
): Promise<void> {
  const { url, init } = buildRequest(cfg, messages, { useJsonFormat: false, stream: true });
  const res = await requestWithRetry((f) => f(url, init), deps);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed: ${res.status}: ${text}`);
  }
  await readSse(res, (data) => {
    const t = pickDelta(cfg.protocol, data);
    if (t !== '') onText(t);
  });
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

// 流式：恒 plain 标记模式（JSON 无法增量解复用），结束后仍以解析出的全文为准，
// 缺段走既有逐段补齐（补齐是非流式请求）。
async function translateUnitsStreaming(
  cfg: LlmConfig,
  texts: string[],
  opts: { targetLang: string; systemPrompt: string; sourceLang?: string },
  deps: Deps,
  onDelta: DeltaHandler,
): Promise<{ translations: (string | null)[]; useJsonFormat: boolean }> {
  const demux = createMarkerDemux(texts.length, onDelta);
  await chatCompletionStream(
    cfg,
    buildMessages(texts, opts.targetLang, opts.systemPrompt, 'plain', opts.sourceLang),
    deps,
    (t) => demux.push(t),
  );
  const parsed = parsePlainResponse(demux.finish(), texts.length);
  const translations: (string | null)[] = parsed ?? new Array(texts.length).fill(null);
  for (let i = 0; i < translations.length; i++) {
    if (translations[i] === null) translations[i] = await translateSingle(cfg, texts[i]!, opts, false, deps);
  }
  return { translations, useJsonFormat: false };
}

export async function translateUnits(
  cfg: LlmConfig,
  texts: string[],
  opts: { targetLang: string; systemPrompt: string; useJsonFormat: boolean; sourceLang?: string },
  deps: Deps = {},
  onDelta?: DeltaHandler,
): Promise<{ translations: (string | null)[]; useJsonFormat: boolean }> {
  if (onDelta) return translateUnitsStreaming(cfg, texts, opts, deps, onDelta);

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

// 词典查询：一次性请求（词条内容短，不做流式）。解析失败返回 null，由调用方报 failed；
// response_format 不支持时沿用翻译链路的 plain 降级。
export async function lookupWord(
  cfg: LlmConfig,
  word: string,
  sentence: string,
  opts: { targetLang: string; useJsonFormat: boolean },
  deps: Deps = {},
): Promise<WordEntry | null> {
  let mode = opts.useJsonFormat && cfg.protocol !== 'claude'; // Claude 无 response_format
  let content: string;
  try {
    content = await chatCompletion(cfg, buildLookupMessages(word, sentence, opts.targetLang), mode, deps);
  } catch (e) {
    if (e instanceof FormatUnsupportedError) {
      mode = false;
      content = await chatCompletion(cfg, buildLookupMessages(word, sentence, opts.targetLang), false, deps);
    } else {
      throw e;
    }
  }
  return parseLookupResponse(content);
}