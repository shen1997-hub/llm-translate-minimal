// 增量解 [i] 标记流：把逐 token 到达的原始文本切成「第 i 段的增量」。
// JSON 无法增量解复用（{"items":[... 要等闭合才能 parse），所以流式路径恒用 plain 标记格式。
export interface MarkerDemux {
  push(chunk: string): void;
  finish(): string;
}

// 半截标记（形如 "[12"、"[") 必须挂起：立刻吐出会让用户看到闪过的 "[12"，
// 而它其实是标记的一部分，不是正文。
const PARTIAL_MARKER_RE = /\[\d*$/;

export function createMarkerDemux(expected: number, onDelta: (index: number, text: string) => void): MarkerDemux {
  let raw = '';     // 全量累积，finish() 交 parsePlainResponse 权威解析
  let pending = ''; // 尚未归属的尾缓冲
  let current = -1; // 当前归属下标；-1 = 首个合法标记之前（引言，丢弃）

  // 找首个「合法」标记。正则每次新建，避免共享 lastIndex 串状态。
  function findMarker(s: string): { index: number; end: number; i: number } | null {
    const re = /\[(\d+)\]\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const i = Number(m[1]);
      if (i >= 0 && i < expected) return { index: m.index, end: m.index + m[0].length, i };
    }
    return null;
  }

  function emit(text: string): void {
    if (text === '' || current < 0) return;
    onDelta(current, text);
  }

  // 吐到安全边界为止：尾部若可能是半截标记就挂起
  function flush(): void {
    const hit = PARTIAL_MARKER_RE.exec(pending);
    if (!hit) {
      // 尾部干净：整段照吐。不能 trimEnd——token 常带词尾空格（"Hello " + "world"），
      // 修剪会把相邻单词粘成 "Helloworld"。
      emit(pending);
      pending = '';
      return;
    }
    // 尾部是半截标记：它前面那段空白是段间分隔（"\n\n[1"），跟着标记一起挂起，
    // 不能单独当成一次增量吐出去。
    const cut = hit.index;
    if (cut === 0) return;
    emit(pending.slice(0, cut).trimEnd());
    pending = pending.slice(cut);
  }

  function drain(): void {
    for (;;) {
      const hit = findMarker(pending);
      if (!hit) { flush(); return; }
      // 标记前的正文属于上一个下标；标记后的 \s* 已吃掉段间空白，这里只兜尾部残留
      emit(pending.slice(0, hit.index).trimEnd());
      pending = pending.slice(hit.end);
      current = hit.i;
    }
  }

  return {
    push(chunk) { raw += chunk; pending += chunk; drain(); },
    finish() { flush(); return raw; },
  };
}