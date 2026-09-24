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

// 供 globalSetup 启动的本地打桩服务：
// - /page 托管测试页（file:// 不注入 content script，必须走 http）
// - /chat/completions、/v1/messages 模拟 OpenAI/Claude；请求体 stream:true 时按 SSE 分帧返回
// - /__control 供用例切换失败模式/响应延迟/流式挂起（用例进程与 globalSetup 进程不同，只能走 HTTP 控制）；
//   带 stats=1 时响应并入 bodies（历次翻译请求的原始请求体，reset 清空，上限 MAX_RECORDED_BODIES 条）
// 附带 CORS 头：MV3 service worker 跨域 fetch 在无 host 权限时按 CORS 处理，保证 E2E 不依赖原生授权弹窗
export function startStubServer(port = STUB_PORT): http.Server {
  const pageHtml = fs.readFileSync(path.resolve('e2e/test-page.html'), 'utf8');
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
            if (wantsStream(body)) {
              void serveStream(res, corsHeaders, url.pathname, indices, state);
              return;
            }
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            if (url.pathname === '/v1/messages') {
              const text = indices.map((i) => `[${i}] 译文${i}`).join('\n\n');
              res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
            } else {
              const items = indices.map((i) => ({ i, t: `译文${i}` }));
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
  try {
    const parsed = JSON.parse(rawBody) as { messages?: { role?: string; content?: string }[] };
    const user = parsed.messages?.find((m) => m.role === 'user')?.content ?? '';
    const indices = [...new Set([...user.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
    return indices.sort((a, b) => a - b);
  } catch {
    return [0];
  }
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
function contentFrames(protocolPath: string, indices: number[]): string[] {
  const text = indices.map((i) => `[${i}] 译文${i}`).join('\n\n');
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
  state: StubState,
): Promise<void> {
  res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frames = contentFrames(protocolPath, indices);
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
