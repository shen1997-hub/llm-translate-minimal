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

test('停靠猫可拖拽:拖到左半屏吸附左缘,且不弹出面板', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  const cat = page.locator(`${SEL} .cat`);
  await expect(cat).toBeVisible({ timeout: 10_000 });
  const box = (await cat.boundingBox())!;
  // 右缘 peek 只露 26px:可见带是 [box.x, box.x+26],取可见带中点按下
  // (box.x+33=1287 已在 1280 视口之外,press 会落到 <html> 而不是猫)
  await page.mouse.move(box.x + 13, box.y + 22);
  await page.mouse.down();
  // 鼠标指针没有隐式捕获:先在猫盒内跨过 6px 拖拽阈值拿到 pointer capture,
  // 后续大步移动才不会因指针离开猫盒而丢事件(10 步直跳首帧就出盒,拖拽根本不会开始)
  await page.mouse.move(box.x + 1, box.y + 22);
  await page.mouse.move(300, 300, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400); // 吸附滑移 200ms 兜底

  const after = (await cat.boundingBox())!;
  expect(after.x).toBeLessThan(0); // 左缘 peek x=-18
  expect(after.y).toBeGreaterThan(0);
  await expect(cat).toHaveAttribute('data-state', 'dock');
  // 拖拽不触发开面板(click 被屏蔽;即便触发,无选区也不会开面板/发请求)
  await expect(page.locator(`${SEL} .panel`)).toBeHidden();
});

test('拖拽位置持久化:刷新页面后仍停靠左缘', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  const cat = page.locator(`${SEL} .cat`);
  await expect(cat).toBeVisible({ timeout: 10_000 });
  const box = (await cat.boundingBox())!;
  // 同上一用例:可见带 [box.x, box.x+26] 内按下 + 盒内先跨阈值拿 pointer capture
  await page.mouse.move(box.x + 13, box.y + 22);
  await page.mouse.down();
  await page.mouse.move(box.x + 1, box.y + 22);
  await page.mouse.move(300, 300, { steps: 10 });
  await page.mouse.up();

  // 等 onDockMove → saveSettings 落盘
  await expect(async () => {
    const s = await driver.evaluate(
      async () => ((await chrome.storage.local.get('settings')) as { settings?: { catDock?: unknown } }).settings,
    );
    expect(s?.catDock).toEqual({ side: 'left', yRatio: expect.any(Number) });
  }).toPass({ timeout: 3000 });

  await page.reload();
  const cat2 = page.locator(`${SEL} .cat`);
  await expect(cat2).toBeVisible({ timeout: 10_000 });
  const box2 = (await cat2.boundingBox())!;
  expect(box2.x).toBeLessThan(0); // 仍贴左缘
});
