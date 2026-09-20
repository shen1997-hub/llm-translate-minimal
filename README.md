# 极简翻译（Minimal Translate）

基于大语言模型的网页翻译浏览器扩展：整页双语对照翻译 + 划词翻译浮窗，支持任意 OpenAI 兼容 API（DeepSeek、GLM、OpenAI、Ollama 等）。

## 功能特性

- **整页翻译**：智能识别正文区域（导航/侧边栏不翻），译文插入原段落下，双语对照
- **划词翻译**：选中文本出现小圆钮，点击弹出浮窗查看译文；支持朗读、复制、错误重试、图钉固定
- **双语向**：划词内容 CJK 占比过半自动译为英文，否则译为目标语言
- **多供应商管理**：设置页可配置多个 API 供应商（baseUrl / Key / 模型列表），随时切换
- **多语言**：原文语言默认自动检测，目标语言支持简中/繁中/英/日/韩/法/德/西/俄/葡/阿/印地 12 种
- **增量翻译**：SPA 动态加载的内容自动补翻；失败段落可单独重试
- **缓存与限流**：IndexedDB 译文缓存（按文本+模型+目标语言分键）、并发限流、429 退避、JSON 模式自动降级
- **站点控制**：popup 一键停用当前站点；支持域名黑名单

## 安装

### 从源码构建（开发者）

```bash
git clone https://github.com/shen1997-hub/llm-translate-minimal.git
cd llm-translate-minimal
npm install
npm run build        # 产物在 .output/chrome-mv3
```

然后打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `.output/chrome-mv3`。

Firefox：`npx wxt build -b firefox` 后在 `about:debugging` 加载临时扩展，需要 Firefox 127+。

### 首次使用

1. 打开扩展「选项」页，添加 API 供应商：填写名称、Base URL（OpenAI 兼容，如 `https://api.deepseek.com`）、API Key、模型名
2. 在 popup 选择供应商与模型、原文/目标语言
3. 点击「翻译本页」，或直接在页面上划词翻译

> API Key 仅存储在浏览器本地（`chrome.storage.local`），只向你配置的供应商域名发起请求。

## 开发

```bash
npm run dev          # WXT 开发模式（热重载）
npm test             # Vitest 单元测试（jsdom）
npm run typecheck    # tsc --noEmit（严格：verbatimModuleSyntax / noUncheckedIndexedAccess）
npm run build        # 生产构建
npm run e2e          # Playwright 端到端测试（真实 Chromium 加载扩展 + stub LLM 服务，需先 build）
npm run zip          # 打包发布 zip
```

### 项目结构

```
entrypoints/        # 扩展入口
  background.ts     # Service Worker：Port 消息透传到 scheduler
  content.ts        # 内容脚本：提取/渲染/任务调度/划词集成
  popup/            # 工具栏弹窗（翻译本页、语言/供应商/模型/开关）
  options/          # 设置页（供应商管理、提示词、黑名单等）
lib/
  extraction/       # 正文评分、段落提取、站点规则（如 X/Twitter）
  translation/      # 分块、prompt、LLM 客户端、调度器
  renderer/         # 段落译文宿主、划词浮窗（Shadow DOM）
  cache/            # IndexedDB 缓存（idb-keyval）
  messaging/        # 消息协议
tests/              # Vitest 单元测试
e2e/                # Playwright E2E（含 stub LLM server）
docs/superpowers/   # 设计文档与实施计划
```

### 技术栈

TypeScript · [WXT](https://wxt.dev)（MV3）· Vitest + jsdom · Playwright · idb-keyval。运行时依赖仅 idb-keyval 一个。

## 常见问题

**支持哪些模型？** 任何提供 OpenAI 兼容 `/chat/completions` 接口的服务：DeepSeek、智谱 GLM、OpenAI、Moonshot、Ollama（本地）等。支持 `response_format: json_object` 的模型体验最佳，不支持的会自动降级。

**翻译会消耗多少 token？** popup 在翻译前会预估段落数与 token 数；已翻译内容走本地缓存，重复浏览不重复计费。

## License

[MIT](LICENSE)

