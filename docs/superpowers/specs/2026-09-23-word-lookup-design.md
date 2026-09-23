# 划词单词详解（词典卡片）设计

日期：2026-09-23
来源需求：`需求.txt` —— 选中文字为单词时，返回单词的详解（音标、词性义项、关联词意、当前语境下的解释），而不仅仅是简单翻译。

## 决策摘要

| 决策点 | 结论 |
|---|---|
| 数据来源 | 复用已配置的 LLM，专用词典提示词，不接入词典 API |
| 语境范围 | 单词所在句子（句边界截取） |
| 展示形式 | 结构化卡片（JSON → 分区块渲染） |
| 触发范围 | 单词 + 短词组（≤3 个词，含连字符复合词） |
| 实现方案 | 独立 lookup 通道，与现有 translate 通道解耦 |

## 1. 触发判定与语境截取（entrypoints/content.ts）

- 点击「译」圆钮（`onSelDotClick`）时，对 `selectionText()` 判定：
  - 去除首尾空白后按空格分词 ≤3 个词，且不含句读符号（`。！？.!?；;` 等）→ 词典模式；
  - 否则走现有句子翻译流程，逻辑零改动。
- 词典模式取语境：用 `window.getSelection().getRangeAt(0)` 定位选区所在文本节点，在同一段落内向前/向后扩展到句子边界（`.` `!` `?` `。` `！` `？` `；` 或段落首尾），截出完整句子；超长时以单词为中心截断到约 300 字符。
- 判定函数 `isWordLike(text)` 与取句函数 `extractSentence(range)` 抽为纯函数，放 `lib/extraction/`，便于单测。

## 2. 协议与数据流（lib/messaging/protocol.ts + background）

新增消息类型：

```ts
interface LookupRequest {
  kind: 'lookup';
  taskId: string;        // `sel-` 前缀，与划词翻译一致
  word: string;
  sentence: string;
  targetLang?: string;   // 缺省用 settings.targetLang
}

type LookupResponse =
  | { kind: 'lookup-result'; taskId: string; entry: WordEntry }
  | { kind: 'error'; taskId: string; code: 'auth' | 'failed'; message: string };

interface WordEntry {
  word: string;
  phonetic?: string;
  senses: { pos: string; meaning: string }[];  // 词性 + 义项
  related: { word: string; note: string }[];   // 关联词；note = 关系标签 + 简义，如 "syn. 举起"、"ant. 降低"、"der. 名词形"
  contextual: string;                          // 当前句子语境下的解释
}
```

- background 收到 `lookup` 后走独立分支：调用 `llm-client`，使用 `lib/translation/prompt.ts` 新增的 `buildLookupMessages()`，一次性（非流式）请求，要求模型只返回 JSON。
- 新增 `parseLookupResponse()`：剥离 ```json 围栏、解析 JSON、校验字段（`senses`/`related` 至少为数组、`contextual` 为字符串），非法则返回 `failed` 错误。
- 与现有 `translate` 通道完全并行：同一 port，按 `kind` 分发；划词句子翻译的协议字段不变。

## 3. 词典卡片 UI（lib/renderer/selection.ts）

- `SelUI` 新增 `showWordCard(entry: WordEntry)` 方法，复用现有 `.panel` 容器及定位/固定/重试逻辑，正文区改为结构化渲染：
  - 头部区：单词（大号）+ 音标 + 🔊 朗读按钮
  - 义项区：每个词性一条，如 `v. 举起；提升`
  - 关联词区：chips 横排，如 `syn. raise · ant. lower`
  - 语境区：单独底色块，标题「本句中」，展示语境解释
- Shadow DOM 内新增对应 CSS；暗色主题沿用现有 `@media (prefers-color-scheme: dark)` 扩展。
- 缺失字段的区块不渲染（如无音标则不显示音标行）。
- 复制按钮复制格式化纯文本（单词+音标+义项+关联词+语境解释）；朗读按钮读单词本身。
- 面板宽度从 300px 加宽到约 340px。

## 4. 错误处理

- 复用现有面板错误态 + 重试按钮：超时（沿用 `armSelTimer`）、auth 失败、JSON 解析失败均显示错误信息和「重试」；重试重发原 `LookupRequest`。
- 陈旧响应防护与划词翻译一致：按 `taskId` 比对，非当前任务的结果忽略。

## 5. 测试（vitest，tests/ 目录）

- `isWordLike`：单词、连字符词、2-3 词词组、句子、含标点等边界用例。
- `extractSentence`：句中/句首/句尾选区、跨标点、超长截断。
- `buildLookupMessages` + `parseLookupResponse`：合法 JSON、带围栏、缺字段、非 JSON 的容错。
- UI 渲染不写 DOM 单测；可视 e2e 成本决定是否补一条 stub-server 词典用例。

## 非目标（YAGNI）

- 不接入外部词典 API；不做单词本/生词收藏；不做词典卡片的流式输出；整页翻译流程不改动。
