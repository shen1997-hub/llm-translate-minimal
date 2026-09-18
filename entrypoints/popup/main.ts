import { getSettings, saveSettings, apiOriginPattern } from '../../lib/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let state: 'idle' | 'running' | 'done' | 'error' = 'idle';
let currentTabId = 0;

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setState(s: typeof state, message = ''): void {
  state = s;
  ($('action') as HTMLButtonElement).textContent = s === 'running' ? '取消翻译' : '翻译本页';
  $('message').textContent = message;
  $('message').className = s === 'error' ? 'error' : '';
  $('progress').textContent = '';
  if (s === 'idle') $('estimate').textContent = '';
}

async function refresh(): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
    $('estimate').textContent = '当前页面不支持翻译';
    ($('action') as HTMLButtonElement).disabled = true;
    return;
  }
  currentTabId = tab.id;
  const host = new URL(tab.url).hostname;
  const s = await getSettings();
  const disabled = s.disabledSites.includes(host);
  ($('site-toggle') as HTMLInputElement).checked = !disabled;

  if (!s.apiKey) { $('message').textContent = '请先在设置页填写 API Key'; $('message').className = 'error'; }

  // baseUrl 非法时 apiOriginPattern 会抛错，不能让 popup 崩溃
  let pattern: string | null;
  try {
    pattern = apiOriginPattern(s.baseUrl);
  } catch {
    pattern = null;
  }
  if (pattern === null) {
    ($('grant') as HTMLButtonElement).hidden = true;
    $('message').textContent = 'Base URL 格式无效，请前往设置页修正';
    $('message').className = 'error';
  } else {
    const granted = await chrome.permissions.contains({ origins: [pattern] });
    ($('grant') as HTMLButtonElement).hidden = granted;
    if (!granted) $('message').textContent = 'API 域名未授权，点击「授权 API 域名」';
  }

  const probe = await chrome.tabs.sendMessage(tab.id, { kind: 'probe' }).catch(() => null);
  if (probe?.blacklisted) {
    $('estimate').textContent = '此站点在黑名单中';
  } else if (probe && !disabled) {
    const tokens = Math.ceil(probe.chars / 3.5);
    $('estimate').textContent = `将翻译 ${probe.paragraphs} 段 / 约 ${tokens} tokens`;
  }
}

$('action').addEventListener('click', async () => {
  if (state === 'running') {
    await chrome.tabs.sendMessage(currentTabId, { kind: 'cancel' }).catch(() => {});
    setState('idle');
    return;
  }
  try {
    await chrome.tabs.sendMessage(currentTabId, { kind: 'start' });
    setState('running');
  } catch {
    setState('error', '无法连接页面脚本，请刷新页面后重试');
  }
});

$('grant').addEventListener('click', async () => {
  const s = await getSettings();
  let pattern: string;
  try {
    pattern = apiOriginPattern(s.baseUrl);
  } catch {
    $('message').textContent = 'Base URL 格式无效，请前往设置页修正';
    $('message').className = 'error';
    return;
  }
  const granted = await chrome.permissions.request({ origins: [pattern] });
  ($('grant') as HTMLButtonElement).hidden = granted;
  $('message').textContent = granted ? '' : '授权被拒绝，翻译请求将被浏览器拦截';
});

$('site-toggle').addEventListener('change', async (e) => {
  const tab = await activeTab();
  if (!tab?.url || !tab.id) return;
  const host = new URL(tab.url).hostname;
  const s = await getSettings();
  const enabled = (e.target as HTMLInputElement).checked;
  const disabledSites = enabled ? s.disabledSites.filter(d => d !== host) : [...new Set([...s.disabledSites, host])];
  await saveSettings({ disabledSites });
  if (!enabled) await chrome.tabs.sendMessage(tab.id, { kind: 'clear' }).catch(() => {});
});

$('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.kind === 'progress') $('progress').textContent = `进度 ${msg.done} / ${msg.total}`;
  if (msg.kind === 'task-state') setState(msg.state, msg.message ?? '');
});

void refresh();
