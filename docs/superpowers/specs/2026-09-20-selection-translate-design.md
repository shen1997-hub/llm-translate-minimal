# 划词翻译浮窗 设计文档

日期：2026-09-20
状态：已确认（触发方式/面板功能范围/技术路线均经用户确认：小圆点→点击弹窗、面板尽量对齐参考图、复用现有翻译通道）

## 背景与目标

参考「沉浸式翻译」的划词翻译（`img/划词翻译弹窗需求展示.png`）：用户选中网页文本后，以小圆点引导、点击弹出浮窗显示译文。目标：

1. 划词后在鼠标旁显示小圆钮，点击弹出翻译浮窗（不打扰正常选择/复制）
2. 浮窗对齐参考图：头部（logo + 模型名 + 图钉 + 关闭）、正文（译文/加载/失败重试）、底部（朗读 + 复制 + 👍👎）
3. 复用现有翻译通道（Port + scheduler + 缓存 + 限流 + 降级），background 零改动
4. 双语向：选中文本 CJK 占比 > 50% 时译为 English，否则译为设置的目标语言
5. 设置项 `selectionTranslate`（默认开），popup 加开关行

非目标：不做模型内自动语言检测、不做划词后的整段对照渲染、👍👎 不上报（纯本地视觉状态）、不做快捷键触发。

## 交互流程

1. `mouseup` 时读取 `window.getSelection()`：非折叠且折叠空白后长度 ≥ 2 → 在鼠标坐标旁（绝对定位，含滚动偏移）显示小圆钮（品红底白「译」字，Shadow DOM）
2. 点击圆钮 → 圆钮消失，按选区 `getBoundingClientRect` 位置弹出浮窗（loading「翻译中…」），同时经现有 Port 发送翻译请求
3. 响应返回 → 浮窗显示译文；失败 → 错误态 + 重试按钮
4. 关闭路径：点击浮窗与圆钮以外任意处 / Esc / 新的划词；图钉 pin 点亮后点击外部不关闭

## 数据流与协议

复用 `TranslateRequest`（`lib/messaging/protocol.ts`），仅新增一个可选字段：

```ts
interface TranslateRequest {
  kind: 'translate';
  taskId: string;      // 划词请求用 `sel-<时间戳>` 前缀
  chunkId: string;     // 固定 'c0'
  units: UnitPayload[];// 单单元 { paragraphId: 'sel', text, sliceIndex: 0, sliceTotal: 1 }
  targetLang?: string; // 新增：逐请求目标语言覆盖（划词双语向用）
}
```

- scheduler：`const targetLang = req.targetLang ?? settings.targetLang`，cacheKey 与 buildMessages 均使用该值（English 方向与中文方向缓存天然分离）
- background：零改动（消息透传）
- content：`onChunkResponse` 开头按 `taskId.startsWith('sel-')` 分流到浮窗，**先于**现有 `msg.taskId !== task.id` 守卫（划词请求与全文任务互不干扰，可并行）
- 划词请求同样享受：缓存、429 退避、response_format 降级、逐段补齐（单单元时即原样返回）

## 浮窗渲染器 `lib/renderer/selection.ts`

```ts
export const SEL_HOST_ATTR = 'data-llm-translate-sel';

export interface SelUICallbacks {
  onDotClick(): void;          // 圆钮点击（content 发请求并 showPanel）
  onClose(): void;             // 关闭按钮
  onRetry(): void;             // 错误态重试
  onCopy(text: string): void;  // 复制（content 侧 clipboard）
  onSpeak(text: string): void; // 朗读（content 侧 speechSynthesis，再次点击停止）
}

export interface SelUI {
  host: HTMLElement;                                        // 挂到 body 的容器（Shadow DOM 承载全部 UI）
  showDot(x: number, y: number): void;                      // 绝对定位坐标
  hideDot(): void;
  showPanel(x: number, y: number, model: string): void;     // 头部模型名在此设置
  setPanelState(state: 'loading' | 'done' | 'error', text?: string): void;
  hidePanel(): void;
  isPinned(): boolean;
  pathInside(path: EventTarget[]): boolean;                 // 点击外部判定（composedPath）
  destroy(): void;
}

export function createSelectionUI(doc: Document, cbs: SelUICallbacks): SelUI;
export function clampPosition(x: number, y: number, w: number, h: number, vw: number, vh: number): { x: number; y: number };
```

- 全部样式在 Shadow DOM 内；主色沿用 popup 的 `#e91e63`
- `clampPosition`：右/下边缘内收 8px，最小 8px（不做上翻转，YAGNI）
- 👍👎：渲染器内部视觉切换（互斥高亮），不产生回调
- 图钉：内部状态切换，`isPinned()` 供 content 的外点关闭逻辑查询

## content script 集成（`entrypoints/content.ts`）

- 新增 `mouseup` 监听：站点黑名单或 `selectionTranslate === false` 时跳过；否则取选区文本（`\s+` 折叠）≥ 2 字符才显示圆钮
- 新增 `mousedown` 监听：`pathInside(composedPath)` 为假时 → `hideDot()` + 非 pin 时 `hidePanel()`
- 新增 `keydown`：Esc → 同上关闭
- `onDotClick`：重新读取选区（可能已变化）；`getBoundingClientRect` + 滚动偏移 → `showPanel`（模型名 = 当前供应商 `name · resolveModel`）→ `setPanelState('loading')` → 计算方向（`cjkRatio(text) > 0.5 ? 'English' : settings.targetLang`）→ `postToPort(req)`
- `onChunkResponse` 分流：结果 → `setPanelState('done', text)`；错误 → `setPanelState('error')`；`onRetry` 重发同一请求
- `onCopy`：`navigator.clipboard.writeText`，按钮短暂变「✓」（渲染器内做 1.5s 恢复）
- `onSpeak`：`speechSynthesis.speak(SpeechSynthesisUtterance)`（再次调用先 `cancel()`，实现读/停切换）
- `isSelfMutation` 增加 `SEL_HOST_ATTR` 判定（浮窗插入不触发增量提取）
- `clearAll` 同时 `hideDot/hidePanel`

## 设置项

`Settings` 新增 `selectionTranslate: boolean`（默认 `true`，经读取合并生效，无需迁移）。popup 服务卡新增「划词翻译」开关行（iOS switch，与站点开关同样式），变更即 `saveSettings({ selectionTranslate })`。

## 错误处理

- 翻译失败 → 浮窗错误态 + 重试按钮（重发同一请求，不限次数）
- auth 错误（未配置供应商/Key 无效）→ 浮窗错误态显示 scheduler 返回的 message
- 选区在点击圆钮前已取消 → `onDotClick` 重新读取为空则不发请求、直接隐藏
- 页面 SPA 跳转 → `clearAll` 关闭浮窗

## 测试

TDD 单测：

1. `tests/settings.test.ts`：默认 `selectionTranslate === true`
2. `tests/scheduler.test.ts`：`req.targetLang` 覆盖生效（translate 调用与 cacheKey 均用覆盖值）；缺省回退 settings.targetLang
3. `tests/selection.test.ts`（新建）：
   - 初始圆钮/浮窗均隐藏；showDot 定位并显示
   - setPanelState('done') 显示译文；('error') 显示重试按钮；('loading') 显示「翻译中…」
   - clampPosition 边缘内收与最小值
   - pathInside 判定（host 内/外）
4. E2E（`e2e/translate.spec.ts` 追加 1 条）：stub 页面对段落构造选区并 dispatch mouseup → 圆钮出现 → 点击 → 浮窗显示「译文」

现有 91 单测 + 4 E2E 保持绿。

## 兼容性

- 无新权限、无新依赖（speechSynthesis/clipboard 为 Web 标准 API，无需 manifest 声明）
- Firefox 127+：`speechSynthesis` 与 `navigator.clipboard` 均可用；Shadow DOM/ composedPath 与现有渲染器同模式
