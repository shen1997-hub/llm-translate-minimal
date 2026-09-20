import { findContentRoot } from '../lib/extraction/scoring';
import { extractParagraphs, browserIsVisible } from '../lib/extraction/paragraphs';
import { siteRuleFor } from '../lib/extraction/site-rules';
import type { Paragraph } from '../lib/extraction/paragraphs';
import { buildChunks } from '../lib/translation/chunking';
import type { TranslateRequest, TranslateResponse } from '../lib/messaging/protocol';
import { ensureHost, setHostState, removeAllHosts, HOST_ATTR } from '../lib/renderer/host';
import { getSettings } from '../lib/settings';

const STATE_ATTR = 'data-llm-translate-state';
const PID_ATTR = 'data-llm-translate-pid';
const CHUNK_TIMEOUT_MS = 60_000;
const MAX_RESENDS = 2;

interface PendingEntry {
  chunk: TranslateRequest;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Task {
  id: string;
  cancelled: boolean;
  total: number;
  done: number;
  pending: Map<string, PendingEntry>;
  sliceBuffers: Map<string, { total: number; parts: string[] }>;
  paragraphs: Map<string, Paragraph>;
  errors: Set<string>;
  observer: MutationObserver | null;
}

let task: Task | null = null;
let port: chrome.runtime.Port | null = null;
let pidSeq = 0;

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.kind === 'probe') { void probe().then(sendResponse).catch((e) => console.error('[llm-tr] probe failed', e)); return true; } // [diag]
      if (msg.kind === 'start') { void startTranslate().catch((e) => console.error('[llm-tr] start failed', e)); sendResponse({ ok: true }); return; } // [diag]
      if (msg.kind === 'cancel') { cancelTask(); sendResponse({ ok: true }); return; }
      if (msg.kind === 'clear') { clearAll(); sendResponse({ ok: true }); return; }
    });
    console.log('[llm-tr] content script ready', location.href); // [diag]
    watchSpaNavigation();
  },
});

function stableId(el: Element): string {
  const existing = el.getAttribute(PID_ATTR);
  if (existing) return existing;
  const id = `p${pidSeq++}`;
  el.setAttribute(PID_ATTR, id);
  return id;
}

async function currentHostBlacklisted(): Promise<boolean> {
  const s = await getSettings();
  const host = location.hostname;
  return s.blacklist.some(d => host === d || host.endsWith('.' + d)) || s.disabledSites.includes(host);
}

const SITE_RULE = siteRuleFor(location.hostname);

async function collectParagraphs(): Promise<Paragraph[]> {
  const s = await getSettings();
  const root = findContentRoot(document, SITE_RULE);
  const ps = extractParagraphs(root, { minLength: s.minLength, cjkRatioThreshold: s.cjkRatioThreshold }, browserIsVisible, SITE_RULE);
  const fresh = ps.filter(p => !p.element.hasAttribute(STATE_ATTR));
  fresh.forEach(p => { p.id = stableId(p.element); });
  return fresh;
}

async function probe() {
  const blacklisted = await currentHostBlacklisted();
  if (blacklisted) return { kind: 'probe-result', paragraphs: 0, chars: 0, blacklisted: true };
  const ps = await collectParagraphs();
  return { kind: 'probe-result', paragraphs: ps.length, chars: ps.reduce((n, p) => n + p.text.length, 0), blacklisted: false };
}

function connectPort(): chrome.runtime.Port {
  if (port) return port;
  const p = chrome.runtime.connect({ name: 'translate' });
  p.onMessage.addListener((msg: TranslateResponse) => onChunkResponse(msg));
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    // SW 被终止导致断开：重连并重发未完成分块（幂等）
    if (task && !task.cancelled && task.pending.size > 0) {
      for (const entry of task.pending.values()) {
        armTimer(entry);
        postToPort(entry.chunk);
      }
    }
  });
  port = p;
  return p;
}

function postToPort(req: TranslateRequest): void {
  try {
    connectPort().postMessage(req);
  } catch {
    // 端口已静默死亡：丢弃并重建一次
    port = null;
    try {
      connectPort().postMessage(req);
    } catch { /* 连不上则由超时重发兜底 */ }
  }
}

function armTimer(entry: PendingEntry): void {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => onChunkTimeout(entry.chunk.chunkId), CHUNK_TIMEOUT_MS);
}

function sendChunk(entry: PendingEntry): void {
  task!.pending.set(entry.chunk.chunkId, entry);
  armTimer(entry);
  postToPort(entry.chunk);
}

function onChunkTimeout(chunkId: string): void {
  if (!task || task.cancelled) return;
  const entry = task.pending.get(chunkId);
  if (!entry) return;
  if (entry.retries < MAX_RESENDS) {
    entry.retries++;
    armTimer(entry);
    postToPort(entry.chunk);
    return;
  }
  // 重发耗尽：该分块按失败处理
  task.pending.delete(chunkId);
  markChunkError(entry.chunk);
  if (!isRetryChunk(chunkId)) completeChunk();
}

function findHost(t: Task, paragraphId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${HOST_ATTR}="${hostId(t.id, paragraphId)}"]`);
}

function markChunkError(chunk: TranslateRequest): void {
  if (!task) return;
  for (const u of chunk.units) {
    const p = task.paragraphs.get(u.paragraphId);
    if (p) {
      task.errors.add(u.paragraphId);
      p.element.setAttribute(STATE_ATTR, 'error');
      const host = findHost(task, u.paragraphId);
      if (host) setHostState(host, 'error');
    }
  }
}

function completeChunk(): void {
  if (!task) return;
  task.done++;
  notify({ kind: 'progress', done: task.done, total: task.total });
  if (task.done >= task.total) {
    notify({ kind: 'task-state', state: 'done' });
    stopObserverOnly();
    // 仍有失败段落时保留 task（静默态），供重试按钮继续工作
    if (task.errors.size === 0) task = null;
  }
}

function isRetryChunk(chunkId: string): boolean {
  return chunkId.startsWith('retry-');
}

let starting = false;

async function startTranslate(): Promise<void> {
  if (starting) return;
  if (task) {
    // 静默态（全部完成但留有失败段落）：start 视为「重试全部失败段落」
    if (!task.cancelled && task.done >= task.total && task.pending.size === 0 && task.errors.size > 0) {
      retryAllErrors();
    }
    return; // 任务运行中：幂等忽略
  }
  starting = true;
  try {
    console.log('[llm-tr] startTranslate: entry'); // [diag]
    if (await currentHostBlacklisted()) { console.log('[llm-tr] startTranslate: blacklisted, abort'); return; } // [diag]
    const paragraphs = await collectParagraphs();
    console.log('[llm-tr] startTranslate: paragraphs =', paragraphs.length); // [diag]
    if (paragraphs.length === 0) { notify({ kind: 'task-state', state: 'done' }); return; }

    const chunks = buildChunks(paragraphs.map(p => ({ id: p.id, text: p.text })));
    console.log('[llm-tr] startTranslate: chunks =', chunks.length); // [diag]
    const id = `task-${Date.now()}`;
    task = {
      id, cancelled: false, total: chunks.length, done: 0,
      pending: new Map(), sliceBuffers: new Map(),
      paragraphs: new Map(paragraphs.map(p => [p.id, p])),
      errors: new Set(),
      observer: null,
    };
    notify({ kind: 'task-state', state: 'running' });

    for (const p of paragraphs) {
      p.element.setAttribute(STATE_ATTR, 'pending');
      ensureHost(p.element, hostId(id, p.id));
    }
    console.log('[llm-tr] startTranslate: hosts created =', document.querySelectorAll(`[${HOST_ATTR}]`).length); // [diag]
    startObserver();

    chunks.forEach((chunk, i) => {
      const req: TranslateRequest = {
        kind: 'translate', taskId: id, chunkId: `c${i}`,
        units: chunk.units.map(u => ({ paragraphId: u.paragraphId, text: u.text, sliceIndex: u.sliceIndex, sliceTotal: u.sliceTotal })),
      };
      sendChunk({ chunk: req, retries: 0, timer: null });
    });
    console.log('[llm-tr] startTranslate: chunks posted to port'); // [diag]
  } finally {
    starting = false;
  }
}

function onChunkResponse(msg: TranslateResponse): void {
  console.log('[llm-tr] chunk response:', msg.kind, msg.chunkId, msg.kind === 'error' ? `${msg.code}: ${msg.message}` : ''); // [diag]
  if (!task || msg.taskId !== task.id || task.cancelled) return;
  const entry = task.pending.get(msg.chunkId);
  if (!entry) return;
  if (entry.timer !== null) clearTimeout(entry.timer);
  task.pending.delete(msg.chunkId);

  if (msg.kind === 'error') {
    if (msg.code === 'auth') {
      notify({ kind: 'task-state', state: 'error', message: msg.message });
      cancelTask({ silent: true });
      return;
    }
    markChunkError(entry.chunk);
  } else {
    for (const t of msg.translations) {
      const buf = task.sliceBuffers.get(t.paragraphId) ?? { total: t.sliceTotal, parts: [] };
      buf.parts[t.sliceIndex] = t.text;
      task.sliceBuffers.set(t.paragraphId, buf);
      if (buf.parts.filter(Boolean).length === buf.total) {
        const p = task.paragraphs.get(t.paragraphId);
        if (p) {
          p.element.setAttribute(STATE_ATTR, 'done');
          const host = findHost(task, t.paragraphId);
          if (host) setHostState(host, 'done', buf.parts.join(''));
        }
      }
    }
    if (isRetryChunk(msg.chunkId)) {
      for (const t of msg.translations) task.errors.delete(t.paragraphId);
      // 静默态任务的最后一批失败段落重试成功：释放 task
      if (task.done >= task.total && task.errors.size === 0) {
        task = null;
        notify({ kind: 'task-state', state: 'done' });
      }
      return;
    }
  }
  if (!isRetryChunk(msg.chunkId)) completeChunk();
}

// 静默态重试全部失败段落（popup 再次点击「翻译本页」时触发）
function retryAllErrors(): void {
  if (!task) return;
  notify({ kind: 'task-state', state: 'running' });
  for (const pid of task.errors) {
    const p = task.paragraphs.get(pid);
    if (!p) { task.errors.delete(pid); continue; }
    p.element.setAttribute(STATE_ATTR, 'pending');
    const host = findHost(task, p.id);
    if (host) setHostState(host, 'loading');
    const req: TranslateRequest = {
      kind: 'translate', taskId: task.id, chunkId: `retry-${pid}`,
      units: [{ paragraphId: p.id, text: p.text, sliceIndex: 0, sliceTotal: 1 }],
    };
    sendChunk({ chunk: req, retries: 0, timer: null });
  }
}

// 失败段落重试（事件委托：shadow 内 data-retry 按钮）
document.addEventListener('click', (e) => {
  const path = e.composedPath();
  const btn = path.find(n => n instanceof HTMLElement && n.hasAttribute('data-retry'));
  if (!btn || !task) return;
  const host = path.find(n => n instanceof HTMLElement && n.hasAttribute(HOST_ATTR)) as HTMLElement | undefined;
  const pid = host?.getAttribute(HOST_ATTR)?.split('/')[1];
  const p = pid ? task.paragraphs.get(pid) : undefined;
  if (!p) return;
  p.element.setAttribute(STATE_ATTR, 'pending');
  const host2 = findHost(task, p.id);
  if (host2) setHostState(host2, 'loading');
  const req: TranslateRequest = {
    kind: 'translate', taskId: task.id, chunkId: `retry-${pid}`,
    units: [{ paragraphId: p.id, text: p.text, sliceIndex: 0, sliceTotal: 1 }],
  };
  sendChunk({ chunk: req, retries: 0, timer: null });
}, true);

function cancelTask(opts?: { silent?: boolean }): void {
  if (!task) return;
  task.cancelled = true;
  for (const entry of task.pending.values()) {
    if (entry.timer !== null) clearTimeout(entry.timer);
  }
  task.pending.clear();
  task.errors.clear();
  stopObserverOnly();
  task = null;
  if (!opts?.silent) notify({ kind: 'task-state', state: 'idle' });
}

function clearAll(): void {
  cancelTask();
  removeAllHosts(document);
  document.querySelectorAll(`[${STATE_ATTR}]`).forEach(el => el.removeAttribute(STATE_ATTR));
  document.querySelectorAll(`[${PID_ATTR}]`).forEach(el => el.removeAttribute(PID_ATTR));
}

function startObserver(): void {
  if (!task || task.observer) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  task.observer = new MutationObserver((mutations) => {
    if (mutations.every(isSelfMutation)) return; // 自触发过滤
    clearTimeout(timer);
    timer = setTimeout(() => void onNewContent(), 300);
  });
  task.observer.observe(document.body, { childList: true, subtree: true });
}

function isSelfMutation(m: MutationRecord): boolean {
  if (m.target instanceof Element && m.target.closest(`[${HOST_ATTR}]`)) return true;
  const added = Array.from(m.addedNodes);
  return added.length > 0 && added.every(n =>
    n instanceof Element && (n.hasAttribute(HOST_ATTR) || n.querySelector(`[${HOST_ATTR}]`) !== null));
}

let extracting = false;
let incSeq = 0;

async function onNewContent(): Promise<void> {
  if (!task || task.cancelled || extracting) return;
  extracting = true;
  try {
    const fresh = await collectParagraphs();
    if (!task || task.cancelled || fresh.length === 0) return;
    const chunks = buildChunks(fresh.map(p => ({ id: p.id, text: p.text })), 1500);
    task.total += chunks.length;
    for (const p of fresh) {
      task.paragraphs.set(p.id, p);
      p.element.setAttribute(STATE_ATTR, 'pending');
      ensureHost(p.element, hostId(task.id, p.id));
    }
    const batch = incSeq++;
    chunks.forEach((chunk, i) => {
      const req: TranslateRequest = {
        kind: 'translate', taskId: task!.id, chunkId: `c-inc-${batch}-${i}`,
        units: chunk.units.map(u => ({ paragraphId: u.paragraphId, text: u.text, sliceIndex: u.sliceIndex, sliceTotal: u.sliceTotal })),
      };
      sendChunk({ chunk: req, retries: 0, timer: null });
    });
    notify({ kind: 'progress', done: task.done, total: task.total });
  } finally {
    extracting = false;
  }
}

function stopObserverOnly(): void {
  task?.observer?.disconnect();
  if (task) task.observer = null;
}

function watchSpaNavigation(): void {
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      clearAll();
    }
  }, 1000);
}

function hostId(taskId: string, paragraphId: string): string {
  return `${taskId}/${paragraphId}`;
}

function notify(msg: unknown): void {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup 未打开时忽略 */ });
}
