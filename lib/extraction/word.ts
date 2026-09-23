const SENTENCE_PUNCT_RE = /[.!?。！？；;]/;
const SENTENCE_BOUNDARY_RE = /[.!?。！？；;\n]/;
const MAX_WORD_LEN = 60;
const MAX_SENTENCE_LEN = 300;

/** 选中内容是否为单词/短词组（≤3 词、无句读符号、长度 ≤60） */
export function isWordLike(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > MAX_WORD_LEN) return false;
  if (SENTENCE_PUNCT_RE.test(t)) return false;
  return t.split(/\s+/).length <= 3;
}

/**
 * 取选区所在的完整句子：只在选区起点所在文本节点内向前后扩展到句边界。
 * 跨节点的选区退化为该节点内片段；选区起点落在元素节点时退化为选中文本本身。
 */
export function extractSentence(range: Range): string {
  const collapsed = range.toString().replace(/\s+/g, ' ').trim();
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return collapsed;
  const text = node.textContent ?? '';
  const start = range.startOffset;
  let s = start;
  while (s > 0 && !SENTENCE_BOUNDARY_RE.test(text[s - 1]!)) s--;
  let e = start;
  while (e < text.length && !SENTENCE_BOUNDARY_RE.test(text[e]!)) e++;
  if (e < text.length) e++; // 句尾标点一并带上
  let sentence = text.slice(s, e).replace(/\s+/g, ' ').trim();
  if (sentence.length > MAX_SENTENCE_LEN) {
    const idx = collapsed !== '' ? sentence.indexOf(collapsed) : -1;
    const center = idx >= 0 ? idx + collapsed.length / 2 : sentence.length / 2;
    const from = Math.max(0, Math.floor(center - MAX_SENTENCE_LEN / 2));
    sentence = sentence.slice(from, from + MAX_SENTENCE_LEN);
  }
  return sentence;
}
