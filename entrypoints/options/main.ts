import { getSettings, saveSettings, apiOriginPattern } from '../../lib/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function refreshPermStatus(): Promise<void> {
  const s = await getSettings();
  if (!s.baseUrl) return;
  let pattern: string;
  try {
    pattern = apiOriginPattern(s.baseUrl);
  } catch {
    $('perm-status').textContent = '';
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  $('perm-status').textContent = granted ? '（已授权）' : '（未授权，翻译前需授权）';
}

async function load(): Promise<void> {
  const s = await getSettings();
  ($('baseUrl') as HTMLInputElement).value = s.baseUrl;
  ($('apiKey') as HTMLInputElement).value = s.apiKey;
  ($('model') as HTMLInputElement).value = s.model;
  ($('systemPrompt') as HTMLTextAreaElement).value = s.systemPrompt;
  ($('targetLang') as HTMLInputElement).value = s.targetLang;
  ($('minLength') as HTMLInputElement).value = String(s.minLength);
  ($('cjkRatioThreshold') as HTMLInputElement).value = String(s.cjkRatioThreshold);
  ($('blacklist') as HTMLTextAreaElement).value = s.blacklist.join('\n');
  await refreshPermStatus();
}

$('save').addEventListener('click', async () => {
  const old = await getSettings();
  await saveSettings({
    baseUrl: ($('baseUrl') as HTMLInputElement).value.trim().replace(/\/+$/, ''),
    apiKey: ($('apiKey') as HTMLInputElement).value.trim(),
    model: ($('model') as HTMLInputElement).value.trim(),
    systemPrompt: ($('systemPrompt') as HTMLTextAreaElement).value,
    targetLang: ($('targetLang') as HTMLInputElement).value.trim() || '中文',
    minLength: Number(($('minLength') as HTMLInputElement).value) || 20,
    cjkRatioThreshold: Number(($('cjkRatioThreshold') as HTMLInputElement).value) || 0.3,
    blacklist: ($('blacklist') as HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean),
  });
  // baseUrl 变更：回收旧域名权限
  const next = ($('baseUrl') as HTMLInputElement).value.trim().replace(/\/+$/, '');
  if (old.baseUrl && old.baseUrl !== next) {
    try {
      await chrome.permissions.remove({ origins: [apiOriginPattern(old.baseUrl)] });
    } catch {
      // 旧的 baseUrl 非法，无需回收权限
    }
  }
  $('status').textContent = '已保存';
  await refreshPermStatus();
});

$('grant').addEventListener('click', async () => {
  const baseUrl = ($('baseUrl') as HTMLInputElement).value.trim().replace(/\/+$/, '');
  if (!baseUrl) { $('status').textContent = '请先填写 Base URL'; return; }
  let pattern: string;
  try {
    pattern = apiOriginPattern(baseUrl);
  } catch {
    $('status').textContent = 'Base URL 格式不正确，请输入完整的 http(s) 地址';
    return;
  }
  const granted = await chrome.permissions.request({ origins: [pattern] });
  $('status').textContent = granted ? '授权成功' : '授权被拒绝，翻译请求将被浏览器拦截';
  await refreshPermStatus();
});

chrome.permissions.onAdded.addListener(refreshPermStatus);
chrome.permissions.onRemoved.addListener(refreshPermStatus);

void load();
