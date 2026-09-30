import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const STUB_PORT = 4789;
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;

interface StubState {
  fail: boolean;
  delayMs: number;
  holdStream: boolean;
  releaseStream: boolean;
  bodies: string[];
}

const MAX_RECORDED_BODIES = 100;

const STREAM_FRAME_GAP_MS = 30;

// 演示页（/demo）特征标记：请求体里出现演示文标题即视为演示模式。
// 视口惰性调度会分批发送，标题只出现在第一批里，故另有「任一段命中映射表」兜住后续批次，
// 两条路径都不可能与 test-page.html 的请求冲突（它们的正文不在映射表里）。
const DEMO_MARKER = 'The Quiet Rise of Small Language Models';

// 演示页「源文前缀 → 中文译文」映射：按**源文内容前缀**匹配，不按 `[i]` 序号——
// 分批发送时序号每批从 0 重新计，只有内容匹配是稳定的。未收录的段落回退 `译文i`
// （translate.spec.ts 的流式用例断言该格式，回退逻辑必须原样保留）。
const DEMO_TRANSLATIONS: [prefix: string, translation: string][] = [
  [
    'The Quiet Rise of Small Language Models',
    '小型语言模型的悄然崛起',
  ],
  [
    'For years, the story of artificial intelligence was a story of scale.',
    '多年来，人工智能的故事一直是一个关于规模的故事：更大的模型、更大的集群、更大的预算。但过去一年里，一件有意思的事发生了——小型语言模型已经悄悄变得足以应付日常工作。',
  ],
  [
    'Translation is the clearest example.',
    '翻译是最清楚的例子。一个跑在免费额度上的七十亿参数模型，如今生成的网页双语翻译，已经能媲美两年前订阅服务的水准。瓶颈不再是模型的智能，而是工程上的管道。',
  ],
  [
    'That plumbing is exactly what browser extensions provide.',
    '而浏览器扩展补上的，正是这段管道。你不再需要把文本粘进聊天窗口：扩展自己会找到正文，把每个段落交给模型，再把译文直接放在原文下方。',
  ],
  [
    'Bring your own API key',
    '带上你自己的 API Key',
  ],
  [
    'The economics are surprisingly friendly.',
    '成本出乎意料地友好。许多供应商提供额度宽松的免费模型，而像 DeepSeek 这样的付费模型，重度阅读一个月也花不到一杯咖啡的钱。你按用量付费，而不是买一份固定订阅。',
  ],
  [
    'Privacy improves too.',
    '隐私也变好了。你的 API Key 只存在浏览器本地，也只与你配置的供应商通信；没有中间服务器在悄悄收集你的阅读记录。',
  ],
  [
    'A companion, not a toolbar',
    '是伙伴，不是工具栏',
  ],
  [
    'Good tools should feel alive.',
    '好的工具应该是有生命的。选中一句话，一只小猫就会跑到你的光标旁，提出只翻译这一小段。这只是一点小小的惊喜，但正是这些小惊喜，决定了我们留下哪些工具、又放弃哪些。',
  ],
  [
    'The web was always meant to be read in every language.',
    '互联网本来就该能用任何语言阅读。当一个够用的模型就在手边，浏览器里又有这样一个轻量的扩展，这个承诺终于触手可及。',
  ],
];

// 供 globalSetup 启动的本地打桩服务：
// - /page 托管测试页、/demo 托管演示落地页（file:// 不注入 content script，必须走 http）
// - /chat/completions、/v1/messages 模拟 OpenAI/Claude；请求体 stream:true 时按 SSE 分帧返回；
//   来自 /demo 的请求（请求体含演示文标题）按 DEMO_TRANSLATIONS 返回真实中文译文，供推广素材录制
// - /__control 供用例切换失败模式/响应延迟/流式挂起（用例进程与 globalSetup 进程不同，只能走 HTTP 控制）；
//   带 stats=1 时响应并入 bodies（历次翻译请求的原始请求体，reset 清空，上限 MAX_RECORDED_BODIES 条）
// 附带 CORS 头：MV3 service worker 跨域 fetch 在无 host 权限时按 CORS 处理，保证 E2E 不依赖原生授权弹窗
export function startStubServer(port = STUB_PORT): http.Server {
  const pageHtml = fs.readFileSync(path.resolve('e2e/test-page.html'), 'utf8');
  const demoHtml = fs.readFileSync(path.resolve('e2e/demo-page.html'), 'utf8');
  const state: StubState = { fail: false, delayMs: 0, holdStream: false, releaseStream: false, bodies: [] };

  return http
    .createServer((req, res) => {
      const corsHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', STUB_ORIGIN);

      if (url.pathname === '/page') {
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pageHtml);
        return;
      }

      if (url.pathname === '/demo') {
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(demoHtml);
        return;
      }

      if (url.pathname === '/__control') {
        if (url.searchParams.has('reset')) {
          state.fail = false;
          state.delayMs = 0;
          state.holdStream = false;
          state.releaseStream = false;
          state.bodies = [];
        }
        if (url.searchParams.has('fail')) state.fail = url.searchParams.get('fail') === '1';
        if (url.searchParams.has('delay')) state.delayMs = Number(url.searchParams.get('delay')) || 0;
        if (url.searchParams.has('hold')) state.holdStream = url.searchParams.get('hold') === '1';
        if (url.searchParams.has('release')) state.releaseStream = url.searchParams.get('release') === '1';
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        if (url.searchParams.has('stats')) {
          res.end(JSON.stringify(state));
        } else {
          const { bodies: _bodies, ...flags } = state;
          res.end(JSON.stringify(flags));
        }
        return;
      }

      if ((url.pathname === '/chat/completions' || url.pathname === '/v1/messages') && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          state.bodies.push(body);
          if (state.bodies.length > MAX_RECORDED_BODIES) state.bodies.shift();
          setTimeout(() => {
            if (state.fail) {
              // 400 不触发 429/5xx 退避，立即使整个分块失败（用于「失败段落可重试」用例）
              res.writeHead(400, { ...corsHeaders, 'Content-Type': 'text/plain' });
              res.end('forced failure for e2e');
              return;
            }
            const indices = collectIndices(body);
            const translations = segmentTranslations(body, indices);
            if (wantsStream(body)) {
              void serveStream(res, corsHeaders, url.pathname, indices, translations, state);
              return;
            }
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            if (url.pathname === '/v1/messages') {
              res.end(JSON.stringify({ content: [{ type: 'text', text: plainContent(indices, translations) }] }));
            } else {
              const items = indices.map((i, k) => ({ i, t: translations[k]! }));
              res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }));
            }
          }, state.delayMs);
        });
        return;
      }

      res.writeHead(404, corsHeaders);
      res.end();
    })
    .listen(port, '127.0.0.1');
}

// 请求体是 JSON：messages 中 user 内容的各段以 "[i] text" 形式编号
function collectIndices(rawBody: string): number[] {
  const user = userContent(rawBody);
  if (user === null) return [0];
  const indices = [...new Set([...user.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
  return indices.sort((a, b) => a - b);
}

// user 角色的原文内容；请求体不可解析时返回 null（沿用 collectIndices 的 [0] 兜底语义）
function userContent(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { messages?: { role?: string; content?: string }[] };
    return parsed.messages?.find((m) => m.role === 'user')?.content ?? '';
  } catch {
    return null;
  }
}

// 从 "[i] 源文" 形式的用户消息里切出每段源文（切法同 lib/translation/prompt.ts 的 parsePlainResponse）
function collectSegmentSources(user: string | null): Map<number, string> {
  const sources = new Map<number, string>();
  if (user === null) return sources;
  const marks = [...user.matchAll(/\[(\d+)\]\s*/g)];
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k]!;
    const start = m.index! + m[0].length;
    const end = k + 1 < marks.length ? marks[k + 1]!.index! : user.length;
    sources.set(Number(m[1]), user.slice(start, end).replace(/\s+/g, ' ').trim());
  }
  return sources;
}

function matchDemoTranslation(source: string | undefined): string | undefined {
  if (!source) return undefined;
  return DEMO_TRANSLATIONS.find(([prefix]) => source.startsWith(prefix))?.[1];
}

// 三条响应路径（OpenAI JSON items / Claude 纯文本 / SSE 流式）共用的逐段译文：
// 命中演示映射表返回中文译文，否则回退 `译文i`
function segmentTranslations(rawBody: string, indices: number[]): string[] {
  const sources = collectSegmentSources(userContent(rawBody));
  const hit = rawBody.includes(DEMO_MARKER) || indices.some((i) => matchDemoTranslation(sources.get(i)));
  return indices.map((i) => (hit ? matchDemoTranslation(sources.get(i)) : undefined) ?? `译文${i}`);
}

// 纯文本标记格式：客户端按 "[i] 译文" 块解析（lib/translation/prompt.ts parsePlainResponse）
function plainContent(indices: number[], translations: string[]): string {
  return indices.map((i, k) => `[${i}] ${translations[k]}`).join('\n\n');
}

function wantsStream(rawBody: string): boolean {
  try {
    return (JSON.parse(rawBody) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

// 把 "[i] 译文i" 全文切成 3 帧：客户端应能只靠前两帧就渲染出各段的前缀，
// 最后一帧留作 hold/release 的把手（用例借此拿到稳定可断言的中间态）。
function contentFrames(protocolPath: string, indices: number[], translations: string[]): string[] {
  const text = plainContent(indices, translations);
  const size = Math.ceil(text.length / 3) || 1;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.map((p) =>
    protocolPath === '/v1/messages'
      ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: p } })}\n\n`
      : `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`,
  );
}

function terminator(protocolPath: string): string {
  return protocolPath === '/v1/messages'
    ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    : 'data: [DONE]\n\n';
}

async function serveStream(
  res: http.ServerResponse,
  corsHeaders: Record<string, string>,
  protocolPath: string,
  indices: number[],
  translations: string[],
  state: StubState,
): Promise<void> {
  res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frames = contentFrames(protocolPath, indices, translations);
  for (let i = 0; i < frames.length; i++) {
    const isLast = i === frames.length - 1;
    if (isLast && state.holdStream && !state.releaseStream) {
      const deadline = Date.now() + 20_000;
      while (!state.releaseStream && Date.now() < deadline) {
        if (res.destroyed) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      if (res.destroyed) return;
    }
    res.write(frames[i]!);
    if (!isLast) await new Promise((r) => setTimeout(r, STREAM_FRAME_GAP_MS));
  }
  res.write(terminator(protocolPath));
  res.end();
}
