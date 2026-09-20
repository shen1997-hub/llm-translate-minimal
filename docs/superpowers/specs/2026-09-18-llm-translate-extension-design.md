# 大模型网页对照翻译插件 — 设计文档

日期：2026-09-18
状态：待用户审阅

## 目标

开发一个浏览器插件，将网页上的英文内容翻译为中文，以「全文对照」方式呈现（原文段落下方显示译文）。翻译引擎使用大模型 API（OpenAI 兼容协议），用户填写自己的 API Key。

## 技术选型

- 框架：WXT（TypeScript，Manifest V3，一套代码打包 Chrome / Firefox）
- 翻译协议：OpenAI 兼容的 `/chat/completions`，用户可配置 base URL / API Key / 模型名，支持 DeepSeek、Kimi、OpenAI 等任意兼容厂商
- 结构化输出：`response_format: { type: 'json_object' }`
- 缓存存储：IndexedDB（`idb-keyval`）
- 测试：Vitest（单元）+ Playwright（E2E，加载真实扩展）

## 整体架构

```
┌─────────────────────────────────────────────┐
│ Popup（点击图标）                              │
│  开关当前页翻译 / 显示进度与 token 预估          │
│  申请 API 域名授权（需用户手势）                 │
└──────────────┬───────────────────────────────┘
               │ 发消息
┌──────────────▼───────────────────────────────┐
│ Content Script（注入网页）                      │
│  正文识别 + 段落提取器                          │
│  译文渲染器（Shadow DOM 隔离）                   │
│  持有本次翻译任务的状态与进度                     │
│  （只负责 DOM，不直接调 API）                    │
└──────────────┬───────────────────────────────┘
               │ Port 长连接（chrome.runtime.connect）
               │ 每条消息带任务 id + 分块 id，支持断开重连
┌──────────────▼───────────────────────────────┐
│ Background Service Worker（无状态）             │
│  按字符数分块 → 并发限流 → 调 LLM API            │
│  任务状态持久化在 chrome.storage.session       │
└──────────────┬───────────────────────────────┘
               │ OpenAI 兼容 HTTP 请求
               │ 缓存读写：IndexedDB
        DeepSeek / Kimi / OpenAI …
```

关键决策：

1. **API 调用放在 background 而非 content script**：content script 的 `fetch` 运行在页面上下文，既受页面 CSP 的 `connect-src` 约束，API Key 也会暴露给页面脚本。放 background 同时解决这两个问题。
2. **background 保持无状态**：MV3 Service Worker 空闲约 30 秒即被终止，不能依赖内存中的队列、进度或去重集合。任务状态放 content script，跨请求的中间态放 `chrome.storage.session`。
3. **译文用 Shadow DOM 承载**：避免网页 CSS 污染译文样式，也避免译文样式污染网页。

## 核心组件

### 1. 正文识别与段落提取器（content script）

只靠 `querySelectorAll('p, li, h1-h3, blockquote')` 会把导航栏、页脚、侧边栏、cookie 提示全部翻一遍 —— `<li>` 在导航里是主体。提取必须分为「识别正文区域」和「提取段落」两步。

**第一步：正文区域识别（启发式打分，参考 Readability.js 思路，不引入该库）**

- 硬排除：`nav`、`aside`、`footer`、`header`、`[role="navigation"]`、`[role="complementary"]`、`[role="banner"]`、`[aria-hidden="true"]`，以及 class/id 命中负向关键词（`nav`、`menu`、`sidebar`、`footer`、`comment`、`promo`、`banner`、`cookie`、`related`、`share`）的容器
- 硬加分：`article`、`main`、`[role="main"]`、`[itemprop="articleBody"]`
- 打分指标：文本密度（文本长度 / 节点数）、链接密度（`a` 文本长度 / 容器文本长度，超过 50% 直接丢弃）、块级子元素数量
- 选出得分最高的容器作为正文根；找不到合格容器时退化到 `document.body` 并启用更严格的过滤阈值

**第二步：段落提取**

- 候选元素：`p`、`li`、`h1`–`h4`、`blockquote`、`td`、`th`、`dd`、`dt`、`figcaption`
- 通用块级文本补充：只含内联子元素（`span`/`a`/`em` 等）或无子元素、且不含候选后代的 `div` 也视为候选（覆盖 X/Facebook 等 `div + span` 正文结构），但适用更严的长度阈值（≥ 60 字符），避免抓到卡片/按钮碎文本
- 排除容器过滤：候选元素自身命中负向规则，或其任意祖先命中第一步的结构性排除（`nav`/`aside`/`footer`/`header`/排除 role/`aria-hidden`）时直接跳过——即使正文根容器包含侧栏，侧栏内容也不会被提取
- 站点规则（`lib/extraction/site-rules.ts`）：按域名命中 `{ rootSelector, extraCandidates, extraExcludes }`。`rootSelector` 命中时直接作为正文根（跳过评分）；`extraCandidates` 追加站点特有的候选选择器；`extraExcludes` 追加站点特有的排除祖先。当前内置 X/Twitter 规则（主栏 `[data-testid="primaryColumn"]` + 推文 `[data-testid="tweetText"]`）
- **只取最内层候选元素**：若某候选元素内部还存在候选块级元素、且内部候选元素文本占该元素文本的 70% 以上，则跳过外层。解决 `<blockquote><p>…</p></blockquote>`、`<li><p>…</p></li>` 被重复提取的问题
- 可见性：用 `textContent` 而非 `innerText`（`innerText` 会强制 reflow，大量调用有性能问题，且 jsdom 未实现导致无法单元测试）。可见性单独判断：`getComputedStyle` 的 `display`/`visibility` 均非隐藏值，且（`offsetParent !== null` 或 `position === 'fixed'`——`offsetParent` 对 fixed 元素恒为 `null`，需特判，否则悬浮正文会被误判为不可见）
- 过滤规则（阈值均为设置项，默认值如下）：
  - 纯空白，或去空白后长度 < 20 字符
  - 中文字符占比 > 30%（默认值；中英混排的技术文章容易误判，需可调）
  - 位于 `<pre>` / `<code>` 内
  - 无可翻译的拉丁字母（纯数字、纯符号、纯 CJK）

**第三步：增量提取（SPA）**

- `MutationObserver` **仅在翻译开启后启动**，监听 `document.body` 的 `childList` + `subtree`；关闭翻译或站点开关时 `disconnect()`，未翻译的页面不承担任何监听开销
- **必须过滤自触发**：译文插入本身会产生 mutation，需检查 `mutation.target` 是否落在 `[data-llm-translate-host]` 内，是则跳过，否则形成死循环
- debounce 300ms 后再执行提取
- 已处理节点用 DOM 标记（`data-llm-translate-state`）而非仅用内存 WeakSet —— WeakSet 在页面重载后失效，且无法用于清理

### 2. 翻译调度器（background，无状态）

- **分块按字符数**而非段数：单批总字符 ≤ 1500，且保持 DOM 顺序连续，不跨 section 拼接（跨段落拼接会破坏上下文，代词与省略句质量明显下降）
- 单段超长（> 1500 字符）时按句子边界分片，分片共享同一段落 id，全部返回后再拼合渲染
- **结构化输出**：请求带 `response_format: { type: 'json_object' }`，提示词要求返回 `{"items":[{"i":0,"t":"译文"}]}`，按 `i` 对齐而非解析文本编号。模型漏编号、合并编号、或段落正文含数字都不会导致错位
- 并发上限 3；429 / 5xx 指数退避重试。并发计数在内存中，属于 best-effort —— SW 被终止重启后计数重置是可接受的，偶发超限由 API 侧 429 + 退避兜底
- 每个分块的处理幂等：同一批次可安全重发，重发前先查缓存
- 流式响应：**只做「组级流式」**——一组完成后立即回传渲染。不做逐 token 流式，因为它与批量拼段落矛盾（需要在 token 流中增量解析部分 JSON），且翻译场景读者不会读半个句子

### 3. 译文渲染器（content script）

- 每个段落对应一个 host 元素，`attachShadow({ mode: 'open' })`，译文样式写在 shadow 内部，用 `prefers-color-scheme` 适配深色模式（浅色左边框在暗色网页上很扎眼）
- host 带 `data-llm-translate-host` 与唯一 id，作为渲染、更新、清理的唯一依据
- 插入位置：
  - `p` / `h1`–`h4` / `blockquote` / `td` / `th` / `dd` / `dt` / `figcaption` → 作为**兄弟节点插到元素之后**
  - `li` → 插入到 **`li` 内部末尾**（插到 `li` 与 `ul` 之间会产生非法 HTML）
  - 父容器 `display` 为 `flex` / `grid` 时，兄弟插入会成为 flex/grid item 破坏布局，此时给 host 加 `flex-basis: 100%`（容器为 `column` 方向时改用 `width: 100%`）使其独占一行
- **如实说明取舍**：插入节点必然影响 `:nth-child`、`+` 选择器及部分 JS 的 `children` 遍历，无法完全避免。缓解手段是尽量插在元素紧后、并给节点打标记，便于网页脚本识别与自身清理
- 状态：翻译中显示占位 spinner，成功显示译文，失败显示「重试」按钮（重试只重发该组）

### 4. 设置页（options page）

- base URL、API Key、模型名、系统提示词（可自定义翻译风格）
- 目标语言（默认中文）、网站黑名单（不注入的域名）
- 过滤阈值：最短长度、中文占比阈值（可调，见上）
- **API 域名授权入口**：显示当前授权状态，提供「授权访问 API 域名」按钮（见下节）
- 站点级开关状态持久化：用户对某站点关闭翻译后，刷新与再次访问保持关闭

### 5. Popup

- 开关当前页翻译、显示状态
- 翻译前显示预估：「将翻译 N 段 / 约 M tokens」（估算方法：`tokens ≈ 总字符数 / 3.5`，仅作数量级提示），避免用户事后看账单才发现成本
- 翻译中显示进度（已完成 / 总数），按钮变为「取消」：取消时 content script 停止发送后续分块、标记任务终止，在途请求的结果到达后按任务状态直接丢弃（不渲染、不写缓存）
- 关闭站点开关时，content script 移除页面上所有 `data-llm-translate-host` 译文节点并停止监听（恢复原页面）
- 「授权 API 域名」按钮（`chrome.permissions.request()` 需在用户手势中调用，只有 popup / options 这类前台上下文可以发起）

## 权限与跨域

这是原设计的硬缺口：background 的 `fetch` 不受页面 CSP 约束，但**仍然受 CORS 约束**，必须靠 `host_permissions` 绕过，否则请求直接被浏览器拦截。

难点在于 base URL 由用户自由填写，域名无法预知，因此不能静态声明。方案：

- manifest 声明 `optional_host_permissions: ["*://*/*"]`（这只是可申请的上限，不是实际申请范围）
- 实际申请按用户配置的具体 API 域名：`chrome.permissions.request({ origins: ["https://api.deepseek.com/*"] })`。申请全量通配权限的用户体验差，且商店审核更严。base URL 变更后，旧域名权限可用 `chrome.permissions.remove()` 回收
- `chrome.permissions.request()` **必须在用户手势中调用**，无法由 Service Worker 自行发起。因此流程是：用户在 options 保存设置、或在 popup 点「授权」时申请；首次翻译时若未授权，background 返回明确的错误码，由 content script / popup 提示并引导用户点击授权按钮
- 用户拒绝授权时给出降级提示，不静默失败
- 权限授予后 `chrome.permissions.onAdded` / `onRemoved` 事件用于同步授权状态展示
- 兼容性：Firefox 对 `optional_host_permissions` 的支持要求 Firefox 127+，低版本需在安装时声明静态权限并提示用户升级

## 缓存设计

- 存储：IndexedDB（`idb-keyval`）。`chrome.storage.local` 默认配额仅 10MB（一个长文就几十 KB，很快见底），且没有内建 LRU —— 实现 LRU 需每次读全表算时间戳，开销不划算。IndexedDB 天然支持大容量与按时间索引排序
- key 构成：`hash(normalizedText + promptVersion + model + targetLang)`
  - 必须包含 `promptVersion`、`model`、`targetLang`，否则用户换模型或改提示词后旧译文仍会命中，且无法区分译文来源
  - `normalizedText` 先做 trim + 空白折叠，提升命中率
- value：译文 + 模型名 + 提示词版本 + 创建/最后访问时间
- 清理：按最后访问时间做 LRU，上限 5000 条或 50MB，超限时批量淘汰
- **API Key 只存 `chrome.storage.local`**（网页脚本读不到），**禁止使用 `chrome.storage.sync`** —— 会同步到云端，且有 8KB/item 限制

## 数据流

1. 用户点 popup 的「翻译本页」→ popup 向当前 tab 的 content script 发消息
2. 提取器识别正文区域、收集待翻段落（跳过已处理的），创建任务 id，任务状态存于 content script
3. content script 与 background 建立 `chrome.runtime.connect` Port 长连接；按字符数分块（≤1500 字符，DOM 顺序连续）→ 逐块发送，每条消息带任务 id + 分块 id（用于重连后对账与幂等重发）
4. background 查缓存 → 未命中的构造 JSON 输出请求 → 并发调 LLM（上限 3）
5. 每组结果返回后立即回传 content script 渲染对应段落（不等全部完成）；结果写入 IndexedDB
6. content script 更新进度；全部完成后 popup 状态置为「已完成」

## 错误处理

- 网络 / 限流失败：单组重试最多 3 次（退避 1s / 2s / 4s），仍失败则该组段落标记失败，其余不受影响
- API Key 无效（401）：停止本次翻译，popup 显示明确提示并引导跳转设置页
- 权限未授予：background 返回专用错误码，提示用户点击授权按钮
- 返回格式异常（JSON 解析失败或 `items` 缺项）：该组降级为逐段单独请求，再失败则标错
- 厂商不支持 `response_format`（400 且错误信息涉及该字段）：本任务内记住该结果，自动降级为不带 `response_format` 重发，提示词中改为纯文本编号格式（`[0] 译文`），解析失败再走逐段降级
- **Service Worker 被终止**：任务状态存于 content script 与 `chrome.storage.session`，重连后按任务 id 重取未完成分块并重发（分块处理幂等，重发前先查缓存）。消息端口断开时 content script 侧自动重连
- SPA 路由切换：检测到 `<body>` 被替换或 URL 变化时，清除旧译文标记与任务状态，用户可重新触发。history API 常被框架代理，不能只依赖对其打补丁

## 测试方案

### 单元测试（Vitest）

- 把提取逻辑抽成纯函数 `extractParagraphs(root: Element, opts): Paragraph[]`，可见性判断通过依赖注入传入（测试时传 stub），核心逻辑不依赖浏览器 API
- **jsdom 未实现 `innerText`（返回 `undefined`）**，因此提取器必须基于 `textContent`（见「核心组件 1」）。若需要真实布局行为，改用 happy-dom 或交给 Playwright E2E
- 用例覆盖：
  - 正文识别：导航 / 侧边栏 / 页脚 / cookie 提示不被选中；`article` 主体被选中；无合格容器时的退化路径
  - 嵌套去重：`<blockquote><p>`、`<li><p>` 只提取一次
  - 过滤规则：短文本、中文占比、代码块、可见性
  - 分块：按字符数切分、DOM 顺序保持、超长段落分片与拼合
  - JSON 解析与降级：缺项、解析失败、`i` 乱序
  - 缓存：key 生成（含 promptVersion / model / targetLang 变更后失效）、LRU 淘汰

### E2E（Playwright）

- 加载真实扩展，拦截 LLM 请求打桩，不消耗真实 API 额度
- 覆盖：译文插入位置正确、不破坏原页面交互、SPA 动态加载内容可翻、失败段落可重试、切换站点开关后刷新保持

### 手动验收

- 真实页面：Wikipedia、技术博客（Medium / dev.to）、SPA（GitHub / X）
- 验证点：导航与侧边栏未被翻译、译文位置正确、深色模式下译文可读、动态加载内容可翻
- 用真实 API Key 跑完整流程，确认组级流式渲染与缓存生效

## 明确不做（YAGNI）

- 逐 token 流式渲染（改为组级流式，见「核心组件 2」）
- 划词 / 悬停翻译
- 内置免费翻译源（谷歌 / 微软网页接口）
- PDF 翻译
- 译文替换原文的「沉浸模式」切换（仅对照模式）

## 已知限制

- 插入译文节点会影响网页的 `:nth-child` / `+` 选择器与 `children` 遍历，无法完全避免
- 正文识别是启发式的，个别站点仍可能误判，需要通过站点黑名单与阈值配置兜底
- 中文字符占比阈值对中英混排内容天然不精确，默认值只是经验值

## 修订记录

- 2026-09-18 初稿
- 2026-09-18 评审修订：补充正文识别启发式、嵌套元素去重、`optional_host_permissions` 与用户手势授权流程、Service Worker 生命周期与无状态约束、IndexedDB 缓存与 key 构成、Shadow DOM 隔离与插入位置规则、MutationObserver 自触发过滤、jsdom 限制与纯函数抽取、组级流式替代逐 token 流式、成本预估与站点开关持久化
- 2026-09-18 复核修订：补齐 `th`/`dt` 插入位置规则；明确 Port 长连接通道与消息 id 约定；标注并发限流为 best-effort；新增 `response_format` 不兼容（400）降级路径；权限申请收窄为具体 API 域名并支持回收；新增翻译取消与关闭时译文清理流程；明确 MutationObserver 启动/停止时机；可见性判断对 `position: fixed` 特判；写明 token 估算方法；补充 Firefox 127+ 兼容性备注