import { describe, it, expect } from 'vitest';
import { readSse } from '../lib/translation/sse';

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
  });
  return new Response(stream, { status: 200 });
}

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  await readSse(sseResponse(chunks), (d) => out.push(d));
  return out;
}

describe('readSse', () => {
  it('按空行切帧，取 data: 行的内容', async () => {
    expect(await collect(['data: {"a":1}\n\ndata: {"b":2}\n\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('\\r\\n 行结束同样识别', async () => {
    expect(await collect(['data: {"a":1}\r\n\r\n'])).toEqual(['{"a":1}']);
  });

  it('帧被拆到两个 chunk 也能拼回来', async () => {
    expect(await collect(['data: {"a":', '1}\n\n'])).toEqual(['{"a":1}']);
  });

  it('\\r 恰好落在 chunk 边界（\\r\\n 被劈开）仍能切帧', async () => {
    // 被劈开的 \r\n 必须还原成一个换行：少还原一个就会把「中段的帧」吞掉，
    // 只靠流末尾的兜底才吐出来（这是单帧输入测不出来的）
    expect(await collect(['data: {"a":1}\r', '\n\r\ndata: {"b":2}\n\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('多行 data: 以 \\n 拼接；event:/id: 行忽略', async () => {
    expect(await collect(['event: content_block_delta\nid: 1\ndata: ab\ndata: cd\n\n'])).toEqual(['ab\ncd']);
  });

  it('跳过 [DONE] 与空 data 帧', async () => {
    expect(await collect(['data: [DONE]\n\n', 'data: {"a":1}\n\n'])).toEqual(['{"a":1}']);
  });

  it('流结束时没有空行收尾的残帧也交出去', async () => {
    expect(await collect(['data: {"a":1}'])).toEqual(['{"a":1}']);
  });

  it('data: 后没有空格也能取出内容', async () => {
    expect(await collect(['data:{"a":1}\n\n'])).toEqual(['{"a":1}']);
  });

  it('多字节字符被劈到两个 chunk 也能拼回来', async () => {
    // 中文流式输出里汉字字节几乎必然被任意切断，这里靠 TextDecoder({stream:true}) 兜住。
    // 注意必须真的切字节：用两个字符串拼接的话 TextEncoder 各编各的，切不出半个字。
    const bytes = new TextEncoder().encode('data: 译文\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes.slice(0, 8)); c.enqueue(bytes.slice(8)); c.close(); },
    });
    const out: string[] = [];
    await readSse(new Response(stream, { status: 200 }), (d) => out.push(d));
    expect(out).toEqual(['译文']);
  });

  it('body 为 null 时不抛错', async () => {
    const out: string[] = [];
    await readSse(new Response(null, { status: 204 }), (d) => out.push(d));
    expect(out).toEqual([]);
  });
});
