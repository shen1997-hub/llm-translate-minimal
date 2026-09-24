# 参考 TWP 的整页翻译加固设计

日期：2026-09-24
状态：已批准
参考项目：[FilipePS/Traduzir-paginas-web](https://github.com/FilipePS/Traduzir-paginas-web)（TWP）

## 背景与目标

本扩展当前的整页翻译为「启发式块级提取 + 每段追加 shadow-DOM 双语译文块」。在 GitHub 等复杂页面上已暴露三类问题：译文重复渲染、译文块挤垮单行 flex 工具栏遮罩原文、UI 区域（提交栏等）被误翻译。前两类已做针对性修复，本次参考 TWP 做系统性加固。

已确认的决策：

- **保留双语对照块**的显示范式，不切换为 TWP 的原地替换 + hover 原文。
- 惰性翻译与去重采用 **TWP 原版路线**（300ms 轮询 + `getBoundingClientRect`），不用 IntersectionObserver；去重放在内容脚本侧，不改 background scheduler。

## 1. 提取层：跳过表（`lib/extraction/paragraphs.ts`）

在现有过滤链（`isExcludedContainer` + `excludedAncestors`）中新增通用跳过规则：

- `.notranslate` 类、`[translate="no"]` 属性（业界标准约定）
- `isContentEditable === true` 的元素及其子树（编辑器内容不动）
- 图标/代码字体容器：`.CodeMirror`、`.material-icons`、`.material-symbols-outlined`、`.material-symbols-rounded`

实现方式：上述选择器并入一个 `SKIPPED_ANCESTOR_SELECTOR` 常量，与 `EXCLUDED_ANCESTOR_SELECTOR` 一同参与 `el.closest(...)` 判断；`isContentEditable` 无法写成选择器，单独判断。不做 TWP 式的站点硬编码 hack（如 `#branch-select-menu`）——站点差异由既有 `SiteRule` 机制承载。

## 2. 视口惰性调度（新模块 `lib/translation/lazy-pool.ts` + `entrypoints/content.ts` 接线）

现状：`startTranslate` 收集全部段落后一次性组 chunk 全部发出。

改为：

- 新纯逻辑模块 `LazyPool`：
  - `addAll(paragraphs)` / `add(paragraph)`：入池；按段落 id（`PID_ATTR` 稳定 id）去重，同一元素重复入池只保留一份。
  - `takeVisible(getRect: (el: Element) => RectLike, margin: number): Paragraph[]`：返回已进入视口（上下各外扩 `margin`，默认 200px）的段落并从池中移除；`getRect` 注入，测试用假数据。
  - `prune()`：剔除已从 DOM 断开（`!element.isConnected`）的段落（对应 TWP 的 removedNodes 回收）。
  - `size` / `clear()`：池状态。
- `content.ts` 接线：
  - 收集到的段落入池；`setInterval` 每 **300ms** 轮询，先 `prune()` 再取可见段落。
  - **段落的 `STATE_ATTR=pending` 标记与宿主块创建推迟到「取出并发送」时进行**——入池时不打标、不建宿主，避免未视口段落提前出现「翻译中…」占位块；池内去重靠段落 id，不依赖 `STATE_ATTR`。
  - 池空后 `clearInterval`；`onNewContent`（MutationObserver 新增内容）的段落入同一池，轮询重启。
  - `visibilitychange`：页面隐藏时暂停轮询，恢复可见时重启（TWP 同款，后台标签页不做无效布局读取）。

## 3. 同文本在途合并 + 扇出分发（`entrypoints/content.ts`）

现状（临时兜底）：`collectParagraphs` 对相同规范化文本只保留首段，其余丢弃——重复内容永远不显示译文。

改为**别名机制**：

- 内容脚本维护 `aliases: Map<规范文本, paragraphId[]>`（收集时建立）。
- **取出发送时做别名扩展**：某段落被 `takeVisible` 取出时，其所有同文本别名一并从池中移除、打 `STATE_ATTR`、建宿主块；chunk 里只为该文本发一个 unit。
- `delta` 与 `result` 回来时按 `aliases` 扇出到所有同文本段落的宿主块——整页重复内容同时出现译文，且只烧一次 token。
- 缓存不变：同文本跨页面/跨任务的第二次请求自然命中已有缓存。
- 双重提取防护仍由提取层的祖先/后代去重承担（2026-09-24 已修），不依赖文本丢弃。

## 4. 代际失效补齐（`entrypoints/content.ts`，审计 + 小改）

现状：`onChunkDelta` / `onChunkResponse` 已用 `msg.taskId !== task.id || task.cancelled` 拦截陈旧响应。

本次：

- 审计 SPA 导航（`watchSpaNavigation`）、`clearAll`、`cancelTask`、retry 与流式 delta 的竞态，补齐遗漏的陈旧写入门径。
- 后台已发出的 LLM 请求不中断（TWP 同为丢弃返回值策略；结果落缓存，重译时命中，不浪费）。
- 补陈旧响应拦截的单元测试。

## 5. 错误处理

- 某一批 chunk 失败不影响池中其余段落；失败段落沿用现有 error 宿主块 + 重试按钮路径。
- 轮询回调 `try/catch` 保活，单次异常不杀死定时器。

## 6. 测试（vitest，沿用现有框架）

- `tests/lazy-pool.test.ts`：可见性分区、margin 外扩、取空后停止、clear。
- `tests/paragraphs.test.ts` 增补：跳过表各规则用例。
- 别名扇出：同文本段落只产生一个 unit，delta/result 扇出到全部宿主块。
- 代际拦截：旧 taskId 的 delta/result 不落 DOM。

## 范围外（YAGNI）

- 不改为文本节点原地替换渲染。
- 不改 background scheduler、缓存结构、marker-demux。
- 不调整并发上限与 chunk 大小策略。

## 验收标准

1. GitHub 仓库页/文件页：About 翻译，提交栏与 commit 列不翻译，无遮罩、无重复译文。
2. 长页面（如长 README）：打开时只翻译首屏附近段落，滚动后陆续出现译文；后台标签页不推进翻译。
3. 同文本重复段落：全部显示译文，network 中同文本请求只发一次（含缓存命中）。
4. `npx vitest run` 全绿；`npx wxt build` 成功。
