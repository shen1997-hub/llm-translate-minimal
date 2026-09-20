# 多 API 供应商 + 模型/语言选择 设计文档

日期：2026-09-20
状态：已确认（用户于对话中确认设计、两级模型选择方案与实施顺序：先本特性，后划词翻译）

## 背景与目标

当前插件只支持单一 LLM 配置（`baseUrl`/`apiKey`/`model` 平铺在 settings 里），语言只有自由文本的 `targetLang`。用户需要：

1. 配置**多个** API 供应商（如 DeepSeek、GLM、OpenAI 兼容服务），随时切换
2. 每个供应商可配置**多个模型**（配置页维护），Popup 中两级选择：先选供应商、再选模型
3. **原文语言**选择，默认「自动检测」；**目标语言**从多国语言列表选择，默认简体中文
4. 设置页中供应商以列表管理，编辑表单**保存后折叠**回摘要行

非目标：不改变翻译链路协议、不做供应商级速率限制、不引入供应商预设模板、不做语言的自动检测实现（「自动检测」= 提示词不指定源语言，交给模型）。

## 数据模型

```ts
interface Provider {
  id: string;          // 生成：'pv-' + 时间戳 + 随机后缀，创建后不变
  name: string;        // 用户可读的供应商名（如 "DeepSeek"）
  baseUrl: string;
  apiKey: string;
  models: string[];    // 该供应商下可用的模型名列表
  activeModel: string; // 该供应商当前选中的模型（随供应商记忆，切换回来不丢）
}

interface Settings {
  // 新增
  providers: Provider[];
  activeProviderId: string;   // '' 表示无可用供应商
  sourceLang: string;         // 'auto'（默认）或语言名；仅影响提示词
  // 保留（全局，不随供应商变）
  systemPrompt: string;
  targetLang: string;         // 默认值改为 '简体中文'，从 LANGUAGES 列表选择
  blacklist: string[];
  disabledSites: string[];
  minLength: number;
  cjkRatioThreshold: number;
  // 废弃（迁移后不再写入）：baseUrl, apiKey, model
}

// lib/settings.ts 导出，popup 语言下拉与校验共用
const LANGUAGES: string[] = [
  '简体中文', '繁体中文', 'English', '日本語', '한국어', 'Français',
  'Deutsch', 'Español', 'Русский', 'Português', 'العربية', 'हिन्दी',
];
```

`DEFAULT_SETTINGS` 新增 `providers: []`、`activeProviderId: ''`、`sourceLang: 'auto'`，`targetLang` 默认值改为 `'简体中文'`；保留废弃字段的默认值以兼容旧数据读取合并，但保存时不再写入。

## 迁移逻辑（`lib/settings.ts`）

`getSettings()` 读取后执行一次性惰性迁移：

- 若 `providers` 为空且存在旧的 `baseUrl`（或 apiKey/model 任一非空）：构造单个 Provider `{ id: 'pv-legacy', name: 推断名, baseUrl, apiKey, models: model ? [model] : [], activeModel: model ?? '' }`，写入 `providers` 并设 `activeProviderId = 'pv-legacy'`，同时**回写存储**（避免每次读取重复迁移）。
- 迁移名称推断：`new URL(baseUrl).hostname` 去掉 `api.` 前缀（如 `api.deepseek.com` → `deepseek.com`）；URL 非法时用 `'默认供应商'`。
- 旧 `targetLang: '中文'` 等自由文本**不迁移**，原样保留（提示词仅做插值，自由文本依然有效）。

## 供应商与模型解析

```ts
getActiveProvider(settings: Settings): Provider | null
// activeProviderId 命中 → 返回；未命中但 providers 非空 → 返回第一个；空 → null

resolveModel(provider: Provider): string
// activeModel ∈ models → 返回；否则 models[0]；空列表 → ''

// 设置页/Popup 使用的新函数（内部均基于 getSettings/saveSettings）：
saveProvider(provider: Provider): Promise<void>   // id 已存在则更新，否则追加；首个供应商自动设为当前
deleteProvider(id: string): Promise<void>          // 删除当前供应商时 activeProviderId 回退到剩余第一个（或 ''）
setActiveProvider(id: string): Promise<void>
setActiveModel(providerId: string, model: string): Promise<void>  // 写入该 provider 的 activeModel
```

调度器（`handleTranslateRequest`）取 `LlmConfig` 的方式改为：

```ts
const provider = getActiveProvider(settings);
if (!provider) → 返回 code: 'auth' 错误响应（提示去设置页配置）
const cfg = { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: resolveModel(provider) };
```

## 提示词与语言（`lib/translation/prompt.ts`）

`buildMessages` 增加 `sourceLang` 参数：

```ts
buildMessages(texts, targetLang, systemPrompt, mode, sourceLang?)
// sourceLang 缺省或为 'auto'：维持现有措辞 "Translate the following texts to {targetLang}."
// 指定语言："Translate the following texts from {sourceLang} to {targetLang}."
```

scheduler 调用时透传 `settings.sourceLang`。`targetLang`/`sourceLang` 均以语言名直接插值（LLM 可理解中文语言名），`LANGUAGES` 仅供 UI 下拉与默认值。

## 设置页 UI（`entrypoints/options/`）

保持当前设计语言（浅灰蓝背景 + 白色圆角卡片 + 品红主按钮）。

「API 供应商」卡片替换原「接口配置」卡片：

- **列表态**：每个供应商一行——名称（主）+ 当前模型（次，灰字）+ 右侧「当前」标记/「设为当前」+「编辑」+「删除」。
- **编辑态**：点「编辑」或底部「+ 添加供应商」展开行内表单（名称 / Base URL / API Key / 模型列表（逗号分隔，首个为默认选中模型））。**点「保存」校验通过后表单折叠回摘要行**（即「保存收起弹窗」需求）；校验失败（名称为空、baseUrl 非法 URL、模型列表为空）在行内红字提示，不折叠。
- 「删除」：直接删除；若删的是当前供应商，`activeProviderId` 回退到剩余第一个（或空）。
- 「设为当前」：立即持久化，无需点页面底部保存。
- 供应商的增删改在各行内即时持久化；底部「保存」按钮只负责全局项。

「翻译偏好」卡片：系统提示词（从原接口配置卡移入）、目标语言（改为 `LANGUAGES` 下拉）、最短段落长度、中文占比阈值。站点管理卡不变。

## Popup UI（`entrypoints/popup/`）

对齐参考图的顶部卡片 + 服务卡片，全部用样式化的原生 `<select>`（保持 vanilla TS 约束）：

- **语言卡**（新增，置于最上）：左「原文语言」下拉（`自动检测` + `LANGUAGES`，默认自动检测）→ 右「目标语言」下拉（`LANGUAGES`，默认简体中文）。变更即写入 `sourceLang`/`targetLang`。
- **服务卡**：
  - 行 1「翻译服务」：供应商下拉（当前 `供应商名`），切换写 `activeProviderId`，联动刷新行 2。
  - 行 2「模型」：当前供应商的 `models` 下拉（当前 `activeModel`），切换写该 provider 的 `activeModel`。
  - 行 3「在此站点启用」开关（原有）。
- 无任何供应商时服务卡显示「未配置，点击前往设置」并链接设置页。

## 错误处理

- 未配置任何供应商时发起翻译：scheduler 返回 `code: 'auth'`，走现有 auth 错误路径。
- `activeProviderId` 悬空：`getActiveProvider` 回退第一个，读取即自愈。
- `activeModel` 悬空（模型列表被编辑后）：`resolveModel` 回退 `models[0]`。
- 迁移中 URL 解析失败：名称回退 `'默认供应商'`，不阻断读取。

## 测试

TDD 单测（`tests/settings.test.ts` 扩展 + `tests/prompt.test.ts` 扩展 + `tests/scheduler.test.ts` 扩展）：

1. 旧单配置 → `getSettings` 自动迁移出单供应商（models/activeModel 正确）并回写
2. 已是多供应商结构 → 不重复迁移
3. `getActiveProvider`：命中 / 悬空回退 / 空列表 null
4. `resolveModel`：命中 / 悬空回退首个 / 空列表 ''
5. providers CRUD + `setActiveModel`（含「首个供应商自动设为当前」「删除当前供应商回退」）
6. `buildMessages`：sourceLang='auto' 措辞不变；指定源语言时含 `from X to Y`
7. scheduler：无供应商返回 `code: 'auth'`；正常路径使用解析后的模型

UI 交互（列表展开/折叠、三级下拉联动）由手动验收覆盖；现有单测与 4 条 E2E 必须保持绿（E2E 的 seedSettings 需改为新数据结构）。

## 兼容性

- 存储中的旧字段读取合并保留；`saveSettings` 不再写入废弃字段。
- Firefox 127+ / Chrome 116+ 无新增 API，无兼容风险。
