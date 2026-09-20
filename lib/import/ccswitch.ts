import type { ApiProtocol } from '../settings';

export interface CcSwitchRow {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
  is_current: number;
}

export interface ImportedProvider {
  name: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  models: string[];
  activeModel: string;
  isCurrent: boolean;
}

const CLAUDE_MODEL_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
] as const;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function mapClaudeRow(row: CcSwitchRow, cfg: Record<string, unknown>): ImportedProvider | null {
  const env = (cfg.env ?? {}) as Record<string, string | undefined>;
  const apiKey = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) return null;
  const baseUrl = stripTrailingSlash(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com');
  const models: string[] = [];
  const push = (v: string | undefined) => { if (v && !models.includes(v)) models.push(v); };
  for (const k of CLAUDE_MODEL_KEYS) push(env[k]);
  push(env.ANTHROPIC_MODEL);
  return {
    name: row.name, protocol: 'claude', baseUrl, apiKey,
    models, activeModel: models[0] ?? '', isCurrent: row.is_current === 1,
  };
}

function mapCodexRow(row: CcSwitchRow, cfg: Record<string, unknown>): ImportedProvider | null {
  const auth = (cfg.auth ?? {}) as Record<string, string | undefined>;
  const apiKey = auth.OPENAI_API_KEY ?? '';
  const toml = typeof cfg.config === 'string' ? cfg.config : '';
  const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? '';
  const baseUrl = stripTrailingSlash(/^\s*base_url\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? '');
  if (!apiKey || !baseUrl) return null; // 无地址无法构造请求，跳过
  const models = model ? [model] : [];
  return {
    name: row.name, protocol: 'openai', baseUrl, apiKey,
    models, activeModel: models[0] ?? '', isCurrent: row.is_current === 1,
  };
}

export function parseCcSwitchProviders(rows: CcSwitchRow[]): ImportedProvider[] {
  const out: ImportedProvider[] = [];
  for (const row of rows) {
    if (row.id.endsWith('-official')) continue;
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(row.settings_config) as Record<string, unknown>;
    } catch {
      continue;
    }
    const mapped = row.app_type === 'claude' ? mapClaudeRow(row, cfg)
      : row.app_type === 'codex' ? mapCodexRow(row, cfg)
      : null;
    if (mapped) out.push(mapped);
  }
  return out;
}
