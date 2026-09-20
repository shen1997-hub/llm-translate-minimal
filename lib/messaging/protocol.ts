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
