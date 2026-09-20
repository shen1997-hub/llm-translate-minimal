import {
  getSettings, saveSettings, saveProvider, deleteProvider, setActiveProvider,
  LANGUAGES,
} from '../../lib/settings';
import type { Provider, Settings } from '../../lib/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let editingId: string | null = null; // null = 全部折叠；'new' = 新增表单

function newProviderDraft(): Provider {
  return {
    id: `pv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '', baseUrl: '', apiKey: '', models: [], activeModel: '',
    protocol: 'openai',
  };
}

async function renderProviders(): Promise<void> {
  const s = await getSettings();
  const list = $('provider-list');
  list.innerHTML = '';
  if (s.providers.length === 0 && editingId !== 'new') {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = '尚未配置供应商，点击下方按钮添加';
    list.appendChild(hint);
  }
  for (const p of s.providers) {
    list.appendChild(editingId === p.id ? buildForm(p) : buildRow(p, s));
  }
  if (editingId === 'new') list.appendChild(buildForm(newProviderDraft()));
}

function buildRow(p: Provider, s: Settings): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pv-row';
  const isActive = p.id === s.activeProviderId;
  row.innerHTML = `
    <div class="pv-info">
      <div class="pv-name"></div>
      <div class="pv-sub"></div>
    </div>
    ${isActive ? '<span class="pv-badge">当前</span>' : ''}
    <div class="pv-actions">
      ${isActive ? '' : '<button class="btn-text" data-act="use">设为当前</button>'}
      <button class="btn-text" data-act="edit">编辑</button>
      <button class="btn-text danger" data-act="del">删除</button>
    </div>`;
  row.querySelector('.pv-name')!.textContent = p.name;
  row.querySelector('.pv-sub')!.textContent = `${resolveModelLabel(p)} · ${p.baseUrl}`;
  row.querySelector('[data-act="use"]')?.addEventListener('click', async () => {
    await setActiveProvider(p.id);
    await renderProviders();
  });
  row.querySelector('[data-act="edit"]')!.addEventListener('click', async () => {
    editingId = p.id;
    await renderProviders();
  });
  row.querySelector('[data-act="del"]')!.addEventListener('click', async () => {
    await deleteProvider(p.id);
    if (editingId === p.id) editingId = null;
    await renderProviders();
  });
  return row;
}

function resolveModelLabel(p: Provider): string {
  return p.models.includes(p.activeModel) ? p.activeModel : (p.models[0] ?? '（无模型）');
}

function buildForm(p: Provider): HTMLElement {
  const form = document.createElement('div');
  form.className = 'pv-form';
  form.innerHTML = `
    <label>名称 <input data-f="name" placeholder="如 DeepSeek"></label>
    <label>API Base URL <input data-f="baseUrl" placeholder="https://api.deepseek.com"></label>
    <label>API Key <input data-f="apiKey" type="password"></label>
    <label>模型列表（逗号分隔，首个为默认选中） <input data-f="models" placeholder="deepseek-chat, deepseek-reasoner"></label>
    <div class="form-error" hidden></div>
    <div class="form-actions">
      <button class="btn-primary" data-act="save">保存</button>
      <button class="btn-secondary" data-act="cancel">取消</button>
    </div>`;
  const val = (f: string) => form.querySelector<HTMLInputElement>(`[data-f="${f}"]`)!;
  val('name').value = p.name;
  val('baseUrl').value = p.baseUrl;
  val('apiKey').value = p.apiKey;
  val('models').value = p.models.join(', ');

  form.querySelector('[data-act="cancel"]')!.addEventListener('click', async () => {
    editingId = null;
    await renderProviders();
  });
  form.querySelector('[data-act="save"]')!.addEventListener('click', async () => {
    const name = val('name').value.trim();
    const baseUrl = val('baseUrl').value.trim().replace(/\/+$/, '');
    const apiKey = val('apiKey').value.trim();
    const models = val('models').value.split(/[,，]/).map(m => m.trim()).filter(Boolean);
    const err = form.querySelector<HTMLElement>('.form-error')!;
    const fail = (msg: string) => { err.textContent = msg; err.hidden = false; };
    if (!name) return fail('请填写名称');
    try { new URL(baseUrl); } catch { return fail('Base URL 不是合法 URL'); }
    if (models.length === 0) return fail('请至少填写一个模型');
    await saveProvider({
      ...p, name, baseUrl, apiKey, models,
      activeModel: models.includes(p.activeModel) ? p.activeModel : models[0]!,
    });
    editingId = null; // 保存后折叠回摘要行
    await renderProviders();
  });
  return form;
}

async function loadGlobals(): Promise<void> {
  const s = await getSettings();
  ($('systemPrompt') as HTMLTextAreaElement).value = s.systemPrompt;
  const langSelect = $('targetLang') as HTMLSelectElement;
  langSelect.innerHTML = '';
  for (const lang of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang;
    opt.textContent = lang;
    langSelect.appendChild(opt);
  }
  // 旧数据可能是自由文本（如「中文」），保留为可选中的附加项
  if (s.targetLang && !LANGUAGES.includes(s.targetLang)) {
    const opt = document.createElement('option');
    opt.value = s.targetLang;
    opt.textContent = `${s.targetLang}（自定义）`;
    langSelect.appendChild(opt);
  }
  langSelect.value = s.targetLang;
  ($('minLength') as HTMLInputElement).value = String(s.minLength);
  ($('cjkRatioThreshold') as HTMLInputElement).value = String(s.cjkRatioThreshold);
  ($('blacklist') as HTMLTextAreaElement).value = s.blacklist.join('\n');
}

$('save').addEventListener('click', async () => {
  await saveSettings({
    systemPrompt: ($('systemPrompt') as HTMLTextAreaElement).value,
    targetLang: ($('targetLang') as HTMLSelectElement).value || '简体中文',
    minLength: Number(($('minLength') as HTMLInputElement).value) || 20,
    cjkRatioThreshold: Number(($('cjkRatioThreshold') as HTMLInputElement).value) || 0.3,
    blacklist: ($('blacklist') as HTMLTextAreaElement).value.split('\n').map(x => x.trim()).filter(Boolean),
  });
  $('status').textContent = '已保存';
});

$('add-provider').addEventListener('click', async () => {
  editingId = 'new';
  await renderProviders();
});

void loadGlobals().then(renderProviders);
