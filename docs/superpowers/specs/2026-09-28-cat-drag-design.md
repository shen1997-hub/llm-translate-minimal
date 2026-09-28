# 猫咪停靠点拖拽 — 设计

日期:2026-09-28
状态:已确认(方案 A)

## 背景

猫咪助手(catMode)已上线:停靠态猫固定在视口右下角(`dockPoint`),划词后跳到选区尾 beckon,点击开面板,清空选区 return 回停靠位。用户希望能拖动停靠态的猫换位置,并全局记住。

已确认的决策:

- 拖拽落点:**自由拖动 + 贴边吸附**(松手后吸附到最近的左/右边缘,y 保持松手高度)
- 持久化:**全局持久化**,存 `chrome.storage.local` 的 settings,跨页面/重启生效
- 拖拽范围:**仅停靠态(dock)可拖**;beckon / perch(趴面板顶)不可拖
- 展示开关:沿用已有 `catMode` 设置项,不新增 UI

## 方案

拖拽逻辑收在 `lib/renderer/cat.ts` 渲染器内部。位置、动画、状态本就归它管,拖拽是自然延伸;编排层(selection.ts)只接收结果回调并持久化。

## 组件改动

### 1. 纯函数层 `lib/renderer/cat-state.ts`

新增三个纯函数,全部可单测:

- `snapDockPoint(x, y, vw, vh): { x, y }`
  松手点 `(x, y)` 吸附:按猫中心 `x + 22` 与 `vw/2` 比较,贴左缘或右缘,保持现有「只露头」peek 语义——左缘 `x = -18`,右缘 `x = vw - 26`(与 `dockPoint` 一致);`y` clamp 到 `[0, vh - 44]`(猫高 44px,保证完整可见)。吸附常量抽成导出常量,与 `dockPoint` 共用。
- `toDockRatio(x, y, vw, vh): { xRatio, yRatio }`
  像素坐标转视口比例(0–1),存储用。
- `resolveDockPoint(vw, vh, saved?: { xRatio, yRatio } | null): { x, y }`
  有 saved 时按比例还原并 clamp 到视口内;无 saved 时返回现有 `dockPoint(vw, vh)` 默认值。替代现有 `dockPoint` 的全部调用点。

### 2. 渲染器 `lib/renderer/cat.ts`

- `createCat` options 新增回调 `onDockMove?(ratio: { xRatio: number; yRatio: number }): void`。
- 停靠态(`data-state="dock"`)的 `pointerdown` 启动拖拽:
  - 记录起始指针位置与猫当前位置;`setPointerCapture` 捕获。
  - 移动超过阈值 **6px** 才进入拖动:直接 `setPoint` 跟随指针(猫中心对齐指针),`cursor: grabbing`;未超阈值不干预,保持点击语义。
  - `pointerup`:若处于拖动,调 `snapDockPoint` 得落点,用现有 WAAPI 位移动画(~200ms ease-out)滑到贴边位置,动画结束后调 `onDockMove(toDockRatio(...))`;同时置拖拽标记,**屏蔽随后的 click 事件**(不触发开面板)。
  - `pointercancel`:视为放弃,猫动画回原停靠位,不触发 onDockMove。
- 非 dock 态不挂拖拽(判断 `state === 'dock'`);beckon/perch 行为完全不变。
- 拖拽中若收到 `jumpTo`/`returnToDock` 等指令,拖拽中止(释放 capture,指令优先)。

### 3. 编排层 `lib/renderer/selection.ts` 与接线 `entrypoints/content.ts`

selection.ts 是纯渲染层,不碰 chrome.storage;持久化与设置读取都在 content.ts(它已有 `getSettings`/`saveSettings` 通路):

- `SelUICallbacks` 新增可选回调 `onCatDockMove?(ratio: DockRatio): void`,构造 cat 时透传为 `onDockMove`。
- `SelUI` 新增 `setCatDock(dock: DockRatio | null): void`:用 `resolveDockPoint` 算出像素点交给猫(`cat.setDock`);若猫当前正停在 dock 态且可见,立即 `dockNow` 重定位。
- 猫内部记住当前停靠点(`setDock`),`dockNow`/`returnToDock` 优先用覆盖值,无覆盖回退默认 `dockPoint`。
- content.ts:实现 `onCatDockMove` → `saveSettings({ catDock: ratio })`;在现有的两处设置读取(初始化、每次 mouseup 重读)里顺带 `selUI.setCatDock(s.catDock ?? null)`。**不新增 storage.onChanged 监听**(内容脚本没有该通路,mouseup 重读已覆盖跨页同步)。

### 4. 设置 `lib/settings.ts`

- `Settings` 类型新增可选字段:`catDock?: { xRatio: number; yRatio: number }`。
- 默认值:`undefined`(即默认右下角)。设置页**不新增 UI**;`catMode` 复选框保持不变。
- 读取侧对 `catDock` 做形状校验(两个有限 number,0–1 区间),非法值当作 undefined。

## 数据流

```
用户拖动停靠猫 → cat.ts 跟随 pointermove
  → pointerup → snapDockPoint 吸附 → WAAPI 滑到贴边
  → onDockMove(ratio) → content.ts saveSettings({ catDock }) → chrome.storage.local
其它页面/下次交互 → content.ts 读 settings → selUI.setCatDock → resolveDockPoint 还原
```

## 边界与错误处理

- **窗口缩放**:存比例不存像素,resize 后按比例还原并 clamp,不会跑出屏外。
- **点击 vs 拖拽**:6px 阈值;拖过阈值屏蔽 click;未超阈值保持原点击开面板行为。
- **非法存储值**:读取时校验,坏值回退默认右下角。
- **极小视口**:y 向 clamp 保证猫不超出上下边缘;x 向本来就是 peek 半露头设计,允许部分在屏外。

## 测试

单测(`tests/cat-state.test.ts` 或新文件):

- `snapDockPoint`:左半屏松手贴左缘、右半屏贴右缘、y 越界 clamp
- `toDockRatio` / `resolveDockPoint` 往返一致;无 saved 回退默认 dockPoint;非法 saved 忽略

e2e(`e2e/cat.spec.ts` 新增用例):

- 拖动停靠猫到左半屏 → 松手后吸附左缘(x = -18,左侧露头 peek)
- 刷新页面 → 猫仍停靠在左缘(持久化)
- 拖动(超过阈值)后不弹出翻译面板(click 被屏蔽)
- 点按(不超阈值)行为回归:仍走划词 beckon 链路不受影响

## 明确不做

- beckon/perch 态拖拽
- 按网站记忆停靠位置
- 设置页拖拽相关 UI
- 上下边缘吸附(只吸左右)
