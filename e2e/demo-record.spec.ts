import { chromium, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect, resolveChromiumExecutable } from './fixtures';
import {
  HOST,
  SEL,
  openDriver,
  seedSettings,
  sendStartTabToAllTabs,
  waitContentScriptReady,
} from './helpers';
import { STUB_ORIGIN } from './stub-server';

// 演示素材录制：不属于回归测试，仅手动 RECORD_DEMO=1 时执行
// 产物：docs/promotion/raw/demo-translate.webm、demo-cat.webm（后续用 ffmpeg 转 GIF）
const RAW_DIR = path.resolve('docs/promotion/raw');
const DEMO_URL = `${STUB_ORIGIN}/demo`;

const test = base.extend<{ context: BrowserContext }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use, testInfo) => {
    const safe = testInfo.title.replace(/[^\w-]+/g, '-');
    const dir = path.join(RAW_DIR, safe);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const pathToExtension = path.resolve('.output/chrome-mv3');
    const executablePath = resolveChromiumExecutable();
    const context = await chromium.launchPersistentContext('', {
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir, size: { width: 1280, height: 800 } },
      args: [`--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`],
    });
    await use(context);
    // context 关闭后录像才落盘；按 URL 找出演示页那一路，重命名到 raw/ 根目录
    const demoPage = context.pages().find((p) => p.url().startsWith(DEMO_URL));
    const video = demoPage?.video();
    try {
      await context.close();
      if (!video) throw new Error(`未找到演示页录像：${safe}`);
      const src = await video.path();
      fs.renameSync(src, path.join(RAW_DIR, `${safe}.webm`));
    } finally {
      // 子目录里只剩辅助页（options 页）的录像，无论重命名成功与否都清掉；
      // context.close() 抛错时也必须走到这里，避免残留垃圾录像
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
});

// 门禁必须在扩展后的 test 上调用：extended test type 独立于 base，skip 不传导
test.skip(process.env.RECORD_DEMO !== '1', '演示录像 spec，需 RECORD_DEMO=1 手动触发');

// 用页面内脚本选中文本并派发 mouseup，触发划词/猫咪（与 cat.spec.ts 同一手法）
async function selectParagraph(page: import('@playwright/test').Page, index: number): Promise<void> {
  await page.evaluate((i) => {
    const p = document.querySelectorAll('article p')[i]!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, index);
}

test('demo-translate', async ({ context, extensionId }) => {
  await seedSettings(context, extensionId, { catMode: false });
  const driver = await openDriver(context, extensionId);
  const page = await context.newPage();
  await page.goto(DEMO_URL);
  await waitContentScriptReady(driver);
  await page.waitForTimeout(1000); // 开场停留，给观众看清原文
  await sendStartTabToAllTabs(driver);
  await expect(page.locator(HOST).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2500); // 停留展示译文流式出现
  // 缓慢滚动展示后续段落的双语对照
  await page.mouse.move(640, 400);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 90);
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(1500); // 结尾停留
});

test('demo-cat', async ({ context, extensionId }) => {
  await seedSettings(context, extensionId, { catMode: true });
  const driver = await openDriver(context, extensionId);
  const page = await context.newPage();
  await page.goto(DEMO_URL);
  await waitContentScriptReady(driver);
  await page.waitForTimeout(1500); // 开场停留，给观众看清原文
  await selectParagraph(page, 2); // 选第三段：页面中段，猫跳跃动效完整入镜
  const cat = page.locator(`${SEL} .cat`);
  await expect(cat).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1400); // jump 动画 420ms + 余量，录全猫跳到选区尾
  await cat.click();
  const panel = page.locator(`${SEL} .panel`);
  // 断言 p3 手写译文的稳定片段：此前用 '译文' 是被手写译文里恰好含「译文」二字蒙对的
  await expect(panel).toContainText('而浏览器扩展补上的', { timeout: 15_000 });
  await page.waitForTimeout(4500); // 停留展示面板与译文（总时长拉到 8s 以上）
});
