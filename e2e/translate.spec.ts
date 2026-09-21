import { test, expect } from './fixtures';
import {
  HOST, SEL, openDriver, openTestPage, seedSettings, sendToTestPage,
  stubControl, waitContentScriptReady,
} from './helpers';
import { STUB_ORIGIN } from './stub-server';

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

  // 圆钮贴「选区尾」，而不是 mouseup 的鼠标坐标 (100,100)
  const expected = await page.evaluate(() => {
    const rects = window.getSelection()!.getRangeAt(0).getClientRects();
    const last = rects[rects.length - 1]!;
    return { x: last.right + window.scrollX, y: last.bottom + window.scrollY };
  });
  const dotBox = (await dot.boundingBox())!;
  expect(Math.abs(dotBox.x - (expected.x + 6))).toBeLessThan(4);
  expect(Math.abs(dotBox.y - (expected.y + 6))).toBeLessThan(4);
  expect(dotBox.x).toBeGreaterThan(200); // 远离鼠标坐标 (100,100)，钉死「不再用鼠标位置」

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

test('扩展重载后残留内容脚本不再抛未捕获异常', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // 重载扩展：页面上已注入的旧内容脚本随之失去扩展上下文（chrome.* 全部失效）
  await driver.evaluate(() => { chrome.runtime.reload(); return true; });
  await page.waitForTimeout(500);

  // 任意 mouseup 都会走划词命中路径（读 settings → chrome.storage）
  await page.mouse.click(20, 20);
  await page.waitForTimeout(500);

  expect(errors.filter(m => m.includes('Extension context invalidated'))).toEqual([]);
  await page.close();
});

test('设置页点保存后收起弹窗（全局项已落盘）', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);

  await page.locator('#blacklist').fill('example.com');
  await page.locator('#save').click();

  // window.close() 负责收起内嵌设置弹窗；Playwright 打开的是普通标签页，浏览器会忽略该调用，
  // 因此在新页面读 storage 验证落盘（真实弹窗场景下旧页面已被收起，读不到）
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(probe.locator('#blacklist')).toHaveValue('example.com');
  await page.close();
  await probe.close();
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

test('整页流式：先流出已完成的段，其余段仍在等待，收流后补全', async ({ context, extensionId, request }) => {
  // hold=1：桩服务写完前两帧后挂起，用例先断言稳定中间态，再放行最后一帧
  await stubControl(request, 'hold=1');
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await sendToTestPage(driver, { kind: 'start' });

  const bodies = page.locator(`${HOST} .body`);
  await expect(bodies).toHaveCount(2, { timeout: 15_000 });
  // 第一段已按增量渲染出完整译文（前缀在流中被逐步追加得到）
  await expect(bodies.nth(0)).toHaveText('译文0', { timeout: 15_000 });
  // 此时响应尚未结束：第二段还停在等待态
  await expect(bodies.nth(1)).toContainText('翻译中');
  // 等待中的那段是三点脉动，不是静态文字
  expect(await bodies.nth(1).locator('.dots i').count()).toBe(3);

  await stubControl(request, 'release=1');
  await expect(bodies.nth(1)).toHaveText('译文1', { timeout: 15_000 });
  await stubControl(request, 'reset=1');
});

test('等待态显示三点脉动动画（整页与划词浮窗）', async ({ context, extensionId, request }) => {
  // 延后响应，保证用例观测到的是稳定的等待中态
  await stubControl(request, 'delay=3000');
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  await sendToTestPage(driver, { kind: 'start' });

  const dots = page.locator(`${HOST} .body .dots`);
  await expect(dots.first()).toBeVisible({ timeout: 10_000 });
  expect(await dots.count()).toBe(2);                            // 两个段落各一处
  expect(await page.locator(`${HOST} .dots i`).count()).toBe(6);  // 每处三个点
  // 等待态不该同时显示译文
  await expect(page.locator(`${HOST} .body`).first()).toHaveText('翻译中…');

  // 划词浮窗同样有等待动画
  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator(`${SEL} .dot`).click();
  const panelDots = page.locator(`${SEL} .panel .body .dots i`);
  await expect(panelDots).toHaveCount(3, { timeout: 10_000 });
  // 响应到达后换成译文，三点随之撤掉
  await expect(page.locator(`${SEL} .panel .body`)).toContainText('译文', { timeout: 15_000 });
  await expect(panelDots).toHaveCount(0);

  await stubControl(request, 'reset=1');
});

test('浮窗打开时不遮挡下一段正文的划词（回归）', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  // 选中第一段 → 点圆钮 → 浮窗落在选区下方，正好盖住第二段所在行的左半部分
  await page.evaluate(() => {
    const p = document.querySelector('article p')!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator(`${SEL} .dot`).click();
  await expect(page.locator(`${SEL} .panel`)).toBeVisible();
  await expect(page.locator(`${SEL} .panel`)).toContainText('译文', { timeout: 15_000 });

  const panelBox = (await page.locator(SEL).boundingBox())!;
  const p2 = (await page.locator('article p').nth(1).boundingBox())!;
  const y = p2.y + p2.height / 2;
  // 起手点必须落在浮窗覆盖区内，否则这个用例测不到遮挡
  expect(panelBox.y).toBeLessThanOrEqual(y);
  expect(panelBox.y + panelBox.height).toBeGreaterThanOrEqual(y);

  // 从浮窗覆盖区内部起手，长拖到行尾
  await page.mouse.move(panelBox.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(1268, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('second sufficiently long English paragraph');
  await expect(page.locator(`${SEL} .dot`)).toBeVisible({ timeout: 10_000 });
});

test('键盘扩选时圆钮跟随新选区尾', async ({ context, extensionId }) => {
  const driver = await openDriver(context, extensionId);
  const page = await openTestPage(context, driver);

  // 先选中第一段的一小段，让圆钮出现
  await page.evaluate(() => {
    const text = document.querySelector('article p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 10);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.locator(`${SEL} .dot`)).toBeVisible({ timeout: 10_000 });

  // 程序化扩大选区（等价于 Shift+方向键）：不派发 mouseup，只发 selectionchange
  await page.evaluate(() => {
    const text = document.querySelectorAll('article p')[1]!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 24);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });

  const expected = await page.evaluate(() => {
    const rects = window.getSelection()!.getRangeAt(0).getClientRects();
    const last = rects[rects.length - 1]!;
    return { x: last.right + window.scrollX, y: last.bottom + window.scrollY };
  });
  await expect(async () => {
    const box = (await page.locator(`${SEL} .dot`).boundingBox())!;
    expect(Math.abs(box.x - (expected.x + 6))).toBeLessThan(4);
    expect(Math.abs(box.y - (expected.y + 6))).toBeLessThan(4);
  }).toPass({ timeout: 5_000 });
});
