import {
  getSettings, saveSettings, setActiveProvider, setActiveModel,
  getActiveProvider, resolveModel, LANGUAGES,
} from '../../lib/settings';
import type { StartTabResponse } from '../../lib/messaging/protocol';

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
  ($('sel-toggle') as HTMLInputElement).checked = s.selectionTranslate;

  // 语言下拉
  fillLangSelect($('source-lang') as HTMLSelectElement, ['自动检测', ...LANGUAGES], s.sourceLang);
  fillLangSelect($('target-lang') as HTMLSelectElement, LANGUAGES, s.targetLang);

  // 供应商/模型两级下拉
  const providerSelect = $('provider-select') as HTMLSelectElement;
  const modelSelect = $('model-select') as HTMLSelectElement;
  const providerEmpty = $('provider-empty');
  const modelRow = $('model-row');
  providerSelect.innerHTML = '';
  if (s.providers.length === 0) {
    providerSelect.hidden = true;
    modelRow.hidden = true;
    providerEmpty.hidden = false;
  } else {
    providerSelect.hidden = false;
    modelRow.hidden = false;
    providerEmpty.hidden = true;
    providerSelect.disabled = false;
    modelSelect.disabled = false;
    const active = getActiveProvider(s);
    for (const p of s.providers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      providerSelect.appendChild(opt);
    }
    providerSelect.value = active?.id ?? '';
    fillModelSelect(modelSelect, active?.models ?? [], active ? resolveModel(active) : '');
  }

  if (!getActiveProvider(s)?.apiKey) { $('message').textContent = '请先在设置页填写 API Key'; $('message').className = 'error'; }

  const probe = await chrome.tabs.sendMessage(tab.id, { kind: 'probe' }).catch(() => null);
  if (probe?.blacklisted) {
    $('estimate').textContent = '此站点在黑名单中';
  } else if (probe && !disabled) {
    const tokens = Math.ceil(probe.chars / 3.5);
    $('estimate').textContent = `将翻译 ${probe.paragraphs} 段 / 约 ${tokens} tokens`;
  }
}

function fillLangSelect(select: HTMLSelectElement, options: string[], current: string): void {
  select.innerHTML = '';
  for (const label of options) {
    const opt = document.createElement('option');
    opt.value = label === '自动检测' ? 'auto' : label;
    opt.textContent = label;
    select.appendChild(opt);
  }
  // 旧数据自由文本（如「中文」）保留为可选项
  if (current !== 'auto' && ![...select.options].some(o => o.value === current)) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = `${current}（自定义）`;
    select.appendChild(opt);
  }
  select.value = current;
}

function fillModelSelect(select: HTMLSelectElement, models: string[], current: string): void {
  select.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  }
  select.value = current;
}

$('action').addEventListener('click', async () => {
  if (state === 'running') {
    await chrome.tabs.sendMessage(currentTabId, { kind: 'cancel' }).catch(() => {});
    setState('idle');
    return;
  }
  try {
    // 经 background 发送:content script 不在时(安装/更新前已打开的页面)自动补注入再重试
    if (!currentTabId) currentTabId = (await activeTab())?.id ?? 0; // 防 popup 冷启动竞态
    const res: StartTabResponse = await chrome.runtime.sendMessage({ kind: 'start-tab', tabId: currentTabId });
    if (res?.ok) {
      setState('running');
    } else {
      setState('error', res?.reason === 'inject-failed'
        ? '当前页面不允许扩展注入脚本（浏览器保留页面），请在普通网页上使用'
        : '无法连接页面脚本，请刷新页面后重试');
    }
  } catch {
    setState('error', '无法连接页面脚本，请刷新页面后重试');
  }
});

$('source-lang').addEventListener('change', async (e) => {
  await saveSettings({ sourceLang: (e.target as HTMLSelectElement).value });
});
$('target-lang').addEventListener('change', async (e) => {
  await saveSettings({ targetLang: (e.target as HTMLSelectElement).value });
});
$('provider-select').addEventListener('change', async (e) => {
  const id = (e.target as HTMLSelectElement).value;
  if (!id) return;
  await setActiveProvider(id);
  await refresh();
});
$('model-select').addEventListener('change', async (e) => {
  const s = await getSettings();
  const active = getActiveProvider(s);
  if (active) await setActiveModel(active.id, (e.target as HTMLSelectElement).value);
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

$('sel-toggle').addEventListener('change', async (e) => {
  await saveSettings({ selectionTranslate: (e.target as HTMLInputElement).checked });
});

$('clear').addEventListener('click', async () => {
  await chrome.tabs.sendMessage(currentTabId, { kind: 'clear' }).catch(() => {});
  setState('idle');
  $('estimate').textContent = '';
});

$('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
$('provider-empty').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.kind === 'progress') $('progress').textContent = `进度 ${msg.done} / ${msg.total}`;
  if (msg.kind === 'task-state') setState(msg.state, msg.message ?? '');
});

$('version').textContent = `v${chrome.runtime.getManifest().version}`;

void refresh();
