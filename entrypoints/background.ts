import { handleTranslateRequest } from '../lib/translation/scheduler';
import { translateUnits } from '../lib/translation/llm-client';
import { getCached, setCached } from '../lib/cache/store';
import { getSettings } from '../lib/settings';
import type { TranslateRequest, TranslateResponse } from '../lib/messaging/protocol';

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

export default defineBackground(() => {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'translate') return;
    port.onMessage.addListener(async (msg: TranslateRequest) => {
      if (msg.kind !== 'translate') return;
      await acquire();
      try {
        const response: TranslateResponse = await handleTranslateRequest(msg, {
          translate: translateUnits,
          getCached,
          setCached,
          getSettings,
          jsonFormatSupported,
        });
        port.postMessage(response);
      } finally {
        release();
      }
    });
  });
});
