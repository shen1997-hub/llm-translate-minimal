export const PROMPT_VERSION = 'v1';

export interface ChatMessage { role: 'system' | 'user'; content: string }
export type PromptMode = 'json' | 'plain';

export function buildMessages(
  texts: string[],
  targetLang: string,
  systemPrompt: string,
  mode: PromptMode,
  sourceLang?: string,
): ChatMessage[] {
  const numbered = texts.map((t, i) => `[${i}] ${t}`).join('\n\n');
  const format = mode === 'json'
    ? 'Respond with JSON only, no other text: {"items":[{"i":0,"t":"translation of item 0"}]}. Include every input index.'
    : 'Respond with each translation prefixed by the same [i] marker as its input (e.g. [0] translation of item 0), one item per block. No other text.';
  const langDirective = sourceLang && sourceLang !== 'auto'
    ? `Translate the following texts from ${sourceLang} to ${targetLang}.`
    : `Translate the following texts to ${targetLang}.`;
  return [
    { role: 'system', content: `${systemPrompt}\n${langDirective} ${format}` },
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

export interface WordEntry {
  word: string;
  phonetic?: string;
  senses: { pos: string; meaning: string }[];
  related: { word: string; note: string }[];
  contextual: string;
}

export function buildLookupMessages(word: string, sentence: string, targetLang: string): ChatMessage[] {
  const schema = '{"word":"the word","phonetic":"IPA transcription, empty string if not applicable","senses":[{"pos":"part of speech","meaning":"meaning in ' + targetLang + '"}],"related":[{"word":"related word","note":"relation tag + short gloss, e.g. \\"syn. 举起\\""}],"contextual":"explanation of the word as used in the given sentence, in ' + targetLang + '"}';
  return [
    {
      role: 'system',
      content: `You are a dictionary. Explain the given word or short phrase in ${targetLang}. "senses" lists each part of speech with its meanings; "related" lists synonyms/antonyms/derivatives; "contextual" explains the meaning in the given sentence. Respond with JSON only, no other text: ${schema}`,
    },
    { role: 'user', content: `Word: ${word}\nSentence: ${sentence}` },
  ];
}

export function parseLookupResponse(content: string): WordEntry | null {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as { word?: unknown; phonetic?: unknown; senses?: unknown; related?: unknown; contextual?: unknown };
  const senses = Array.isArray(o.senses)
    ? o.senses.filter((s): s is { pos: string; meaning: string } =>
        typeof s === 'object' && s !== null
        && typeof (s as { pos?: unknown }).pos === 'string'
        && typeof (s as { meaning?: unknown }).meaning === 'string')
    : [];
  const related = Array.isArray(o.related)
    ? o.related.filter((r): r is { word: string; note: string } =>
        typeof r === 'object' && r !== null
        && typeof (r as { word?: unknown }).word === 'string'
        && typeof (r as { note?: unknown }).note === 'string')
    : [];
  const contextual = typeof o.contextual === 'string' ? o.contextual : '';
  if (senses.length === 0 && contextual === '') return null;
  return {
    word: typeof o.word === 'string' ? o.word : '',
    phonetic: typeof o.phonetic === 'string' && o.phonetic !== '' ? o.phonetic : undefined,
    senses,
    related,
    contextual,
  };
}
