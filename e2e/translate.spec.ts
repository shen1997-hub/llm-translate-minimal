import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { STUB_ORIGIN } from './stub-server';

const HOST = '[data-llm-translate-host]';
const SEL = '[data-llm-translate-sel]';
const PAGE_URL = `${STUB_ORIGIN}/page`;

const BASE_SETTINGS = {
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

async function seedSettings(context: BrowserContext, extensionId: string, overrides: Record<string, unknown> = {}): Promise<void> {
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
async function sendToTestPage(driver: Page, msg: unknown): Promise<unknown[]> {
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

async function openDriver(context: BrowserContext, extensionId: string): Promise<Page> {
  const driver = await context.newPage();
  await driver.goto(`chrome-extension://${extensionId}/options.html`);
  return driver;
}

async function waitContentScriptReady(driver: Page): Promise<void> {
  await expect(async () => {
    const results = await sendToTestPage(driver, { kind: 'probe' });
    expect(results.length).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });
}

async function openTestPage(context: BrowserContext, driver: Page): Promise<Page> {
  const page = await context.newPage();
  await page.goto(PAGE_URL);
  await waitContentScriptReady(driver);
  return page;
}

async function stubControl(request: import('@playwright/test').APIRequestContext, query: string): Promise<void> {
  const res = await request.get(`${STUB_ORIGIN}/__control?${query}`);
  expect(res.ok()).toBe(true);
}

test.beforeEach(async ({ context, extensionId, request }) => {
  await stubControl(request, 'reset=1');
  await seedSettings(context, extensionId);
});

test('全文翻译：正文段落插入译文，导航/侧边栏不翻，原页面交互不破坏', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await sendToTestPage(driver, { kind: 'start' });

  const hosts = page.locator(HOST);
  await expect(hosts).toHaveCount(2, { timeout: 15_000 });
  await expect(hosts.first()).toContainText('译文', { timeout: 15_000 });
  await expect(hosts.nth(1)).toContainText('译文');

  // 插入位置：每个 host 紧跟在对应段落后
  await expect(page.locator(`article > p + ${HOST}`)).toHaveCount(2);
  // 导航与侧边栏不翻
  await expect(page.locator(`nav ${HOST}`)).toHaveCount(0);
  await expect(page.locator(`aside ${HOST}`)).toHaveCount(0);
  // 原文未被改写
  await expect(page.locator('article p').first()).toContainText('first sufficiently long English paragraph');

  // 原页面交互不破坏：按钮仍可点击
  await page.locator('#counter-btn').click();
  await expect(page.locator('#counter')).toHaveText('1');
});

test('SPA 动态加载内容可翻', async ({ context, extensionId, request }) => {
  // 延迟响应，保证追加新段落时任务仍在运行、MutationObserver 仍挂着
  await stubControl(request, 'delay=1000');
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await sendToTestPage(driver, { kind: 'start' });
  const hosts = page.locator(HOST);
  await expect(hosts).toHaveCount(2, { timeout: 15_000 });

  await page.evaluate(() => {
    const p = document.createElement('p');
    p.textContent = 'This dynamically appended paragraph simulates SPA content loading after translation started.';
    document.querySelector('article')!.appendChild(p);
  });

  await expect(hosts).toHaveCount(3, { timeout: 15_000 });
  await expect(hosts.nth(2)).toContainText('译文', { timeout: 15_000 });
  await expect(page.locator(`article > p + ${HOST}`)).toHaveCount(3);
  await stubControl(request, 'reset=1');
});

test('失败段落可重试', async ({ context, extensionId, request }) => {
  await stubControl(request, 'fail=1');
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await sendToTestPage(driver, { kind: 'start' });

  const retryButtons = page.locator(`${HOST} button[data-retry]`);
  await expect(retryButtons).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator(HOST).first()).toContainText('翻译失败');

  await stubControl(request, 'fail=0');

  // 重试第一段：成功；第二段保持失败态
  await retryButtons.first().click();
  await expect(page.locator(HOST).first()).toContainText('译文', { timeout: 15_000 });
  await expect(page.locator(HOST).nth(1)).toContainText('翻译失败');

  // 重试第二段：全部成功
  await page.locator(`${HOST} button[data-retry]`).click();
  await expect(page.locator(HOST).nth(1)).toContainText('译文', { timeout: 15_000 });
  await expect(page.locator(`${HOST} button[data-retry]`)).toHaveCount(0);
});

test('站点开关：写入 disabledSites 后不翻译，刷新后保持', async ({ context, extensionId }) => {
  await seedSettings(context, extensionId, { disabledSites: ['127.0.0.1'] });
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await sendToTestPage(driver, { kind: 'start' });
  const probe = await sendToTestPage(driver, { kind: 'probe' });
  expect(probe).toEqual([{ kind: 'probe-result', paragraphs: 0, chars: 0, blacklisted: true }]);
  await expect(page.locator(HOST)).toHaveCount(0);

  // 刷新后设置保持，仍然不翻
  await page.reload();
  await waitContentScriptReady(driver);
  await sendToTestPage(driver, { kind: 'start' });
  const probeAfterReload = await sendToTestPage(driver, { kind: 'probe' });
  expect(probeAfterReload).toEqual([{ kind: 'probe-result', paragraphs: 0, chars: 0, blacklisted: true }]);
  await expect(page.locator(HOST)).toHaveCount(0);
});

test('划词翻译：选中文本出现圆钮，点击弹出浮窗显示译文', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  // 构造真实选区并派发 mouseup（Playwright 的 css 选择器可穿透 Shadow DOM）
  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 }));
  });

  const dot = page.locator(`${SEL} .dot`);
  await expect(dot).toBeVisible({ timeout: 10_000 });

  await dot.click();
  const panel = page.locator(`${SEL} .panel`);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('译文', { timeout: 15_000 });
});


test('Claude 协议供应商：全文翻译走 /v1/messages', async ({ context, extensionId }) => {
  await seedSettings(context, extensionId, {
    providers: [{
      id: 'pv-claude', name: 'Claude', protocol: 'claude', baseUrl: STUB_ORIGIN,
      apiKey: 'sk-ant', models: ['claude-x'], activeModel: 'claude-x',
    }],
    activeProviderId: 'pv-claude',
  });
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await sendToTestPage(driver, { kind: 'start' });

  const hosts = page.locator(HOST);
  await expect(hosts).toHaveCount(2, { timeout: 15_000 });
  await expect(hosts.first()).toContainText('译文', { timeout: 15_000 });
  await expect(hosts.nth(1)).toContainText('译文');
});

test('设置页从 CC Switch 数据库导入供应商', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await page.setInputFiles('#ccswitch-file', 'e2e/fixtures/cc-switch-test.db');
  const rows = page.locator('#import-list .import-row');
  // official 行被跳过：只剩 claude + codex 两条
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(rows.first()).toContainText('TestClaude');
  await expect(rows.first()).toContainText('Claude');

  await page.locator('#import-list button[data-act="import"]').click();
  // seed 的 Stub 供应商 + 导入的 2 个 = 3 行；is_current=1 的 TestClaude 被设为当前
  const pvRows = page.locator('.pv-row');
  await expect(pvRows).toHaveCount(3);
  await expect(pvRows.nth(1)).toContainText('TestClaude');
  await expect(pvRows.nth(1)).toContainText('当前');
  await page.close();
});
