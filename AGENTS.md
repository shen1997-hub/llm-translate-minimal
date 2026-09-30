# AGENTS.md

基于 LLM 的网页翻译浏览器扩展（Chrome MV3 + Firefox，[WXT](https://wxt.dev) 构建）：整页双语对照翻译 + 划词/单词查询浮窗 + 猫咪助手，支持 OpenAI 与 Claude 双协议、任意 OpenAI 兼容 API。README 为中文，面向用户；本文件面向改代码的 agent。

## 常用命令

```bash
npm run dev          # WXT 开发模式（热重载）
npm run build        # 生产构建，产物在 .output/chrome-mv3
npm test             # Vitest 单元测试（jsdom + fake-indexeddb）
npm run typecheck    # tsc --noEmit
npm run e2e          # Playwright：真实 Chromium 加载扩展 + stub LLM 服务
npm run zip          # 打包发布 zip
npx vitest run tests/scheduler.test.ts        # 跑单个单测文件
npx playwright test e2e/cat.spec.ts           # 跑单个 e2e 文件
RECORD_DEMO=1 npm run record-demo        # 录制推广演示素材（webm，产物在 docs/promotion/raw/）
```

- e2e 必须先 `npm run build`（Playwright 加载的是构建产物）。
- e2e 固定 `workers: 1`：stub server 的 fail/delay 是全局状态，勿改成并行。

## 架构与分层

消息流：`entrypoints/content.ts`（内容脚本，提取/渲染/调度）⇄ `entrypoints/background.ts`（MV3 SW）经 Port `translate` 通信；popup → background 走 runtime 消息 `start-tab`（含 content script 自愈补注入）。消息协议全部定义在 `lib/messaging/protocol.ts`，新增消息先改这里。

- `lib/translation/`：分块（chunking）、prompt、LLM 客户端（SSE 流式）、调度器（scheduler）。scheduler 依赖注入式设计（translate/lookup/cache/settings 作为参数传入），background 只做装配与并发限流（内存计数，best-effort，靠 429 退避兜底）。
- `lib/extraction/`：正文评分、段落提取、站点规则（X/Twitter 等特殊站点）、划词/单词判定。
- `lib/renderer/`：全部 UI 渲染在 Shadow DOM 宿主中（host=段落译文、selection=划词浮窗、cat=猫咪助手）。`cat-state.ts` 是纯函数（状态机/停靠点几何），`cat.ts` 是渲染器，动效在 `motion.ts`。
- `lib/cache/store.ts`：IndexedDB 译文缓存（idb-keyval），键 = 文本+模型+目标语言。
- `lib/settings.ts`：设置与 Provider（`chrome.storage.local`）；`lib/import/` 是 CC Switch 配置导入（sql.js + WASM）。

**分层铁律**：渲染层（lib/renderer/）不碰 `chrome.storage`。持久化通过回调上抛（如 `SelUICallbacks.onCatDockMove` → content.ts 调 `saveSettings`）。background 对每个 port 请求必须恰好回一个响应（try/catch 兜底回 error 响应，流式 delta 除外）。

## 已知坑

- `entrypoints/background.ts` 里硬编码 `CONTENT_SCRIPT_FILE = 'content-scripts/content.js'`：重命名 content 入口文件必须同步这里（自愈注入靠它）。
- 扩展重载后页面残留的旧 content script 调 `chrome.*` 会抛 "Extension context invalidated"：所有 chrome 调用点先过 `contextAlive()` 闸（见 content.ts）。
- MV3 CSP 含 `'wasm-unsafe-eval'`（sql.js 需要），host_permissions 为 `*://*/*`（SW 跨域 fetch 任意 API 域名）——都别随手删。
- 停靠猫几何用 `clientWidth` 而非 innerWidth（排除滚动条，右缘猫曾被经典滚动条遮挡）；停靠猫 `pointerdown` 即捕获指针（快速甩动会丢拖拽）。改猫相关代码前先读 `docs/superpowers/specs/2026-09-28-cat-drag-design.md`。
- tsconfig 继承 WXT 生成配置：strict + `verbatimModuleSyntax`（类型导入必须 `import type`）+ `noUncheckedIndexedAccess`（索引访问返回 `T | undefined`）。

## 约定

- 注释、UI 文案、提交信息均为中文；提交用中文 conventional commits（`feat:` / `fix:` / `test:` / `docs:`），参照 `git log` 现有风格。
- 单元测试在 `tests/`，与 `lib/` 模块一一对应命名；jsdom 环境仅需 `tests/setup.ts`（只引入 fake-indexeddb）。
- e2e 选择器：`[data-llm-translate-host]`（段落译文）、`[data-llm-translate-sel]`（划词浮窗）；设置注入用 `e2e/helpers.ts` 的 `seedSettings()`（经 options 页写 chrome.storage.local）；stub LLM 服务在 `e2e/stub-server.ts`，其 `/demo` 演示页返回真实中文（映射表与 `e2e/demo-page.html` 手工同步，`tests/stub-demo-map.test.ts` 护栏）。
- 功能设计与实施计划存于 `docs/superpowers/specs/`（设计）与 `docs/superpowers/plans/`（按日期命名的实施计划）。**改动某个功能前先读对应 spec/plan**，尤其猫咪助手、划词翻译、双协议这些复杂区域。
- 运行时依赖仅 idb-keyval + sql.js；新功能优先零依赖实现。
- `浏览器插件/` 是手工拷贝的构建产物，`error/` 是调试截图（未跟踪），都不是源码，勿在此改功能。
