import { test, expect } from './fixtures';
import { SEL, openDriver, openTestPage, seedSettings, stubControl } from './helpers';

test.beforeEach(async ({ context, extensionId, request }) => {
  await stubControl(request, 'reset=1');
  await seedSettings(context, extensionId, { catMode: true });
});

test('选中文字：猫跳到选区尾，不遮正文', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  const cat = page.locator(`${SEL} .cat`);
  await expect(cat).toBeVisible({ timeout: 10_000 });
  // jump 动画走 WAAPI 420ms，落点断言前等动画结束
  await page.waitForTimeout(600);
  // 落在选区尾附近
  const catBox = (await cat.boundingBox())!;
  const pBox = (await page.locator('article p').first().boundingBox())!;
  expect(catBox.y).toBeGreaterThan(pBox.y - 40);
  expect(catBox.y).toBeLessThan(pBox.y + pBox.height + 60);
  // 不遮正文：猫与每个段落首文本节点的真实文本行盒都不相交（允许边界相切）
  const geom = await page.evaluate(() => {
    const lines: { left: number; right: number; top: number; bottom: number }[] = [];
    for (const p of Array.from(document.querySelectorAll('article p'))) {
      const text = p.firstChild;
      if (text === null) continue;
      const r = document.createRange();
      r.selectNodeContents(text);
      for (const rect of Array.from(r.getClientRects())) {
        lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      }
    }
    const selRects = window.getSelection()!.getRangeAt(0).getClientRects();
    return { lines, selLineRight: selRects[selRects.length - 1]!.right };
  });
  expect(geom.lines.length).toBeGreaterThan(0);
  for (const line of geom.lines) {
    const disjoint =
      catBox.x >= line.right ||
      catBox.x + catBox.width <= line.left ||
      catBox.y >= line.bottom ||
      catBox.y + catBox.height <= line.top;
    expect(disjoint, `猫盒与文本行盒相交: ${JSON.stringify(line)}`).toBe(true);
  }
  // 方向性：落点在选区尾行盒右侧
  expect(catBox.x).toBeGreaterThanOrEqual(geom.selLineRight - 2);
});

test('点击猫打开翻译面板并显示译文', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  const cat = page.locator(`${SEL} .cat`);
  await expect(cat).toBeVisible({ timeout: 10_000 });
  await cat.click();
  const panel = page.locator(`${SEL} .panel`);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('译文', { timeout: 15_000 });
});

test('catMode=false：回圆钮且行为不变', async ({ context, extensionId }) => {
  await seedSettings(context, extensionId, { catMode: false });
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  const dot = page.locator(`${SEL} .dot`);
  await expect(dot).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`${SEL} .cat`)).toBeHidden();
  await dot.click();
  await expect(page.locator(`${SEL} .panel`)).toContainText('译文', { timeout: 15_000 });
});

test('选区清空后猫回停靠位', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  const cat = page.locator(`${SEL} .cat`);
  await expect(cat).toBeVisible({ timeout: 10_000 });
  // 等 jump 动画结束再采落点，避免采到停靠位导致后续 not.toBe 误判
  await page.waitForTimeout(600);
  const outBox = (await cat.boundingBox())!;

  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await page.mouse.click(640, 60);
  await page.waitForTimeout(800);
  const dockBox = (await cat.boundingBox())!;
  expect(dockBox.x).not.toBe(outBox.x);
  // 停靠位贴近视口右缘
  expect(dockBox.x).toBeGreaterThan(1200);
});
