import { encodeSse } from '../shared/sse';
import type { StreamEvents } from '../shared/types';

/** 客户端已断开（disconnected）或长时间读不走数据（stalled）。生成流程据此取消上游工作。 */
export class ClientGone extends Error {
  readonly reason: 'disconnected' | 'stalled';

  constructor(reason: 'disconnected' | 'stalled') {
    super(reason === 'stalled' ? '客户端长时间未读取数据' : '客户端已断开');
    this.reason = reason;
  }
}

export interface EventStreamOptions {
  /** 单次写入的等待上限。正常背压不算模型空闲，但下游持续写不进去时要能退出 */
  writeTimeoutMs?: number;
  /**
   * 入站请求的 request.signal。按 Cloudflare 文档，兼容日期 2026-11-17 起客户端断开时它会中止。
   * 但实测（2026-11-25，本地 wrangler dev 和线上）模型还没输出时客户端断开，它没有提前触发：
   * 服务端仍在下一次写入（模型首个分块或 15 秒一次的心跳）失败时才发现。保留它作为额外的来源，不依赖它。
   */
  clientSignal?: AbortSignal;
}

const DEFAULT_WRITE_TIMEOUT_MS = 30_000;

/**
 * 往客户端写 SSE 的唯一出口。输出流出错或被关闭、任何一次写入失败（包括心跳）或写入超时，都会：
 * 1. 让 signal 进入中止状态，生成流程把它传给 YouTube 和 Gemini 请求，及时取消上游；
 * 2. 之后所有 send 直接抛 ClientGone。
 */
export class EventStream {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #encoder = new TextEncoder();
  readonly #controller = new AbortController();
  readonly #writeTimeoutMs: number;
  #gone: ClientGone | null = null;
  #closed = false;
  #pending = 0;

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>, options: EventStreamOptions = {}) {
    this.#writer = writer;
    this.#writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    // 两个来源发现客户端断开：入站请求的中止信号（不依赖写入，等待模型时也有效），以及输出流被关闭或出错
    const { clientSignal } = options;
    if (clientSignal?.aborted) this.#fail('disconnected');
    clientSignal?.addEventListener('abort', () => {
      if (!this.#closed) this.#fail('disconnected');
    });
    writer.closed.then(
      () => {
        if (!this.#closed) this.#fail('disconnected');
      },
      () => this.#fail('disconnected'),
    );
  }

  /** 客户端断开或写入受阻时中止 */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** 客户端已经离开时抛出 ClientGone；用于在开始新的工作（如保存）之前检查 */
  throwIfGone(): void {
    if (this.#gone) throw this.#gone;
  }

  send<K extends keyof StreamEvents>(event: K, data: StreamEvents[K]): Promise<void> {
    return this.#write(encodeSse(event, data));
  }

  /** 固定间隔写注释行保持连接；已有写入在排队时跳过，避免在背压下堆积。返回停止函数。 */
  heartbeat(intervalMs: number): () => void {
    const timer = setInterval(() => {
      if (this.#closed || this.#gone) return clearInterval(timer);
      if (this.#pending === 0) this.#write(': keep-alive\n\n').catch(() => clearInterval(timer));
    }, intervalMs);
    return () => clearInterval(timer);
  }

  async close(): Promise<void> {
    if (this.#closed || this.#gone) return;
    this.#closed = true;
    await this.#writer.close().catch(() => {});
  }

  async #write(text: string): Promise<void> {
    if (this.#gone) throw this.#gone;
    this.#pending++;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ClientGone('stalled')), this.#writeTimeoutMs);
    });
    try {
      await Promise.race([this.#writer.write(this.#encoder.encode(text)), timeout]);
    } catch (err) {
      throw this.#fail(err instanceof ClientGone ? err.reason : 'disconnected');
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.#pending--;
    }
  }

  #fail(reason: ClientGone['reason']): ClientGone {
    if (!this.#gone) {
      this.#gone = new ClientGone(reason);
      this.#controller.abort(this.#gone);
      this.#writer.abort(this.#gone).catch(() => {});
    }
    return this.#gone;
  }
}
