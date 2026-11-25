import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientGone, EventStream } from '../../src/worker/event-stream';

afterEach(() => vi.useRealTimers());

/** 一个没人读取的流：写入会一直挂起（模拟下游持续写不进去） */
function unreadStream() {
  const { writable } = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, { highWaterMark: 0 });
  return writable.getWriter();
}

/** 一个被客户端取消的流：写入立即失败（模拟浏览器断开） */
async function cancelledStream() {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  await readable.cancel('client closed');
  return writable.getWriter();
}

async function readAll(readable: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(readable).text();
}

describe('EventStream', () => {
  it('正常写出 SSE 事件，close 后流结束', async () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const events = new EventStream(writable.getWriter());
    const text = readAll(readable);
    await events.send('delta', { text: '你好' });
    await events.close();
    expect(await text).toBe('event: delta\ndata: {"text":"你好"}\n\n');
    expect(events.signal.aborted).toBe(false);
  });

  // 抓：浏览器不读数据时 send 永远挂起，生成流程既不结束也不释放上游
  it('下游持续写不进去时在写入上限后报 stalled，并中止上游信号', async () => {
    const events = new EventStream(unreadStream(), { writeTimeoutMs: 50 });
    await expect(events.send('delta', { text: 'x' })).rejects.toMatchObject({ reason: 'stalled' });
    expect(events.signal.aborted).toBe(true);
    expect(events.signal.reason).toBeInstanceOf(ClientGone);
    await expect(events.send('delta', { text: 'y' })).rejects.toMatchObject({ reason: 'stalled' });
  });

  // 抓：只有下一次写入或心跳时才发现断开，期间上游还在白白生成
  it('客户端断开后不需要再写入，输出流一出错就中止上游信号', async () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const events = new EventStream(writable.getWriter());
    expect(events.signal.aborted).toBe(false);
    await readable.cancel('client closed');
    await Promise.resolve();
    expect(events.signal.aborted).toBe(true);
    expect(() => events.throwIfGone()).toThrow(ClientGone);
  });

  it('自己正常关闭输出流不算客户端断开', async () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const events = new EventStream(writable.getWriter());
    const drained = new Response(readable).text();
    await events.close();
    await drained;
    expect(events.signal.aborted).toBe(false);
    expect(() => events.throwIfGone()).not.toThrow();
  });

  it('客户端已断开时写入报 disconnected，并中止上游信号', async () => {
    const events = new EventStream(await cancelledStream());
    await expect(events.send('stage', { stage: 'transcript' })).rejects.toMatchObject({ reason: 'disconnected' });
    expect(events.signal.aborted).toBe(true);
  });

  // 抓：心跳写入失败只停止心跳，正在等字幕或等首个 token 的上游请求没有被取消
  it('等待期间心跳写入失败也会中止上游信号', async () => {
    vi.useFakeTimers();
    const events = new EventStream(await cancelledStream());
    const stop = events.heartbeat(1_000);
    expect(events.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.signal.aborted).toBe(true);
    stop();
  });

  // 抓：背压下心跳不断排队，掩盖下游受阻
  it('有写入在排队时跳过心跳，不在背压下堆积', async () => {
    vi.useFakeTimers();
    const writer = unreadStream();
    const write = vi.spyOn(writer, 'write');
    const events = new EventStream(writer, { writeTimeoutMs: 60_000 });
    const pending = events.send('delta', { text: 'x' }).catch(() => {});
    events.heartbeat(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(write).toHaveBeenCalledOnce();
    void pending;
  });
});
