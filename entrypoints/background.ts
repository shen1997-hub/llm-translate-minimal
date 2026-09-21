import { handleTranslateRequest } from '../lib/translation/scheduler';
import { translateUnits } from '../lib/translation/llm-client';
import { getCached, setCached } from '../lib/cache/store';
import { getSettings } from '../lib/settings';
import type { StartTabRequest, StartTabResponse, TranslateRequest, TranslateResponse } from '../lib/messaging/protocol';

// WXT 固定把 entrypoints/content.ts 构建到此路径（与 manifest content_scripts.js 一致），
// 重命名入口文件时需同步这里。
const CONTENT_SCRIPT_FILE = 'content-scripts/content.js';

// 并发计数在内存中，属 best-effort：SW 重启后重置，超限由 API 侧 429 + 退避兜底
let inFlight = 0;
const waiters: (() => void)[] = [];
const jsonFormatSupported = { value: true };

async function acquire(): Promise<void> {
  if (inFlight < 3) { inFlight++; return; }
  await new Promise<void>(r => waiters.push(r));
  inFlight++;
}
function release(): void {
  inFlight--;
  waiters.shift()?.();
}

async function sendStart(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'start' });
    return true;
  } catch {
    return false; // 无接收端:content script 未注入或已孤儿化
  }
}

/**
 * 触发整页翻译。content script 只在页面导航时注入,所以「扩展安装/更新前就已打开」
 * 的页面没有活的接收端(tabs.sendMessage 会失败)。此时用 scripting 对当前文档补注入
 * content script(WXT 构建产物执行时会立即运行 main 注册监听),再重试一次 start。
 */
async function startTab(tabId: number): Promise<StartTabResponse> {
  if (await sendStart(tabId)) return { ok: true };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
  } catch {
    return { ok: false, reason: 'inject-failed' }; // chrome:// 等浏览器保留页面
  }
  return (await sendStart(tabId)) ? { ok: true, injected: true } : { ok: false, reason: 'retry-failed' };
}

export default defineBackground(() => {
  console.log('[llm-tr] background SW started'); // [diag]
  chrome.runtime.onMessage.addListener((msg: StartTabRequest, _sender, sendResponse) => {
    if (msg?.kind !== 'start-tab') return; // 其他 kind 由 content/popup 的监听器处理
    void startTab(msg.tabId).then(sendResponse);
    return true; // 异步应答
  });
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'translate') return;
    console.log('[llm-tr] port connected'); // [diag]
    port.onMessage.addListener(async (msg: TranslateRequest) => {
      if (msg.kind !== 'translate') return;
      console.log('[llm-tr] SW received chunk', msg.chunkId, 'units =', msg.units.length); // [diag]
      await acquire();
      try {
        const response: TranslateResponse = await handleTranslateRequest(
          msg,
          {
            translate: translateUnits,
            getCached,
            setCached,
            getSettings,
            jsonFormatSupported,
          },
          msg.stream
            ? (paragraphId, sliceIndex, sliceTotal, text) => {
                // 页面可能在流式过程中导航走了：端口已断时丢弃增量，别让整个请求陪葬
                try {
                  port.postMessage({
                    kind: 'delta',
                    taskId: msg.taskId,
                    chunkId: msg.chunkId,
                    paragraphId,
                    sliceIndex,
                    sliceTotal,
                    text,
                  } satisfies TranslateResponse);
                } catch {
                  /* 端口已断开：增量丢弃 */
                }
              }
            : undefined,
        );
        console.log('[llm-tr] SW response', msg.chunkId, response.kind, response.kind === 'error' ? `${response.code}: ${response.message}` : ''); // [diag]
        port.postMessage(response);
      } catch (e) {
        // 兜底：任何意外异常（如 IndexedDB 故障）也必须回响应，保证每个请求恰好收到一个响应
        port.postMessage({
          kind: 'error',
          taskId: msg.taskId,
          chunkId: msg.chunkId,
          code: 'failed',
          message: e instanceof Error ? e.message : String(e),
        } satisfies TranslateResponse);
      } finally {
        release();
      }
    });
  });
});
