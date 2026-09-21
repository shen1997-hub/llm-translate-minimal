// 极简 SSE 读帧：只覆盖本项目用到的子集——忽略 event/id/retry 行，
// 多行 data: 用 \n 拼接，[DONE] 与空 data 帧跳过。
export async function readSse(res: Response, onData: (data: string) => void): Promise<void> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let pendingCr = false; // 上一个 chunk 以 \r 结尾：可能是被劈开的 \r\n

  function feed(frame: string): void {
    const data = frame
      .split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data !== '' && data !== '[DONE]') onData(data);
  }

  function drain(): void {
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      feed(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
    }
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let s = decoder.decode(value, { stream: true });
    if (pendingCr) {
      // 上个 chunk 末尾的 \r 已经按行结束符扣下了：它可能是被劈开的 \r\n（吃掉下一个 \n），
      // 也可能是单个 CR。两种情况都要还原成一个 \n，少还原就等于吞掉一个换行。
      pendingCr = false;
      s = '\n' + (s.startsWith('\n') ? s.slice(1) : s);
    }
    if (s.endsWith('\r')) {
      s = s.slice(0, -1);
      pendingCr = true;
    }
    buf += s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    drain();
  }
  // 真实 SSE 都会以空行收尾，这里兜住没有收尾空行的流
  const tail = buf.trim();
  if (tail !== '') feed(tail);
}