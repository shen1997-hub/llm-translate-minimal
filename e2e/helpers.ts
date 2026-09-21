import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { STUB_ORIGIN } from './stub-server';

export const HOST = '[data-llm-translate-host]';
export const SEL = '[data-llm-translate-sel]';
export const PAGE_URL = `${STUB_ORIGIN}/page`;

export const BASE_SETTINGS = {
  providers: [{
    id: 'pv-1', name: 'Stub', baseUrl: STUB_ORIGIN, protocol: 'openai',
    apiKey: 'sk-test', models: ['m1'], activeModel: 'm1',
  }],
  activeProviderId: 'pv-1',
  sourceLang: 'auto',
  systemPrompt: 'SYS',
  targetLang: '中文',
  blacklist: [],
  disabledSites: [] as string[],
  minLength: 20,
  cjkRatioThreshold: 0.3,
};

export async function seedSettings(context: BrowserContext, extensionId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.evaluate(
    (settings) => chrome.storage.local.set({ settings }),
    { ...BASE_SETTINGS, ...overrides },
  );
  // 非用户手势下 request 会被 Chrome 拒绝；new headless 下权限弹窗无法展示，promise 会
  // 永远悬置，必须加超时兜底。stub 带 CORS 头，无 host 权限也能跑通。
  await page
    .evaluate((origin) => {
      const req = chrome.permissions.request({ origins: [`${origin}/*`] });
      const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), 3000));
      return Promise.race([req, timeout]);
    }, STUB_ORIGIN)
    .catch(() => {});
  await page.close();
}

// 扩展页面代理：E2E 无法点击真实 popup，改用 options 页面调 chrome.tabs API 向测试页发消息。
// 无 tabs 权限时 query 拿不到 url，故向所有 tab 广播，无 content script 的 tab 会抛错被忽略。
export async function sendToTestPage(driver: Page, msg: unknown): Promise<unknown[]> {
  return driver.evaluate(async (m) => {
    const tabs = await chrome.tabs.query({});
    const results: unknown[] = [];
    for (const t of tabs) {
      if (t.id === undefined) continue;
      try {
        results.push(await chrome.tabs.sendMessage(t.id, m));
      } catch {
        // 该 tab 没有注入 content script（扩展页/空白页）
      }
    }
    return results;
  }, msg);
}

// 模拟 popup 点击:向 background 对每个标签页广播 start-tab,覆盖自愈注入路径
export async function sendStartTabToAllTabs(driver: Page): Promise<{ ok?: boolean; injected?: boolean; reason?: string }[]> {
  return driver.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const out: { ok?: boolean; injected?: boolean; reason?: string }[] = [];
    for (const t of tabs) {
      if (t.id === undefined) continue;
      try {
        out.push(await chrome.runtime.sendMessage({ kind: 'start-tab', tabId: t.id }));
      } catch {
        // 无 background 应答属异常路径,由断言兜住
      }
    }
    return out;
  });
}

export async function openDriver(context: BrowserContext, extensionId: string): Promise<Page> {
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/options.html`);
  return driver;
}

export async function waitContentScriptReady(driver: Page): Promise<void> {
  await expect(async () => {
    const results = await sendToTestPage(driver, { kind: 'probe' });
    expect(results.length).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });
}

export async function openTestPage(context: BrowserContext, driver: Page): Promise<Page> {
  const page = await context.newPage();
  await page.goto(PAGE_URL);
  await waitContentScriptReady(driver);
  return page;
}

export async function stubControl(request: APIRequestContext, query: string): Promise<void> {
  const res = await request.get(`${STUB_ORIGIN}/__control?${query}`);
  expect(res.ok()).toBe(true);
}
