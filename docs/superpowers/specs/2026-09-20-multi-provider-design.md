# 多 API 供应商支持 设计文档

日期：2026-09-20
状态：已确认（用户于对话中确认设计与实施顺序：先本特性，后划词翻译）

## 背景与目标

当前插件只支持单一 LLM 配置（`baseUrl`/`apiKey`/`model` 平铺在 settings 里）。用户需要：

1. 配置**多个** API 供应商（如 DeepSeek、GLM、OpenAI 兼容服务），随时切换
2. 设置页中供应商以列表管理，编辑表单**保存后折叠**回摘要行
3. Popup 中可直接选择当前供应商（对齐「沉浸式翻译」的「翻译服务」下拉）

非目标：不改变翻译链路协议、不做供应商级速率限制、不引入供应商预设模板。

## 数据模型

```ts
interface Provider {
  id: string;        // 生成：'pv-' + 时间戳 + 随机后缀，创建后不变
  name: string;      // 用户可读的供应商名（如 "DeepSeek"）
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface Settings {
  // 新增
  providers: Provider[];
  activeProviderId: string;   // '' 表示无可用供应商
  // 保留（全局，不随供应商变）
  systemPrompt: string;
  targetLang: string;
  blacklist: string[];
  disabledSites: string[];
  minLength: number;
  cjkRatioThreshold: number;
  // 废弃（迁移后不再写入）：baseUrl, apiKey, model
}
```

`DEFAULT_SETTINGS` 新增 `providers: []`、`activeProviderId: ''`；保留废弃字段的默认值以兼容旧测试与读取合并，但保存时不再写入。

## 迁移逻辑（`lib/settings.ts`）

`getSettings()` 读取后执行一次性惰性迁移：

- 若 `providers` 为空且存在旧的 `baseUrl`（或 apiKey/model 任一非空）：构造单个 Provider `{ id: 'pv-legacy', name: 从 baseUrl 推断主机名, baseUrl, apiKey, model }`，写入 `providers` 并设 `activeProviderId = 'pv-legacy'`，同时**回写存储**（持久化迁移结果，避免每次读取重复迁移）。
- 迁移名称推断：`new URL(baseUrl).hostname` 去掉 `api.` 前缀（如 `api.deepseek.com` → `deepseek.com`）；URL 非法时用 `'默认供应商'`。

## 供应商解析

```ts
getActiveProvider(settings: Settings): Provider | null
// activeProviderId 命中 → 返回；未命中但 providers 非空 → 返回第一个；空 → null

// 设置页/Popup 使用的三个新函数（内部均基于 getSettings/saveSettings）：
saveProvider(provider: Provider): Promise<void>   // id 已存在则更新，否则追加；首个供应商自动设为当前
deleteProvider(id: string): Promise<void>          // 删除当前供应商时 activeProviderId 回退到剩余第一个（或 ''）
setActiveProvider(id: string): Promise<void>
```

消费方：

- `lib/translation/scheduler.ts` 的 `SchedulerDeps.getSettings` 返回类型扩展为含 `providers`/`activeProviderId` 的完整 Settings；`handleTranslateRequest` 内改为 `getActiveProvider(settings)` 取 `LlmConfig`。provider 为 null（未配置）时返回 `code: 'auth'` 错误响应（message 提示去设置页配置），与现有鉴权错误路径一致。
- popup/options/划词翻译（后续特性）读取模型名等展示信息时同样走 `getActiveProvider`。

## 设置页 UI（`entrypoints/options/`）

保持当前设计语言（浅灰蓝背景 + 白色圆角卡片 + 品红主按钮）。

「API 供应商」卡片替换原「接口配置」卡片：

- **列表态**：每个供应商一行——名称（主）+ 模型（次，灰字）+ 右侧「当前」标记/「设为当前」+「编辑」+「删除」。
- **编辑态**：点「编辑」或底部「+ 添加供应商」展开行内表单（名称 / Base URL / API Key / 模型）。**点「保存」校验通过后表单折叠回摘要行**（即本次需求的「保存收起弹窗」）；校验失败（名称/baseUrl 为空、baseUrl 非法 URL）在行内红字提示，不折叠。
- 「删除」：直接删除；若删的是当前供应商，`activeProviderId` 改为剩余第一个（或空）。
- 「设为当前」：立即持久化，无需点页面底部保存。
- 底部「保存」按钮仍负责全局项（系统提示词/目标语言/阈值/黑名单）；供应商的增删改在各行内即时持久化（避免「列表编辑了一半点页面保存导致状态分叉」的双写问题）。

「接口配置」卡片中的系统提示词移到「翻译偏好」卡片；授权状态显示逻辑不变（静态 host_permissions 后恒为已授权）。

## Popup UI（`entrypoints/popup/`）

- 信息卡第一行「翻译模型」改为「翻译服务」：当前供应商名 + 模型（如 `DeepSeek · deepseek-chat`），点击展开下拉列出所有供应商，选择即写入 `activeProviderId` 并刷新显示。
- 无任何供应商时该行显示「未配置，点击前往设置」并链接到设置页。
- 下拉用原生 `<select>` 样式化，不引入组件库（保持 vanilla TS 约束）。

## 错误处理

- 未配置任何供应商时发起翻译：scheduler 返回 `code: 'auth'`，content script 走现有 auth 错误路径（popup 显示提示并终止任务）。
- `activeProviderId` 悬空（供应商被删后残留）：`getActiveProvider` 回退到第一个，读取即自愈。
- 迁移过程中 URL 解析失败：名称回退 `'默认供应商'`，不阻断读取。

## 测试

TDD 单测（`tests/settings.test.ts` 扩展 + 新增用例）：

1. 旧单配置 → `getSettings` 自动迁移出单个供应商并回写
2. 已是多供应商结构 → 不重复迁移
3. `getActiveProvider`：命中 / 悬空回退 / 空列表返回 null
4. providers CRUD（`saveProvider`/`deleteProvider`/`setActiveProvider` 三个新函数）
5. scheduler：无供应商时返回 `code: 'auth'`

UI 交互（列表展开/折叠/下拉切换）由手动验收覆盖；现有 62+15 单测与 4 条 E2E 必须保持绿。

## 兼容性

- 存储中的旧字段读取合并保留，不影响已存数据；`saveSettings` 不再写入废弃字段。
- Firefox 127+ / Chrome 116+ 无新增 API，无兼容风险。
