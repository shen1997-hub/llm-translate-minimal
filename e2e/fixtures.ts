import { test as base, chromium, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Playwright 期望的浏览器版本若未下载（本机 CDN 被墙），回退到 ms-playwright 目录里
// 已存在的最高版本完整版 chromium（headless shell 不支持扩展，必须用完整版 chrome.exe）
function resolveChromiumExecutable(): string | undefined {
  const browsersRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'ms-playwright')
      : path.join(os.homedir(), '.cache/ms-playwright'));
  let candidates: string[] = [];
  try {
    candidates = fs
      .readdirSync(browsersRoot)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  } catch {
    return undefined;
  }
  for (const dir of candidates) {
    const exe = path.join(browsersRoot, dir, 'chrome-win/chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const pathToExtension = path.resolve('.output/chrome-mv3');
    const executablePath = resolveChromiumExecutable();
    const context = await chromium.launchPersistentContext('', {
      // 完整版 chromium + headless（new headless）支持 MV3 扩展与 service worker
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw.url().split('/')[2]);
  },
});

export const expect = test.expect;
