export const PROMPT_VERSION = 'v1';

export interface ChatMessage { role: 'system' | 'user'; content: string }
export type PromptMode = 'json' | 'plain';

export function buildMessages(texts: string[], targetLang: string, systemPrompt: string, mode: PromptMode): ChatMessage[] {
  const numbered = texts.map((t, i) => `[${i}] ${t}`).join('\n\n');
  const format = mode === 'json'
    ? 'Respond with JSON only, no other text: {"items":[{"i":0,"t":"translation of item 0"}]}. Include every input index.'
    : 'Respond with each translation prefixed by the same [i] marker as its input (e.g. [0] translation of item 0), one item per block. No other text.';
  return [
    { role: 'system', content: `${systemPrompt}\nTranslate the following texts to ${targetLang}. ${format}` },
    { role: 'user', content: numbered },
  ];
}

export function parseJsonResponse(content: string, expected: number): (string | null)[] | null {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const result: (string | null)[] = new Array(expected).fill(null);
  for (const item of items) {
    const it = item as { i?: unknown; t?: unknown };
    if (typeof it.i === 'number' && Number.isInteger(it.i) && it.i >= 0 && it.i < expected && typeof it.t === 'string') {
      result[it.i] = it.t;
    }
  }
  return result;
}

const MARKER_RE = /\[(\d+)\]\s*/g;

export function parsePlainResponse(content: string, expected: number): (string | null)[] | null {
  const marks = [...content.matchAll(MARKER_RE)];
  if (marks.length === 0) return null;
  const result: (string | null)[] = new Array(expected).fill(null);
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k]!;
    const i = Number(m[1]);
    const start = m.index! + m[0].length;
    const end = k + 1 < marks.length ? marks[k + 1]!.index! : content.length;
    if (Number.isInteger(i) && i >= 0 && i < expected) {
      result[i] = content.slice(start, end).trim();
    }
  }
  return result;
}
