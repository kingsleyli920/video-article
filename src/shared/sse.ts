export interface SseMessage {
  event: string;
  data: string;
}

export function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * text/event-stream 的增量解析器（event、data 和注释行）。
 * 输入是已解码的字符串片段，片段可以在任意位置断开，包括 \r\n 之间。
 */
export class SseParser {
  #buffer = '';
  #event = '';
  #data: string[] = [];

  push(chunk: string): SseMessage[] {
    const buf = this.#buffer + chunk;
    const out: SseMessage[] = [];
    let pos = 0;
    for (;;) {
      const lf = buf.indexOf('\n', pos);
      const cr = buf.indexOf('\r', pos);
      let end: number;
      let next: number;
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        if (cr === buf.length - 1) break; // 可能是被切开的 \r\n，等下一片
        end = cr;
        next = buf[cr + 1] === '\n' ? cr + 2 : cr + 1;
      } else if (lf !== -1) {
        end = lf;
        next = lf + 1;
      } else {
        break;
      }
      const message = this.#line(buf.slice(pos, end));
      if (message) out.push(message);
      pos = next;
    }
    this.#buffer = buf.slice(pos);
    return out;
  }

  /** 流结束：末尾的单独 \r 算换行；没有空行收尾的残缺事件按规范丢弃。 */
  end(): SseMessage[] {
    const out = this.#buffer.endsWith('\r') ? this.push('\n') : [];
    this.#buffer = '';
    this.#event = '';
    this.#data = [];
    return out;
  }

  #line(line: string): SseMessage | null {
    if (line === '') {
      const message = this.#data.length ? { event: this.#event || 'message', data: this.#data.join('\n') } : null;
      this.#event = '';
      this.#data = [];
      return message;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.#event = value;
    else if (field === 'data') this.#data.push(value);
    return null;
  }
}

/**
 * 逐条读取字节流里的 SSE 消息。多字节字符被切在两个分块之间时由 TextDecoder 的 stream 模式拼回。
 * onChunk 在每个网络分块到达时调用（包括只含注释的心跳），供调用方判断连接是否还活着。
 * 调用方提前结束迭代时只发起取消、不等待取消完成，避免卡在一个不再需要的连接上。
 */
export async function* readSse(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    finished = true;
    yield* parser.push(decoder.decode());
    yield* parser.end();
  } finally {
    if (!finished) reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // 读请求仍挂起时释放锁会失败，取消已经发出，忽略即可
    }
  }
}
