export interface UnitPayload {
  paragraphId: string;
  text: string;
  sliceIndex: number;
  sliceTotal: number;
}

export interface TranslateRequest {
  kind: 'translate';
  taskId: string;
  chunkId: string;
  units: UnitPayload[];
  /** 逐请求目标语言覆盖（划词双语向）；缺省用 settings.targetLang */
  targetLang?: string;
}

export interface TranslateResultItem {
  paragraphId: string;
  sliceIndex: number;
  sliceTotal: number;
  text: string;
}

export type TranslateResponse =
  | { kind: 'result'; taskId: string; chunkId: string; translations: TranslateResultItem[] }
  | { kind: 'error'; taskId: string; chunkId: string; code: 'auth' | 'failed'; message: string };

/** popup → background（runtime 消息）：确保目标页 content script 存活并触发整页翻译 */
export interface StartTabRequest {
  kind: 'start-tab';
  tabId: number;
}

export interface StartTabResponse {
  ok: boolean;
  /** true 表示本次对已打开页面补注入了 content script */
  injected?: boolean;
  /** inject-failed：浏览器保留页面等无法注入；retry-failed：注入后消息仍不通 */
  reason?: 'inject-failed' | 'retry-failed';
}
