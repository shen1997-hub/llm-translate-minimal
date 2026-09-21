import { test, expect } from './fixtures';
import {
  HOST, PAGE_URL, openDriver, seedSettings, sendStartTabToAllTabs, sendToTestPage, stubControl,
} from './helpers';

test.beforeEach(async ({ context, extensionId, request }) => {
  await stubControl(request, 'reset=1');
  await seedSettings(context, extensionId);
});

/**
 * 自愈注入的等价场景:blob: 文档(预览页/查看器一类)不在 manifest 的 <all_urls> 里,
 * 因此 content script 从未注入;但 blob 文档源继承自创建者,scripting 仍可注入。
 * 与「扩展安装/更新前就打开的页面」走完全相同的代码路径:
 * tabs.sendMessage 失败 → 补注入 content.js → 重试 start。
 */
test('自愈注入:没有 content script 的页面点翻译会自动补注入并翻译', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);

  // 普通页(有脚本)作为对照组,并用来创建同源 blob 文档
  const src = await context.newPage();
  await src.goto(PAGE_URL);
  const blobUrl = await src.evaluate(() => {
    const html = `<!doctype html><html><body><article>
      <p>This blob document hosts the first sufficiently long English paragraph for translation testing.</p>
      <p>And this blob document hosts a second sufficiently long English paragraph for translation testing.</p>
      </article></body></html>`;
    return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  });

  const page = await context.newPage();
  await page.goto(blobUrl);
  await expect(page.locator(HOST)).toHaveCount(0);

  // 前提确认:只有普通页有 content script 应答
  expect(await sendToTestPage(driver, { kind: 'probe' })).toHaveLength(1);

  const results = await sendStartTabToAllTabs(driver);
  // 只有 blob 页需要且成功补注入;普通页脚本存活,直接启动(未注入)
  expect(results.filter((r) => r.injected === true)).toHaveLength(1);
  expect(results.some((r) => r.ok === true && r.injected !== true)).toBe(true);

  // 自愈后 blob 页照常翻译
  const hosts = page.locator(HOST);
  await expect(hosts).toHaveCount(2, { timeout: 15_000 });
  await expect(hosts.first()).toContainText('译文', { timeout: 15_000 });
  await expect(page.locator(`article > p + ${HOST}`)).toHaveCount(2);
});

test('浏览器保留页面无法注入时返回 inject-failed', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const reserved = await context.newPage();
  await reserved.goto('chrome://version');

  // 没有任何带 content script 的页面:每个 start-tab 都应明确失败,且不抛异常
  const results = await sendStartTabToAllTabs(driver);
  expect(results.length).toBeGreaterThanOrEqual(2);
  expect(results.every((r) => r.ok === false && r.reason === 'inject-failed')).toBe(true);
});