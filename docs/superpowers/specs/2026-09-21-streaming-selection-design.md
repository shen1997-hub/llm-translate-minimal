# 流式输出 + 划词浮窗跟随选区 + 等待动画 设计文档

日期：2026-09-21
状态：已确认（流式范围＝划词＋整页、等待动画＝三点脉动、浮窗不挡划词，均经用户确认）

## 背景与目标

三个诉求：

1. 划词浮窗没有跟随当前选区：选中新文本时浮窗仍停在「上一次选中的文字尾部」，甚至吃掉新的划词动作。
2. 翻译等待期间只有静态「翻译中…」，缺过渡动画。
3. 译文要流式输出，不要等整批完成才渲染。

目标：

- 浮窗与圆钮锚定**当前选区**几何，不用鼠标坐标；浮窗不拦截页面拖拽划词。
- 等待态三点脉动动画；浮窗/圆钮出现有淡入位移；流式输出末尾有光标。
- 划词与整页译文都逐字浮现（真 SSE 流式，不是拆请求的伪流式）。

非目标：

- 不删除 JSON 模式的非流式回退能力（保留为流式解析失败时的兜底链路）。
- 不做模型侧语言检测；不做流式过程中的逐段纠错（最终以 `result` 权威文本覆盖）。
- 不引入新依赖，SSE 帧自己解。

## 问题 1：浮窗遮挡导致「漂移」（根因）

探针 `e2e/tmp-sel-probe.spec.ts`（临时文件，落地时删除）实测：

- 划词 p1 并点开浮窗后，浮窗落在选区下方 `x∈[8,308], y∈[73,191]`；测试页 p2 那一行位于 `y=93, x∈[8,1272]`——浮窗正好盖住下一段文本左半部分。
- 从浮窗覆盖区内起手长拖选 p2：选区为空、圆钮不出现、浮窗纹丝不动。
- 同一行改从浮窗覆盖区外起手长拖：选区成立、圆钮出现。

两条根因叠加：

1. 宿主元素（Shadow DOM 容器）参与命中测试：从它上面起手的拖拽不会在页面建立选区；同时 `entrypoints/content.ts` 的 `mousedown`/`mouseup` 处理器对 `pathInside(composedPath)` 直接 early-return，既不清旧浮窗、也不给新选区显示圆钮。
2. 圆钮位置取 `mouseup` 的鼠标坐标（`showDot(e.pageX + 8, e.pageY + 8)`），不是选区几何。

## 问题 1 方案

### 锚点改用选区几何

- `mouseup`：由 `window.getSelection().getRangeAt(0)` 取 `getClientRects()`，圆钮贴在**最后一段 rect 的右下角**（即选区尾），加滚动偏移，走既有 `clampPosition` 夹到视口内。
- `selectionchange`：圆钮可见时实时跟随（键盘扩选也能跟）。
- 浮窗仍以选区 rect 左下为锚（`rect.left`、`rect.bottom + 6`），保持现有观感。

### 浮窗对鼠标透明

- `.panel { pointer-events: none }`；`.header button`、`.footer button`、`.body button` 恢复 `auto`。
- `.body` 默认 `none`（短译文完全不挡），**仅当内容溢出可滚动时**（渲染后 `scrollHeight > clientHeight`）加 `.scrollable` 恢复 `auto`，保证长译文能滚轮滚动。
- 效果：从浮窗上方起手拖拽照样能选中下面正文；mousedown 落在浮窗区域时事件目标变成页面元素，既有的「点外部收起浮窗」逻辑自然生效。

### 选区变化收起旧浮窗

- 新增 `selectionchange` 处理：**选区非折叠**、与浮窗锚定文本不同、且未 pin 时收起浮窗，避免继续显示上一次的译文。
- 判定必须带「非折叠」这一条：点击圆钮/浮窗按钮会让页面选区塌陷，若塌陷也触发收起，浮窗会在打开的瞬间被自己关掉（现有 `pathInside(composedPath)` early-return 就是为同类问题加的）。点页面空白处的塌陷不在此列——既有的 mousedown 处理器已负责收起未 pin 的浮窗。
- 锚点节点落在浮窗 Shadow DOM 内的选区变化同样忽略（浮窗正文可滚动时允许被选中）。

## 问题 2：等待动画

- 等待态：行内 `<span class="dots"><i/><i/><i/></span>` + 「翻译中…」，三个 `i` 错峰脉动（`0 / .2s / .4s` 延迟）。
- 流式态：正文正常着色，末尾追加闪烁光标 `.caret`。
- 出现动画：浮窗/圆钮从 `hidden` 转可见时加 `animation: pop 120ms ease-out`（淡入 + 上移 4px）。
- `@media (prefers-reduced-motion: reduce)` 下动画全关。
- 两个渲染器（`lib/renderer/selection.ts`、`lib/renderer/host.ts`）各自 Shadow CSS 内定义同一套结构样式。

## 问题 3：流式输出

### 链路

```
content ──{kind:'translate', stream:true}──▶ background(SW)
                                             │ handleTranslateRequest(req, deps, onDelta)
                                             │   llm-client 流式请求 + marker demux
content ◀──{kind:'delta', paragraphId, sliceIndex, text}── 逐段增量
content ◀──{kind:'result', translations[]}──────────────── 结束时的权威文本
```

### 协议（`lib/messaging/protocol.ts`）

- `TranslateRequest` 增 `stream?: boolean`。**内容脚本对每一条翻译请求（划词、整页首轮、增量批次、失败重试）都置 `true`**：流式是默认且唯一路径，不加设置开关、不做灰度。字段保留可选，非流式链路（含单测里直接调 `translateUnits` 的老路径）不受影响。
- `TranslateResponse` 增：

```ts
| { kind: 'delta'; taskId: string; chunkId: string;
    paragraphId: string; sliceIndex: number; sliceTotal: number; text: string }
```

`paragraphId / sliceIndex / sliceTotal` 与 `TranslateResultItem` 同语义：整页取段落 id 与分片下标；划词沿用现有请求里的 `paragraphId: 'sel'`、`sliceIndex: 0`、`sliceTotal: 1`（`entrypoints/content.ts` 的 `selReq`），因此划词侧按 `paragraphId === 'sel'` 分流到面板、其余分流到 host。

### provider 层（`lib/translation/`）

新模块 `sse.ts`：`readSse(res, onData)` —— `res.body.getReader()` + `TextDecoder(stream: true)`，`\r\n` 归一为 `\n`，按空行切帧，取 `data:` 行（多行 `data:` 以 `\n` 拼接），`[DONE]` 跳过。

新模块 `marker-demux.ts`：增量解 `[i]` 标记。

```ts
createMarkerDemux(expected: number, onDelta: (index: number, text: string) => void): {
  push(chunk: string): void;   // 喂原始 token
  finish(): string;            // 返回累积全文，交 parsePlainResponse 权威解析
}
```

规则：

- 只在 `0 <= i < expected` 时认标记；首个标记之前的引言文本丢弃。
- 文本归属「最近一个已出现的标记」，可贪心立即吐出（下一个标记出现前它不会被别的段认领）。
- 尾部半截标记（形如 `[1`）挂起不吐，避免闪出半截标记。

`llm-client.ts` 的 `translateUnits(cfg, texts, opts, deps, onDelta?)`：

- 传 `onDelta` → 走流式：**恒 plain 模式**（JSON 无法增量解复用），请求带 `stream: true`，OpenAI 取 `choices[0].delta.content`、Claude 取 `content_block_delta.delta.text`，喂给 demux。
- 流结束后用 `parsePlainResponse(全文, texts.length)` 权威解析；缺项仍走既有逐段 `translateSingle` 兜底。
- 不传 `onDelta` → 行为与今天完全一致（JSON 优先 + 400 降级记忆）。
- 重试与错误语义不变：`requestWithRetry` 只覆盖响应头阶段（401/403 → AuthError、429/5xx 退避）；流中断按失败抛出。
- **流式失败不回退非流式**：请求（含响应头）报错时照旧走既有 error 分支（`translation-error` → host/面板失败态 + 重试按钮），不做「流式失败改发一次非流式」的补偿——否则会出现「半截流式文本 + 整段结果」的拼接复杂度，而重试按钮已经给了用户同等出口。

### 调度器（`lib/translation/scheduler.ts`）

- `handleTranslateRequest(req, deps, onDelta?)`：`req.stream === true` 时把 `onDelta` 透传给 `translateUnits`，并把 demux 的下标（对应 `pendingIdx` 子集）映射回 `unit.paragraphId/sliceIndex/sliceTotal` 再回调。
- 流式路径 `useJsonFormat: false`，且**不写入 `deps.jsonFormatSupported`**（保住 `d952590` / `6f7b392` 的语义）。
- 缓存语义不变：命中缓存不产生 delta（整段直接出现在 `result`）；流结束后照旧 `setCached`。

### 后台（`entrypoints/background.ts`）

- 端口收到 `kind:'translate'` 且 `stream:true` 时构造 `onDelta`，逐条 `port.postMessage({kind:'delta', ...})`；结束仍发 `result`。异常兜底 `error` 响应逻辑不变。

### content 侧渲染（`entrypoints/content.ts`）

- 划词：`SelUI` 增 `appendPanelText(text)` —— 切到 `streaming` 态（正常着色 + 光标）并追加；`result` 到达用权威文本整体覆盖。
- 整页：delta 按 `paragraphId` 累积进既有 `sliceBuffers.parts[sliceIndex]`，每次增量重渲染该段 host 文本（`lib/renderer/host.ts` 的 `setHostState` 增 `'streaming'` 态）。
- 超时：`armTimer` 在**收到该 chunk 的 delta 时续期**（沿用 60s：真卡住 60s 无增量才重发）；重发前先清空该 chunk 涉及段落的 `parts`，避免流式片段与重发结果叠字。
- 端口重连重发（SW 回收）路径同上，先清缓冲再重发。

### 桩服务（`e2e/stub-server.ts`）

- 请求体含 `"stream":true` 时改用 `text/event-stream` 分帧返回：把既有的 `[i] 译文i` 文本切成 3 段、每段间隔约 120ms 写出。OpenAI 用 `data: {"choices":[{"delta":{"content":"…"}}]}` + `data: [DONE]`；Claude 用 `event: content_block_delta` + `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}`。响应同样带 CORS 头；不带 `stream` 的请求保持现有 JSON 行为。

## 测试

单元（vitest）：

- `marker-demux`：跨块拆标记（`[` / `1` / `]` 分三次喂）、引言丢弃、多段归属、越界标记不认、贪心吐出后 `finish()` 全文可用于权威解析。
- `sse`：分帧（含 `\r\n`、跨块半帧）、多行 `data:`、`[DONE]`。
- `llm-client` 流式：fetch stub 返回 SSE → `onDelta` 序列与最终 `translations` 正确；401 → AuthError；流中断 → 抛错。
- `scheduler` 流式：`onDelta` 的 `paragraphId/sliceIndex` 映射正确、缓存仍写入、`jsonFormatSupported` 不被翻转；非流式路径既有测试保持绿。

E2E（Playwright，桩服务提供真分帧）：

1. 划词流式：面板先出现译文前缀（严格短于终值），随后等于终值。
2. 整页流式：某段 host 先出现前缀、随后补全。
3. 浮窗不挡划词（回归，先红后绿）：浮窗打开后，从浮窗覆盖区内起手长拖 → 选区成立、圆钮出现在新选区尾。
4. 圆钮锚定选区：现有「划词翻译」用例派发 `mouseup(clientX:100, clientY:100)`，改造后圆钮应落在选区尾（段落右下）而非 (108,108)；在既有用例上加位置断言即可，不必新写用例。
5. 等待态：面板与 host 的 loading 态含 `.dots`。

## 取舍与风险

- **流式恒 plain**：OpenAI `response_format: json_object` 不再用于流式请求，只作为非流式回退能力保留 —— JSON 无法增量解复用，这是唯一可行解。
- **长译文仍可能挡鼠标**：`.body` 溢出时可滚动 ⇒ 恢复 `pointer-events: auto`，此时从浮窗正文起手拖拽仍选不中下方正文（短译文不受影响）。
- **MV3 SW 生命周期**：流式期间端口消息持续刷活；SW 被回收时沿用端口断开 → 重连 → 重发路径，重发前清缓冲。
- **端口消息量**：逐 token 一条消息，速率与模型输出同阶（每秒数十条），比现有「每 chunk 一条」明显增加，但量级可控。