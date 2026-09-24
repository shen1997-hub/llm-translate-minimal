# 侧缘猫咪助手设计

日期：2026-09-24
状态：已批准
关联：划词翻译浮窗（`lib/renderer/selection.ts`）、设置（`lib/settings.ts`）

## 背景与目标

划词翻译的当前入口是选区尾部 26px 圆钮（`.dot`）。本设计将其替换为一只停靠在视口右缘的动画猫咪：选中文字时猫跳到选区末位提示点击，点击后打开现有翻译面板/词卡。目标是在不牺牲阅读体验（不遮内容、不挡拖选、可关闭）的前提下提供陪伴感与更明确的点击提示。

已确认决策：

- 居所形态：**右边缘停靠**（fixed 半露出，不占布局），非常驻侧边栏竖条。
- 入口关系：**猫替代圆钮**；设置提供 `catMode` 开关，关闭后回简洁圆钮。

## 1. 载体

- 复用现有划词 shadow 宿主（`SEL_HOST_ATTR`）：z-index 顶层、宿主 `pointer-events:none`、交互元素自身 `auto` 的成熟模式不变。
- 新增 `.cat`（`<button>`，shadow 内）与 `.dot` 互斥：`catMode=true` 时不显示 dot，反之不创建猫的动画循环。
- 停靠位：`position: fixed; right: -18px` 等效（`dockPoint` 为 `{vw-26, vh-72}`），垂直贴近视口底部以避开正文拖选热区；可见宽约 26px（头与前爪）。
- 存在条件：https 页面、`selectionTranslate` 开启、`catMode` 开启；打印媒体隐藏。

## 2. 状态机

五态，转移触发如下：

| 态 | 进入条件 | 表现 |
|---|---|---|
| `dock` | 初始 / 选区清空 / 选区滚出视口 / 面板关闭 | idle 眨眼（2.8s 周期）、尾巴慢摇；20s 无交互转 sleep 子态（闭眼 + zzz 气泡），任一交互唤醒 |
| `alert` | 检测到有效选区 | 耳朵竖起、转向选区方向，300ms |
| `jump` | alert 结束 | 抛物线跳向选区末位右下 8px；420ms；起跳拉伸、落地压扁 |
| `beckon` | 落地 | 轻弹两次 + 抬爪循环 + 头顶气泡「译？」；点击后进入其子态 `happy`（摇尾 600ms）并打开面板 |
| `return` | 选区清空 / 滚出视口 / 面板关闭 | 跳回 dock |

- 坐标计算复用现有选区尾逻辑（`getClientRects()` 末块 right/bottom）。
- 面板打开时猫趴到面板顶边（不遮挡译文）；面板关闭回 beckon 或 return。
- 状态转移逻辑抽为纯函数（输入：当前态 + 事件；输出：下一态），便于单测。

## 3. 动效与性能

- 全部动画仅 `transform` / `opacity`（WAAPI 或 CSS keyframes），不触发 layout。
- jump：上升慢下落快的贝塞尔；squash & stretch 用 scaleX+scaleY 双轴（起跳 `scale(0.94,1.08)`、落地 `scale(1.06,0.92)`）。
- `prefers-reduced-motion: reduce`：jump/return 退化为 120ms 位移 + 淡入，无抛物线无 squash；beckon 气泡不循环闪动。
- 猫为内联 SVG（约 2KB，无外部资源）。

## 4. 视觉规格

- 线条 + 色块风格：身体奶白 `#ffffff`、描边墨色 `#1f2328` 1.5px、围巾品牌粉 `#e91e63`、腮红 `#fdeef4`。
- 暗色模式：身体 `#e6e1e4`，围巾保持品牌粉，气泡/面板沿用浮窗暗色令牌。
- 尺寸 44×44；停靠态右移 18px 只露头。
- 帧：idle 眨眼、sleep 闭眼 + zzz、jump 耳尾独立 rotate、beckon 前爪 rotate -12° 循环、happy 尾摆幅加大。

## 5. 设置与开关

- `Settings` 新增 `catMode: boolean`，默认 `true`；旧数据迁移缺省补默认值。
- 设置页「翻译偏好」卡片新增「猫咪助手」开关（与「划词翻译」同行或下一行）。
- `selectionTranslate=false` 时猫与圆钮都不显示（现状不变）。
- popup 文案与布局不动。

## 6. 与现有链路整合

- `selection.ts` 的 mouseup / selectionchange / 词卡判定逻辑不变；`showDot` 调用点改为猫的 `jumpTo(x, y)`。
- 点猫触发原 `onDotClick` 回调 → `showPanel` / `showWordCard` 行为与样式不变。
- 面板定位 clamp 逻辑复用；面板与猫不重叠（猫趴面板顶边）。
- e2e 既有「浮窗不遮挡拖选」用例继续约束猫（猫不得挡住正文拖选命中测试）。

## 7. 测试

- vitest：状态机纯函数转移用例（dock→alert→jump→beckon→return 全路径 + sleep 唤醒 + reduced-motion 分支标记）。
- e2e：
  1. 选中文字 → 猫 boundingBox 落在选区尾附近；
  2. 点猫 → 面板出现并显示译文；
  3. `catMode=false` → 回圆钮且行为不变；
  4. 既有拖选遮挡用例通过。

## 8. 风险与取舍

- 猫比圆钮大、存在感强：以半露停靠 + sleep 降打扰平衡；审美分歧以 `catMode` 兜底。
- 动画在低端设备：transform-only + reduced-motion 兜底。
- 密集排版页面选区靠右缘时猫与选区重叠：落点 clamp 到视口内（复用 clampPosition）。

## 范围外

- 猫的语音/音效、换装/成长体系、多宠物。
- 面板与词卡的视觉改版（上一轮已完成）。
