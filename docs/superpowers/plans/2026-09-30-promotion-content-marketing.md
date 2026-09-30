# 内容营销推广实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产出推广所需的全部资产：自动化演示素材（GIF）、README 最小门面、内容日历、三篇首发成稿（V2EX/掘金/Show HN）、发布 checklist。

**Architecture:** 复用现有 e2e 基建（fixtures/stub-server/helpers）加一个手动触发的录像 spec（`RECORD_DEMO=1` 门禁，不进默认 e2e），Playwright 录 webm → ffmpeg 转 GIF → README 引用。文章与 checklist 为纯 markdown 交付物，放 `docs/promotion/`。

**Tech Stack:** Playwright（recordVideo）、ffmpeg（已确认本机可用，v8.0）、GitHub `gh` CLI（可选，缺失则给手动指引）。

**Spec:** `docs/superpowers/specs/2026-09-30-promotion-content-marketing-design.md`

## Global Constraints

- 文案与代码注释全中文（Show HN 等英文渠道稿除外）；commit 用中文 conventional commits（`docs:` / `test:` / `chore:`）
- 不改 `lib/` 与 `entrypoints/` 功能代码；允许改 `e2e/` 测试基建、`package.json` scripts、`README.md`、`AGENTS.md`
- e2e 必须先 `npm run build`；playwright workers 固定 1，不改
- 演示 GIF 单个 ≤ 8MB（GitHub 上限 10MB 留余量），目标 ≤ 5MB
- 涉及 GitHub 远程设置（topics/description）前必须 `gh auth status` 确认登录并向用户确认后再执行
- 当前分支 `cat`，直接在本分支提交
- 录像 spec 必须 `RECORD_DEMO=1` 环境变量门禁，默认 `npm run e2e` 不执行

---

### Task 1: 演示落地页 + stub 服务 /demo 路由

**Files:**
- Create: `e2e/demo-page.html`
- Modify: `e2e/stub-server.ts:27`（pageHtml 旁加 demoHtml，路由表加 /demo 分支）

**Interfaces:**
- Produces: `http://127.0.0.1:4789/demo` 返回演示页 HTML（Task 2 的录像 spec 导航到此 URL）

- [ ] **Step 1: 创建演示页 `e2e/demo-page.html`**

英文长文（配合 targetLang=中文 展示双语对照），结构仿照 `e2e/test-page.html`（`article > p`，正文提取器已验证可命中），Medium 风格排版：

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The Quiet Rise of Small Language Models</title>
<style>
  body { margin: 0; background: #fff; color: #242424; font-family: Georgia, 'Times New Roman', serif; }
  article { max-width: 680px; margin: 0 auto; padding: 48px 20px 96px; }
  h1 { font-size: 34px; line-height: 1.25; margin: 0 0 8px; }
  .byline { color: #6b6b6b; font-family: Helvetica, Arial, sans-serif; font-size: 14px; margin-bottom: 32px; }
  p { font-size: 19px; line-height: 1.7; margin: 0 0 24px; }
  h2 { font-size: 24px; margin: 40px 0 16px; font-family: Helvetica, Arial, sans-serif; }
</style>
</head>
<body>
<article>
  <h1>The Quiet Rise of Small Language Models</h1>
  <div class="byline">A demo article for the minimal translate extension</div>
  <p>For years, the story of artificial intelligence was a story of scale. Bigger models, bigger clusters, bigger budgets. But something interesting has happened in the past year: small language models have quietly become good enough for everyday work.</p>
  <p>Translation is the clearest example. A seven-billion-parameter model running on a free tier can now produce bilingual web page translations that rival what subscription services offered two years ago. The bottleneck is no longer intelligence, but plumbing.</p>
  <p>That plumbing is exactly what browser extensions provide. Instead of pasting text into a chat window, the extension finds the article, sends each paragraph to the model, and places the translation right under the original text.</p>
  <h2>Bring your own key</h2>
  <p>The economics are surprisingly friendly. Many providers offer free models with generous rate limits, and a paid model like DeepSeek costs less than a cup of coffee per month for heavy reading. You pay for what you use, not a flat subscription.</p>
  <p>Privacy improves too. Your API key lives in your browser's local storage and talks only to the provider you configured. There is no middleman server collecting your reading history.</p>
  <h2>A companion, not a toolbar</h2>
  <p>Good tools should feel alive. Select a sentence and a small cat trots over to your cursor, offering to translate just that fragment. It is a small delight, but small delights are why we keep using some tools and abandon others.</p>
  <p>The web was always meant to be read in every language. With a capable model in your pocket and a minimal extension in your browser, that promise finally feels within reach.</p>
</article>
</body>
</html>
```

- [ ] **Step 2: stub-server.ts 增加 /demo 路由**

`e2e/stub-server.ts:27` 附近，`pageHtml` 声明后加一行，路由表中 `/page` 分支后加 `/demo` 分支：

```ts
const pageHtml = fs.readFileSync(path.resolve('e2e/test-page.html'), 'utf8');
const demoHtml = fs.readFileSync(path.resolve('e2e/demo-page.html'), 'utf8');
```

```ts
      if (url.pathname === '/demo') {
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(demoHtml);
        return;
      }
```

- [ ] **Step 3: typecheck 验证**

Run: `npm run typecheck`
Expected: 无错误退出（exit 0）

- [ ] **Step 4: Commit**

```bash
git add e2e/demo-page.html e2e/stub-server.ts
git commit -m "test: stub 服务新增 /demo 演示落地页路由"
```

---

### Task 2: 录像 spec + fixtures 导出改造

**Files:**
- Modify: `e2e/fixtures.ts:8`（`resolveChromiumExecutable` 加 `export`）
- Create: `e2e/demo-record.spec.ts`
- Modify: `package.json`（scripts 加 `record-demo`）
- Modify: `AGENTS.md`（常用命令加一行）

**Interfaces:**
- Consumes: Task 1 的 `/demo` 路由；`e2e/helpers.ts` 的 `seedSettings/openDriver/waitContentScriptReady/sendStartTabToAllTabs/HOST/SEL`；`e2e/stub-server.ts` 的 `STUB_ORIGIN`
- Produces: `docs/promotion/raw/demo-translate.webm` 与 `docs/promotion/raw/demo-cat.webm`（Task 3 转 GIF 的输入）

- [ ] **Step 1: fixtures.ts 导出 resolveChromiumExecutable**

`e2e/fixtures.ts:8`：`function resolveChromiumExecutable()` → `export function resolveChromiumExecutable()`，其余不动。

- [ ] **Step 2: 创建 `e2e/demo-record.spec.ts`**

完整内容如下。要点：覆盖 context fixture 加 `recordVideo`，每个 test 独立录像子目录，context 关闭后按 URL 找出演示页的录像并重命名到 `docs/promotion/raw/<title>.webm`，清掉辅助页（options 页）的垃圾录像；`RECORD_DEMO` 门禁使默认 e2e 跳过。

```ts
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
    await context.close();
    if (video) {
      const src = await video.path();
      fs.renameSync(src, path.join(RAW_DIR, `${safe}.webm`));
    }
    fs.rmSync(dir, { recursive: true, force: true });
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
  await page.waitForTimeout(800);
  await selectParagraph(page, 2); // 选第三段：页面中段，猫跳跃动效完整入镜
  const cat = page.locator(`${SEL} .cat`);
  await expect(cat).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(900); // jump 动画 420ms + 余量，录全猫跳到选区尾
  await cat.click();
  const panel = page.locator(`${SEL} .panel`);
  await expect(panel).toContainText('译文', { timeout: 15_000 });
  await page.waitForTimeout(2500); // 停留展示面板与译文
});
```

- [ ] **Step 3: package.json 加脚本**

`package.json` scripts 段 `"zip": "wxt zip"` 后加一行：

```json
    "record-demo": "playwright test e2e/demo-record.spec.ts",
```

（Windows 下经 Git Bash 执行：`RECORD_DEMO=1 npm run record-demo`。）

- [ ] **Step 4: AGENTS.md 同步**

`AGENTS.md` 常用命令代码块中 `npx playwright test e2e/cat.spec.ts` 行后加：

```
RECORD_DEMO=1 npm run record-demo        # 录制推广演示素材（webm，产物在 docs/promotion/raw/）
```

- [ ] **Step 5: 构建并录制**

```bash
npm run build && RECORD_DEMO=1 npm run record-demo
```

Expected: 2 个测试全过（`2 passed`），`docs/promotion/raw/demo-translate.webm` 与 `docs/promotion/raw/demo-cat.webm` 存在且大小 > 0。用 `ls -la docs/promotion/raw/` 确认。

- [ ] **Step 6: 人工抽验录像内容**

用 `ffprobe docs/promotion/raw/demo-translate.webm` 确认时长 ≥ 8s；如时长异常或画面不符（可用 ReadMediaFile 抽帧检查：先 `ffmpeg -y -i <webm> -ss 3 -frames:v 1 /tmp/frame.png`），回到 Step 2 调整等待时间。

- [ ] **Step 7: Commit**

```bash
git add e2e/fixtures.ts e2e/demo-record.spec.ts package.json AGENTS.md
git commit -m "test: 新增演示素材录像 spec（RECORD_DEMO=1 手动触发）"
```

---

### Task 3: webm 转 GIF 落位 docs/assets/

**Files:**
- Create: `docs/assets/demo-translate.gif`、`docs/assets/demo-cat.gif`（由 ffmpeg 生成）

**Interfaces:**
- Consumes: Task 2 的 `docs/promotion/raw/demo-translate.webm`、`demo-cat.webm`
- Produces: `docs/assets/demo-translate.gif`、`docs/assets/demo-cat.gif`（Task 4 README 引用的相对路径）

- [ ] **Step 1: 转 GIF（两遍调色板法）**

```bash
mkdir -p docs/assets
for name in demo-translate demo-cat; do
  ffmpeg -y -i "docs/promotion/raw/${name}.webm" \
    -vf "fps=12,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" \
    "docs/assets/${name}.gif"
done
```

- [ ] **Step 2: 大小检查**

Run: `ls -la docs/assets/`
Expected: 每个 GIF ≤ 8MB（目标 ≤ 5MB）。超限则降参重转：`fps=10,scale=720:-1`。

- [ ] **Step 3: 目视确认**

ReadMediaFile 查看两个 GIF 首帧（或抽帧 png），确认画面是演示页+译文/猫咪面板，不是空白或 options 页。

- [ ] **Step 4: Commit**

```bash
git add docs/assets/
git commit -m "docs: 新增整页翻译与猫咪划词演示 GIF"
```

---

### Task 4: README 最小门面 + GitHub topics/description

**Files:**
- Modify: `README.md:1-4`（标题下插入 GIF 与英文一句话简介）

**Interfaces:**
- Consumes: Task 3 的 `docs/assets/demo-translate.gif`、`docs/assets/demo-cat.gif`

- [ ] **Step 1: README 顶部插入门面**

`README.md` 第 3 行简介之后、`## 功能特性` 之前插入：

```markdown
![整页双语对照翻译演示](docs/assets/demo-translate.gif)

![划词翻译与猫咪助手演示](docs/assets/demo-cat.gif)

> Minimal LLM web translation extension — bring your own API key or use free models. No subscription.
```

- [ ] **Step 2: 验证渲染路径**

Run: `ls docs/assets/demo-translate.gif docs/assets/demo-cat.gif`
Expected: 两文件存在（README 相对路径有效，GitHub 会渲染）。

- [ ] **Step 3: GitHub topics/description**

先 `gh auth status`：已登录则**向用户确认后**执行：

```bash
gh repo edit shen1997-hub/llm-translate-minimal \
  --description "Minimal LLM web translation extension — full-page bilingual translation + selection popup with a cat assistant. Bring your own API key or free models. No subscription." \
  --add-topic llm --add-topic translation --add-topic chrome-extension \
  --add-topic browser-extension --add-topic openai --add-topic deepseek \
  --add-topic wxt --add-topic typescript --add-topic bilingual
```

未登录或用户不确认：把上面 description 与 topics 清单原样给用户，指引在仓库主页 About ⚙ 手动填写。

- [ ] **Step 4: Commit 并提醒推送**

```bash
git add README.md
git commit -m "docs: README 顶部新增演示 GIF 与英文一句话简介"
```

提醒用户 `git push` 后 GIF 才会在 GitHub 渲染（推送属远程操作，由用户执行或确认后执行）。

---

### Task 5: 内容日历

**Files:**
- Create: `docs/promotion/content-calendar.md`

- [ ] **Step 1: 写内容日历**

完整内容如下（12 选题 = spec 选题库，状态列供后续跟踪）：

```markdown
# 内容日历 · llm-translate-minimal 推广

北极星：90 天 500 star。过程指标：单帖 V2EX 回复 ≥20；HN 进首页前 30。
节奏：每周 1 篇文章 + 每两周 1 条视频，前 6 篇约一个半月发完。
每帖唯一目标动作：点进 GitHub 仓库。发布后 48h 内盯评论回复，并回填数据。

| # | 标题 | 支柱 | 渠道 | 状态 | 发布时间 | 阅读/播放 | 评论 | star 增量 |
|---|------|------|------|------|---------|----------|------|-----------|
| 1 | 零成本 AI 网页翻译：用免费大模型 API 搭建自己的翻译插件 | 教程 | 掘金 | 待发布 | | | | |
| 2 | DeepSeek API 翻译整个网页：从申请 key 到双语对照只要 5 分钟 | 教程 | 掘金 | 待写 | | | | |
| 3 | 本地 Ollama 也能网页翻译：完全离线的双语阅读方案 | 教程 | 掘金 + r/LocalLLaMA | 待写 | | | | |
| 4 | 不想订阅沉浸式翻译？这个开源插件让你用自己的 API key | 对比 | 少数派 | 待写 | | | | |
| 5 | 2026 年网页翻译方案横评：订阅制 vs 自带 key vs 免费模型 | 对比 | 少数派 | 待写 | | | | |
| 6 | 我开源了一个极简 LLM 网页翻译扩展，选中翻译时会有只猫探出头 | 开源故事 | V2EX 分享创造 | 待发布 | | | | |
| 7 | Show HN: Minimal LLM web translation extension | 开源故事 | HN | 待发布 | | | | |
| 8 | Self-hosted translation with Ollama — no subscription | 开源故事 | r/selfhosted | 待写 | | | | |
| 9 | 30 秒看懂：免费大模型翻译整个网页 | 视频 | B站/视频号 | 待录 | | | | |
| 10 | 我用 AI 给自己的翻译插件写了只猫 | 视频 | B站 | 待录 | | | | |
| 11 | 划词翻译的正确姿势：单词查询 + 双语自动方向 | 技巧 | 掘金 | 待写 | | | | |
| 12 | 如何让 LLM 翻译不翻导航栏：正文提取的工程实践 | 技巧 | 掘金 | 待写 | | | | |

## 渠道改写要点

- 掘金：步骤化、代码块多、封面图 3:2，标签打「翻译 / Chrome插件 / DeepSeek」
- 少数派：效率叙事、少代码多截图，走投稿通道
- V2EX：重故事和开源，标题带项目名，置顶回复答疑
- HN：北京时间晚 9-11 点发（美国上午），标题 ≤80 字符
- Reddit：英文、自述简短，遵守各版 self-promotion 规则，账号先养再发
- X：GIF 直传，#buildinpublic #opensource
- B站：竖版 30-60s，猫咪做封面钩子，简介放 GitHub 链接

## 素材引用

README 演示 GIF（合并到 main 后的 raw 地址，帖子内引用）：

- `https://raw.githubusercontent.com/shen1997-hub/llm-translate-minimal/main/docs/assets/demo-translate.gif`
- `https://raw.githubusercontent.com/shen1997-hub/llm-translate-minimal/main/docs/assets/demo-cat.gif`
```

- [ ] **Step 2: Commit**

```bash
git add docs/promotion/content-calendar.md
git commit -m "docs: 新增推广内容日历与数据跟踪表"
```

---

### Task 6: 选题 6 成稿 —— V2EX 分享创造主打帖

**Files:**
- Create: `docs/promotion/posts/01-v2ex-开源故事.md`

**验收标准：** 600–900 字；含标题、动机、功能清单、差异化、隐私说明、安装方式、演示图占位、求 star CTA；语气为开发者自述，不吹不黑。

- [ ] **Step 1: 成稿**

写入 `docs/promotion/posts/01-v2ex-开源故事.md`，结构与硬性内容要求如下（成稿须完整成文，以下是要点清单而非占位符）：

```markdown
# V2EX 分享创造帖（选题 6）

> 发布节点：分享创造。标题即用下面第一行。

标题：我开源了一个极简 LLM 网页翻译扩展，选中翻译时会有只猫探出头

## 正文结构与要点

1. 开头两段讲动机：用沉浸式翻译类工具被订阅/额度卡住；自己已有 DeepSeek/GLM 的 key，
   硅基流动还有免费模型，为什么翻译网页要再交一份订阅钱 → 自己写了一个。
2. 功能清单（照实写，不夸大）：
   - 整页双语对照：智能识别正文，导航/侧边栏不翻，译文插在原段落下
   - 划词翻译：选中文本出现小圆钮/猫咪，点击弹浮窗；支持朗读、复制、重试、图钉固定
   - 猫咪助手：选中文字时猫跳到选区尾，平时停靠屏幕边缘，可拖拽
   - 多供应商：任意 OpenAI 兼容 API（DeepSeek/GLM/OpenAI/Moonshot/Ollama），Claude 协议也支持
   - 本地缓存：IndexedDB，重复浏览不重复计费；并发限流 + 429 退避
   - 12 种目标语言，划词 CJK 占比过半自动译英文
3. 差异化段落（一两句即可，不贬低竞品）：不做全家桶，就两个功能做扎实；
   没有自己的服务器，key 只存在浏览器本地，请求只发给你配置的供应商。
4. 演示：嵌入猫咪 GIF 链接
   `https://raw.githubusercontent.com/shen1997-hub/llm-translate-minimal/main/docs/assets/demo-cat.gif`
   与整页翻译 GIF 链接
   `https://raw.githubusercontent.com/shen1997-hub/llm-translate-minimal/main/docs/assets/demo-translate.gif`
   （V2EX 图片需图床，发布时把 GIF 传到图床后替换为图床链接，此处保留 raw 链接作底稿）
5. 安装：GitHub 仓库 README 有构建步骤；也给出手动加载已解压扩展的两行说明。
6. 结尾 CTA：GitHub 地址 https://github.com/shen1997-hub/llm-translate-minimal ，
   觉得有用欢迎 star / issue；技术栈一句（TypeScript + WXT，MV3，运行时依赖只有一个）。

## 置顶回复预案（发布后由本人回复）

- Q: 和沉浸式翻译比？A: 轻量 + 自带 key + 免费模型可用，功能少但够用；需要全文润色/双语 epub 的请继续用沉浸式。
- Q: Firefox？A: 支持，`npx wxt build -b firefox`，需 Firefox 127+。
- Q: 为什么不上架商店？A: 在排期，当前先源码构建，构建只要三条命令。
```

- [ ] **Step 2: Commit**

```bash
git add docs/promotion/posts/01-v2ex-开源故事.md
git commit -m "docs: V2EX 分享创造主打帖成稿"
```

---

### Task 7: 选题 1 成稿 —— 掘金教程入口篇

**Files:**
- Create: `docs/promotion/posts/02-juejin-零成本教程.md`

**验收标准：** 1500–2500 字；编号步骤；配置示例含真实可用的 baseUrl；免费模型信息带「以官网为准」提示防过时。

- [ ] **Step 1: 成稿**

写入 `docs/promotion/posts/02-juejin-零成本教程.md`，结构要求如下：

```markdown
# 掘金教程（选题 1）

> 标题：零成本 AI 网页翻译：用免费大模型 API 搭建自己的翻译插件
> 标签：翻译 / Chrome插件 / DeepSeek / 前端 / 效率工具

## 正文结构与硬性内容

1. 痛点开头（≤150 字）：看英文文档/论文想双语对照，主流方案要么订阅要么有额度焦虑。
2. 效果展示：嵌入 demo-translate GIF 链接（raw 地址同 Task 6），一句话说明双语对照效果。
3. 第一步：安装插件（GitHub clone → npm install → npm run build → chrome://extensions
   加载 .output/chrome-mv3；附「不想构建可在 Releases 下载 zip」的备选说明）。
4. 第二步：拿一个免费的模型 API。以硅基流动为例：注册 → 控制台拿 API Key →
   免费模型列表（如其平台上的 Qwen 系列免费档）。明确标注：「免费模型名单随平台调整，
   以其官网为准」。同时给备选：DeepSeek（极低价）、GLM（有免费额度）、Ollama（完全本地免费）。
5. 第三步：配置插件。打开扩展「选项」页 → 添加供应商：
   - 名称：硅基流动
   - Base URL：https://api.siliconflow.cn/v1
   - API Key：上一步的 key
   - 模型：填你选的免费模型名
   配截图位置占位（发布时配 options 页截图）。
6. 第四步：开翻。popup 选供应商/模型/目标语言 → 「翻译本页」；划词直接选中即出浮窗。
7. 省钱原理小节：IndexedDB 缓存（同一段落不重复扣 token）、翻译前 token 预估、并发限流。
8. FAQ（3-4 条）：key 存哪（chrome.storage.local，只发给你配置的域名）；支持哪些模型
   （任何 OpenAI 兼容 /chat/completions）；Firefox 行不行（行，127+）；token 大概多少钱
   （给数量级估算，并提示 popup 有预估）。
9. 结尾：GitHub 链接 + 求 star + 「下篇写 Ollama 完全离线方案」引流预告。
```

- [ ] **Step 2: Commit**

```bash
git add docs/promotion/posts/02-juejin-零成本教程.md
git commit -m "docs: 掘金零成本教程入口篇成稿"
```

---

### Task 8: 选题 7 成稿 —— Show HN 英文稿

**Files:**
- Create: `docs/promotion/posts/03-show-hn.md`

**验收标准：** 标题 ≤80 字符；正文 ≤6 句 + 功能 bullets；含发布后第一条自评（HN 惯例）草稿。

- [ ] **Step 1: 成稿**

写入 `docs/promotion/posts/03-show-hn.md`：

```markdown
# Show HN（选题 7）

> 发布时间：北京时间 21:00–23:00（美国工作日上午）。发完首日盯评论。

## Title（≤80 chars，二选一，发布时用第一个）

Show HN: Minimal LLM web translation extension – your own key, free models work
Show HN: No-subscription web translation extension powered by your own LLM key

## Post body（或首条评论，视发布形式）

I got tired of paying a subscription for web page translation when I already had
API keys for DeepSeek/GLM, and free-tier models (e.g. SiliconFlow's) turned out to
be good enough for reading. So I built a minimal extension:

- Full-page bilingual translation: detects the article body (nav/sidebars skipped),
  inserts the translation under each paragraph
- Selection translation: select text and a small cat walks over — click it for a popup
  with the translation (there's a plain-dot mode if you dislike cats)
- Any OpenAI-compatible API (DeepSeek, GLM, OpenAI, Moonshot, Ollama/local), plus the
  Claude protocol; 12 target languages
- IndexedDB cache so re-reading costs zero tokens; concurrency limit + 429 backoff
- Keys stay in chrome.storage.local; requests go only to the provider you configured

TypeScript + WXT (MV3), single runtime dependency (idb-keyval), Vitest unit tests and
Playwright e2e against a stub LLM server.

GitHub: https://github.com/shen1997-hub/llm-translate-minimal
Feedback very welcome — especially on the content extraction heuristics.

## 首条自评草稿（发布后立即自评）

Backstory: the cat started as a joke — I wanted the selection button to feel less
like UI chrome and more like a companion. It docks at the screen edge, you can drag
it around, and it trots to the end of your selection. Happy to share how the drag
geometry works (clientWidth vs innerWidth was a fun scrollbar bug).
```

- [ ] **Step 2: Commit**

```bash
git add docs/promotion/posts/03-show-hn.md
git commit -m "docs: Show HN 英文发布稿成稿"
```

---

### Task 9: 发布 checklist

**Files:**
- Create: `docs/promotion/publish-checklist.md`

- [ ] **Step 1: 写 checklist**

```markdown
# 发布 Checklist

每次发帖前逐项过一遍。

## 通用（所有渠道）

- [ ] 仓库已 push 最新代码，README 顶部 GIF 在 GitHub 正常渲染
- [ ] 帖子里的 GitHub 链接可点开，无拼写错误
- [ ] 图片已传对应渠道图床（V2EX 不支持外链直显则先传图床）
- [ ] 发布后 5 分钟内自顶/自评一条（预设回复见各稿）
- [ ] 48h 内每 4-6h 看一次评论，全部回复
- [ ] 48h 后回填内容日历数据列（阅读/评论/star 增量）

## V2EX（选题 6 首发）

- [ ] 节点选「分享创造」
- [ ] 标题即稿内标题，不加多余 emoji
- [ ] 正文 GIF 走图床链接
- [ ] 准备好置顶回复预案（对标/FF/上架三问）

## 掘金（选题 1/2/12）

- [ ] 封面图 3:2（用猫咪截图或演示 GIF 截帧）
- [ ] 标签：翻译 / Chrome插件 / DeepSeek / 前端 / 效率工具
- [ ] 代码块语言标注正确（bash/json）

## 少数派（选题 4/5）

- [ ] 走投稿通道，先读其投稿指南再投
- [ ] 效率叙事为主，代码不超过 2 块

## HN（选题 7）

- [ ] 北京时间 21:00–23:00 发布
- [ ] 标题 ≤80 字符
- [ ] 发布后立即贴首条自评（backstory）
- [ ] 首日每小时看一次，礼貌回复所有技术问题

## Reddit（选题 8 等）

- [ ] 账号先正常参与社区 ≥1 周再发 self-promotion
- [ ] 读目标版块 sidebar 规则；r/selfhosted 允许开源自荐但须 flair
- [ ] 自述 ≤5 句，链接放文末

## X

- [ ] demo-cat GIF 直传（≤15MB），配 3-5 条线程
- [ ] 带 #buildinpublic #opensource，@wxt 官方可试

## B站/视频号（选题 9/10）

- [ ] 竖版 30-60s，猫咪做封面
- [ ] 简介第一行放 GitHub 链接
```

- [ ] **Step 2: Commit**

```bash
git add docs/promotion/publish-checklist.md
git commit -m "docs: 新增各渠道发布 checklist"
```

---

### Task 10: 全量回归

**Files:** 无新增；只验证。

- [ ] **Step 1: 单元测试**

Run: `npm test`
Expected: 全部通过（exit 0）

- [ ] **Step 2: e2e 回归（确认 stub-server 改动与 RECORD_DEMO 门禁无副作用）**

```bash
npm run build && npm run e2e
```

Expected: 全部通过；`demo-record.spec.ts` 被跳过（输出含 `2 skipped` 或不计入 passed），不生成 `docs/promotion/raw/` 新文件。

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 4: 交付清单核对并向用户汇报**

对照 spec 交付物 5 项逐一确认存在：spec 文档、内容日历、三篇成稿、checklist、README 门面（GIF + topics 建议）。
