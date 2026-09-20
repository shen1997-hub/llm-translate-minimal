import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const STUB_PORT = 4789;
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;

interface StubState {
  fail: boolean;
  delayMs: number;
}

// 供 globalSetup 启动的本地打桩服务：
// - /page 托管测试页（file:// 不注入 content script，必须走 http）
// - /chat/completions 模拟 OpenAI 兼容接口，按请求里的 [i] 标记回固定译文
// - /__control 供用例切换失败模式/响应延迟（用例进程与 globalSetup 进程不同，只能走 HTTP 控制）
// 附带 CORS 头：MV3 service worker 跨域 fetch 在无 host 权限时按 CORS 处理，保证 E2E 不依赖原生授权弹窗
export function startStubServer(port = STUB_PORT): http.Server {
  const pageHtml = fs.readFileSync(path.resolve('e2e/test-page.html'), 'utf8');
  const state: StubState = { fail: false, delayMs: 0 };

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
        }
        if (url.searchParams.has('fail')) state.fail = url.searchParams.get('fail') === '1';
        if (url.searchParams.has('delay')) state.delayMs = Number(url.searchParams.get('delay')) || 0;
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(state));
        return;
      }

      if ((url.pathname === '/chat/completions' || url.pathname === '/v1/messages') && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          setTimeout(() => {
            if (state.fail) {
              // 400 不触发 429/5xx 退避，立即使整个分块失败（用于「失败段落可重试」用例）
              res.writeHead(400, { ...corsHeaders, 'Content-Type': 'text/plain' });
              res.end('forced failure for e2e');
              return;
            }
            const indices = collectIndices(body);
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
