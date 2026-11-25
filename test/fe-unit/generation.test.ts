import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, requestSummary } from '../../src/client/api';
import { runGeneration, type GenerationUi } from '../../src/client/generation';
import { encodeSse } from '../../src/shared/sse';

afterEach(() => vi.restoreAllMocks());

const INPUT = { url: 'https://www.youtube.com/watch?v=xRh2sVcNXQ8', instructions: '' };
const META = {
  generationId: 'g1',
  video: { id: 'xRh2sVcNXQ8', title: '视频', channel: '频道', lengthSeconds: 60 },
  transcript: { source: 'live', language: 'en', kind: 'asr', chars: 10 },
  model: 'm',
};
const DONE = { chapters: [{ id: '1', title: '第一章' }], timing: { transcriptMs: 1, firstTokenMs: 2, modelDoneMs: 3, savedMs: 4 } };

/** 记录页面收到的回调 */
function recorder() {
  const calls: string[] = [];
  const ui: GenerationUi = {
    stage: (s) => calls.push(`stage:${s}`),
    meta: () => calls.push('meta'),
    delta: (md) => calls.push(`delta:${md}`),
    done: (_r, md, id) => calls.push(`done:${id}:${md}`),
    fail: (e, md) => calls.push(`fail:${e.code}:${md}`),
  };
  return { ui, calls };
}

/**
 * 按需推送事件的响应：每次读取才推一个事件（和真实网络一样），推完之后按 after 决定连接怎么样：
 * 'hang' 一直不关，'error' 下一次读取出错，'close' 正常结束。
 * 和真实 fetch 一样，中止信号触发时响应体报错。记录浏览器是否取消或中止了这条连接。
 */
function stream(events: [string, unknown][], after: 'hang' | 'error' | 'close') {
  const state = { cancelled: false, aborted: () => false };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const signal = init!.signal!;
    state.aborted = () => signal.aborted;
    const queue = events.map(([name, data]) => new TextEncoder().encode(encodeSse(name, data)));
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          signal.addEventListener('abort', () => {
            try {
              controller.error(signal.reason);
            } catch {
              // 已经关闭或取消
            }
          });
        },
        pull(controller) {
          const next = queue.shift();
          if (next) return controller.enqueue(next);
          if (after === 'close') return controller.close();
          if (after === 'error') return controller.error(new TypeError('network reset'));
          return new Promise<void>(() => {}); // 一直不再给数据
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  return state;
}

describe('runGeneration', () => {
  // 抓：switch 里的 break 只跳出 switch，收到 done 后还在等 HTTP EOF，表单一直锁着
  it('收到 done 后连接迟迟不关：立即以 done 结束，并主动断开连接', async () => {
    const conn = stream([['stage', { stage: 'transcript' }], ['meta', META], ['delta', { text: '# 标题' }], ['done', DONE]], 'hang');
    const { ui, calls } = recorder();
    await expect(runGeneration(INPUT, ui, { idleTimeoutMs: 5_000 })).resolves.toBe('done');
    expect(calls).toEqual(['stage:transcript', 'meta', 'stage:writing', 'delta:# 标题', 'done:g1:# 标题']);
    expect(conn.cancelled).toBe(true);
    expect(conn.aborted()).toBe(true);
  });

  it('收到 error 后连接迟迟不关：立即以 failed 结束，保留已生成内容', async () => {
    stream([['meta', META], ['delta', { text: '半截' }], ['error', { code: 'interrupted', message: '生成中断，文章不完整', partial: true }]], 'hang');
    const { ui, calls } = recorder();
    await expect(runGeneration(INPUT, ui, { idleTimeoutMs: 5_000 })).resolves.toBe('failed');
    expect(calls.at(-1)).toBe('fail:interrupted:半截');
  });

  // 抓：已经展示完整文章，之后的连接异常又把状态改成失败
  it('收到 done 后连接读取出错：结果仍是 done，不再触发 fail', async () => {
    stream([['meta', META], ['delta', { text: '全文' }], ['done', DONE]], 'error');
    const { ui, calls } = recorder();
    await expect(runGeneration(INPUT, ui)).resolves.toBe('done');
    expect(calls.filter((c) => c.startsWith('fail'))).toEqual([]);
  });

  // 抓：停止生成后已生成的内容丢失，或者按钮一直是"生成中"
  it('用户停止：以 cancelled 结束，保留已生成内容，并断开连接', async () => {
    const conn = stream([['meta', META], ['delta', { text: '写到一半' }]], 'hang');
    const controller = new AbortController();
    const { ui, calls } = recorder();
    const pending = runGeneration(INPUT, { ...ui, delta: (md) => (ui.delta(md), controller.abort()) }, { signal: controller.signal, idleTimeoutMs: 5_000 });
    await expect(pending).resolves.toBe('cancelled');
    expect(calls.at(-1)).toBe('fail:cancelled:写到一半');
    expect(conn.aborted()).toBe(true);
  });

  // 抓：连接卡住、连心跳都没有时页面无限等待
  it('长时间收不到任何字节：以 client_timeout 失败，并中止请求', async () => {
    const conn = stream([['meta', META]], 'hang');
    const { ui, calls } = recorder();
    await expect(runGeneration(INPUT, ui, { idleTimeoutMs: 50 })).resolves.toBe('failed');
    expect(calls.at(-1)).toBe('fail:client_timeout:');
    expect(conn.aborted()).toBe(true);
  });

  it('心跳注释会刷新空闲计时，正常的长等待不被误判为超时', async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(encodeSse('meta', META)));
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 30));
          controller.enqueue(enc.encode(': keep-alive\n\n'));
        }
        controller.enqueue(enc.encode(encodeSse('delta', { text: '正文' }) + encodeSse('done', DONE)));
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    const { ui } = recorder();
    // 空闲上限 60ms，整段等待约 120ms，但每 30ms 有一次心跳
    await expect(runGeneration(INPUT, ui, { idleTimeoutMs: 60 })).resolves.toBe('done');
  });
});

describe('requestSummary', () => {
  // 抓：5W1H 请求一直不返回时面板永远停在"正在生成"
  it('超时后以 client_timeout 失败，并中止请求', async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          signal = init!.signal!;
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    await expect(requestSummary('g1', '1', { totalTimeoutMs: 50 })).rejects.toEqual(new ApiError('client_timeout'));
    expect(signal?.aborted).toBe(true);
  });

  it('请求不带请求体', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ chapterId: '1', cached: false, summary: {} }));
    await requestSummary('g1', '1');
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(fetchSpy.mock.calls[0]![1]!.body).toBeUndefined();
  });
});
