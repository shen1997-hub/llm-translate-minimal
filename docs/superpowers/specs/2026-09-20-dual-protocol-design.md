# 双协议接入 + CC Switch 导入 + 品牌改名 设计文档

日期：2026-09-20
状态：已确认（导入方式=直读 cc-switch.db；导入范围=claude+codex 两类；架构=Provider 加 protocol 字段；品牌改名「极简翻译」）

## 背景与目标

项目主题定位「极简翻译插件」。当前模型接入仅支持 OpenAI 兼容 `/chat/completions`，不够通用。目标：

1. 支持 OpenAI 与 Claude 两种通用 API 协议，按供应商逐配置选择
2. 设置页可从 CC Switch 的 `cc-switch.db`（SQLite SSOT）批量导入供应商（claude + codex 两类）
3. 扩展改名「极简翻译」（manifest、popup、options、README）

非目标：不做 Gemini/其他协议；不做通用适配器框架；不导入 MCP/技能/用量等 CC Switch 其他数据；不做 CC Switch 配置回写。

## 协议层（`lib/translation/llm-client.ts`）

`LlmConfig` 增加 `protocol: 'openai' | 'claude'`。`chatCompletion` 拆为两个 transport，共用重试循环（429/5xx 退避 `[1000,2000,4000]`、AuthError 401/403）：

**OpenAI transport**：现状不变——`POST {baseUrl}/chat/completions`，`Authorization: Bearer`，`response_format` 按 `useJsonFormat`，400 且响应含 response_format 时抛 `FormatUnsupportedError` 降级。

**Claude transport**：

```
POST {baseUrl}/v1/messages
headers: content-type: application/json
         x-api-key: <apiKey>
         anthropic-version: 2023-06-01
         anthropic-dangerous-direct-browser-access: true   // 官方 API 浏览器直连需要；代理忽略
body: { model, max_tokens: 4096, system: <systemPrompt>,
        messages: [{ role: 'user', content: <userText> }], temperature: 0.3 }
响应: data.content[0].text（content 数组取第一个 type==='text' 的块）
```

- prompt 层 `buildMessages` 返回 `[{role:'system'...},{role:'user'...}]`；Claude transport 拆出 system 字段，user 消息原样放入 messages
- Claude 无 `response_format` 等价物 → 永远 plain 模式：`translateUnits` 入口若 `cfg.protocol === 'claude'` 强制 `mode = false`，不读不写 `jsonFormatSupported`
- 400 错误：Claude 无 JSON 降级需求，直接抛 `LLM bad request`

`translateUnits` 的逐段补齐、解析（`parseJsonResponse`/`parsePlainResponse`）两协议完全复用。

## 数据模型与迁移（`lib/settings.ts`）

```ts
export type ApiProtocol = 'openai' | 'claude';

export interface Provider {
  id: string; name: string;
  protocol: ApiProtocol;        // 新增
  baseUrl: string; apiKey: string;
  models: string[]; activeModel: string;
}
```

- 惰性迁移：`getSettings` 合并后对 `providers` 逐项补 `protocol: p.protocol ?? 'openai'`
- scheduler 构造 `LlmConfig` 时带上 `provider.protocol`
- `saveProvider`/`deleteProvider` 等 CRUD 无需改动（字段随对象透传）

## CC Switch 导入器（`lib/import/ccswitch.ts`）

### 架构

分两层，解析层为纯函数可单测：

```
parseCcSwitchProviders(rows: CcSwitchRow[]): ImportedProvider[]   // 纯函数
readCcSwitchDb(file: File|ArrayBuffer): Promise<CcSwitchRow[]>    // sql.js 薄层
```

```ts
interface CcSwitchRow { id: string; app_type: string; name: string; settings_config: string; is_current: number }
interface ImportedProvider { name: string; protocol: ApiProtocol; baseUrl: string; apiKey: string; models: string[]; activeModel: string; isCurrent: boolean }
```

### 读取层

- 新依赖 `sql.js`（SQLite wasm，约 1MB）；WXT 构建时需确认 wasm 资产打包（实现早期验证：`npm run build` 后 options 页能真实读 db）
- 查询：`SELECT id, app_type, name, settings_config, is_current FROM providers WHERE app_type IN ('claude','codex')`
- 文件非 SQLite / 查询无结果 → 抛出带中文消息的 Error，UI 层提示

### 解析层（映射规则）

**claude 行**（`settings_config` 为 JSON，含 `env` 对象）：
- `apiKey = env.ANTHROPIC_AUTH_TOKEN ?? ''`
- `baseUrl = env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'`
- `models`：依次取 `ANTHROPIC_DEFAULT_OPUS_MODEL_NAME`、`ANTHROPIC_DEFAULT_SONNET_MODEL_NAME`、`ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME`、`ANTHROPIC_DEFAULT_FABLE_MODEL_NAME` 中非空值去重；再兜底 `env.ANTHROPIC_MODEL`
- `activeModel = models[0] ?? ''`，`protocol = 'claude'`

**codex 行**（`settings_config` 为 JSON，含 `auth` 对象与 `config` TOML 字符串）：
- `apiKey = auth.OPENAI_API_KEY ?? ''`
- 从 `config` TOML 用极简逐行正则提取：`/^\s*model\s*=\s*"([^"]+)"/m` → model；`/^\s*base_url\s*=\s*"([^"]+)"/m` → baseUrl（自定义 model_providers 节内的第一个 base_url）
- baseUrl 提取不到 → 跳过该行（无法构造请求地址）；model 提取不到 → models 为空（用户导入后手补）
- `protocol = 'openai'`

**通用**：
- 跳过 `*-official`（如 `codex-official`、`gemini-official`，auth 为空无 Key）
- 与现有供应商 `baseUrl + apiKey` 完全相同的行标记为「已存在」，默认不勾选
- 每条映射结果附 `isCurrent`（db 的 is_current=1）

### 设置页 UI

- 「翻译服务」卡片顶部加「从 CC Switch 导入」按钮 → 触发隐藏 `<input type="file" accept=".db">`
- 按钮下方加一行说明文字（`.hint` 样式），告诉用户默认路径：
  `CC Switch 数据库默认位于：Windows C:\Users\<用户名>\.cc-switch\cc-switch.db；macOS / Linux ~/.cc-switch/cc-switch.db`
- 读取成功后弹出候选列表（复用设置页卡片样式）：每行 checkbox + 名称 + 协议徽标（Claude/OpenAI）+ baseUrl 摘要；「已存在」行禁用勾选
- 「导入所选」→ 逐条 `saveProvider`（id 用 `pv-<时间戳>-<序号>`）；含 `isCurrent` 的条目导入后 `setActiveProvider`
- 全程在 options 页完成，无新权限

## 设置页表单

添加/编辑供应商表单加「协议」下拉（OpenAI 兼容 / Claude），新建默认 `openai`；按协议切换 baseUrl 占位提示（openai: `https://api.deepseek.com`；claude: `https://api.anthropic.com`）。

## 品牌改名

- `wxt.config.ts` manifest `name: '极简翻译'`
- popup 标题「LLM Translate」→「极简翻译」；options 页标题同步
- README 项目名与描述同步（英文副标 Minimal Translate）

## 错误处理

- 导入文件非 SQLite / 表不存在 / 无有效行 → 设置页错误提示（复用表单错误样式）
- Claude 协议 401/403 → 现有 auth 链路（popup 显示 scheduler 的 auth message）
- Claude 响应 content 无 text 块 → 视为解析失败 → 逐段补齐 → 最终 error
- 导入的供应商 models 为空 → 沿用现有「空模型列表」兜底（popup 显示空，用户到设置页补）

## 测试

单测（TDD）：

1. `tests/llm-client.test.ts`：Claude transport——请求方法/URL/三个 header/body 结构（system 拆分、max_tokens 4096）、`data.content[0].text` 解析、429 退避、401→AuthError、强制 plain 模式（protocol='claude' 时 useJsonFormat 入参被忽略且返回 useJsonFormat: false）
2. `tests/ccswitch.test.ts`（新建）：`parseCcSwitchProviders`——claude 行完整映射、codex 行 TOML 提取（model/base_url/缺失 base_url 跳过）、official 行跳过、模型名去重、isCurrent 透传
3. `tests/settings.test.ts`：旧 providers 无 protocol → 读取后默认 'openai'
4. `tests/scheduler.test.ts`：cfg 携带 provider.protocol（透传断言）

E2E（`e2e/translate.spec.ts` 追加 1 条）：stub server 加 `POST /v1/messages` 端点（返回 content[0].text），seed 一个 protocol='claude' 的供应商，全文翻译跑通含「译文」。

现有 100 单测 + 5 E2E 保持绿。

## 兼容性

- 新依赖仅 `sql.js`（devDependency 外的 runtime 依赖，需打进产物）；无新 manifest 权限
- `anthropic-dangerous-direct-browser-access` 使 SW 可直连官方 api.anthropic.com（host_permissions 已是 `*://*/*`）
- Firefox 127+：sql.js wasm 在 MV2/MV3 扩展页均可加载（options 页环境，非 SW）
