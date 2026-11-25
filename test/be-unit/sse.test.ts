import { describe, expect, it } from 'vitest';
import { encodeSse, readSse, SseParser } from '../../src/shared/sse';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const message of readSse(body)) out.push(message);
  return out;
}

describe('SseParser', () => {
  // 抓：网络分块切在 "data:" 前缀、JSON 中间、\r 与 \n 之间时事件丢失或被拼错
  it('每个字符单独成块也能完整还原事件，含 \\r\\n 被拆开的情况', () => {
    const raw = 'event: delta\r\ndata: {"text":"第一段"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n';
    const parser = new SseParser();
    const messages = [...raw].flatMap((ch) => parser.push(ch));
    expect(messages).toEqual([
      { event: 'delta', data: '{"text":"第一段"}' },
      { event: 'done', data: '{}' },
    ]);
  });

  // 抓：多行 data 没有用 \n 连接、注释行被当成数据、缺省事件名不是 message
  it('多行 data 用换行连接，注释行忽略，没有 event 字段时事件名为 message', () => {
    const parser = new SseParser();
    const messages = parser.push(': keep-alive\ndata: 第一行\ndata: 第二行\n\n');
    expect(messages).toEqual([{ event: 'message', data: '第一行\n第二行' }]);
  });

  // 抓：流结束时把没有空行收尾的残缺事件当成完整事件交出去
  it('流结束时丢弃没有空行收尾的残缺事件', () => {
    const parser = new SseParser();
    expect(parser.push('event: delta\ndata: {"text":"半截')).toEqual([]);
    expect(parser.end()).toEqual([]);
  });

  it('encodeSse 输出可以被解析回原数据', () => {
    const parser = new SseParser();
    expect(parser.push(encodeSse('delta', { text: '中文\n换行' }))).toEqual([{ event: 'delta', data: '{"text":"中文\\n换行"}' }]);
  });
});

describe('readSse', () => {
  // 抓：多字节中文被切在两个网络分块之间时出现乱码（TextDecoder 没用 stream 模式）
  it('中文字符的 UTF-8 字节被切在分块之间时仍能正确解码', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"智能经济"}\n\n');
    // "智" 占 3 个字节，从它的第 2 个字节处切开
    const cut = bytes.indexOf(0xe6) + 1;
    const messages = await collect(streamOf([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(messages).toEqual([{ event: 'message', data: '{"text":"智能经济"}' }]);
  });

  it('逐字节分块的长流也能完整读出全部事件', async () => {
    const text = Array.from({ length: 20 }, (_, i) => `event: delta\ndata: {"text":"第${i}段"}\n\n`).join('');
    const bytes = new TextEncoder().encode(text);
    const messages = await collect(streamOf([...bytes].map((b) => new Uint8Array([b]))));
    expect(messages).toHaveLength(20);
    expect(messages[19]).toEqual({ event: 'delta', data: '{"text":"第19段"}' });
  });
});
