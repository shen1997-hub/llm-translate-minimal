import { describe, it, expect } from 'vitest';
import { parseCcSwitchProviders } from '../lib/import/ccswitch';
import type { CcSwitchRow } from '../lib/import/ccswitch';

const claudeRow: CcSwitchRow = {
  id: 'abc-1', app_type: 'claude', name: 'DeepSeek', is_current: 1,
  settings_config: JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-claude',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic/',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-v4.1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'deepseek-v4.1',
    },
  }),
};

const codexRow: CcSwitchRow = {
  id: 'def-2', app_type: 'codex', name: '火山', is_current: 0,
  settings_config: JSON.stringify({
    auth: { OPENAI_API_KEY: 'sk-openai', auth_mode: 'apikey' },
    config: 'model_provider = "custom"\nmodel = "glm-5.3"\n\n[model_providers.custom]\nbase_url = "https://ark.example.com/api/coding"\n',
  }),
};

describe('parseCcSwitchProviders', () => {
  it('claude 行：env 映射、baseUrl 去尾斜杠、模型名去重、isCurrent 透传', () => {
    const r = parseCcSwitchProviders([claudeRow]);
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      name: 'DeepSeek', protocol: 'claude',
      baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-claude',
      models: ['deepseek-v4.1', 'deepseek-v4-flash'], activeModel: 'deepseek-v4.1',
      isCurrent: true,
    });
  });

  it('codex 行：auth 取 Key、TOML 提取 model 与 base_url，协议 openai', () => {
    const r = parseCcSwitchProviders([codexRow]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      name: '火山', protocol: 'openai',
      baseUrl: 'https://ark.example.com/api/coding', apiKey: 'sk-openai',
      models: ['glm-5.3'], activeModel: 'glm-5.3', isCurrent: false,
    });
  });

  it('claude 行缺 ANTHROPIC_BASE_URL 时回退官方地址；模型兜底 ANTHROPIC_MODEL', () => {
    const row: CcSwitchRow = {
      id: 'x', app_type: 'claude', name: 'A', is_current: 0,
      settings_config: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_MODEL: 'claude-sonnet-4' } }),
    };
    const r = parseCcSwitchProviders([row]);
    expect(r[0]!.baseUrl).toBe('https://api.anthropic.com');
    expect(r[0]!.models).toEqual(['claude-sonnet-4']);
  });

  it('跳过：official 行、无 Key 行、codex 缺 base_url 行、非法 JSON 行、未知 app_type', () => {
    const rows: CcSwitchRow[] = [
      { id: 'codex-official', app_type: 'codex', name: 'OpenAI Official', settings_config: '{"auth":{},"config":""}', is_current: 0 },
      { id: 'no-key', app_type: 'claude', name: 'NoKey', settings_config: '{"env":{}}', is_current: 0 },
      { id: 'no-url', app_type: 'codex', name: 'NoUrl', settings_config: '{"auth":{"OPENAI_API_KEY":"k"},"config":"model = \\"m\\""}', is_current: 0 },
      { id: 'bad', app_type: 'claude', name: 'Bad', settings_config: 'not-json', is_current: 0 },
      { id: 'g', app_type: 'gemini', name: 'G', settings_config: '{"env":{}}', is_current: 0 },
    ];
    expect(parseCcSwitchProviders(rows)).toEqual([]);
  });
});
