import { ERROR_MESSAGES, type ErrorCode } from '../shared/errors';
import type { StreamEvents } from '../shared/types';
import { ApiError, streamGeneration, type RequestOptions } from './api';

export type GenerationStage = 'transcript' | 'waiting' | 'writing';

/** 页面对一次生成的响应方式。done 和 fail 每次生成最多调用其中一个，且只调用一次。 */
export interface GenerationUi {
  stage(stage: GenerationStage): void;
  meta(meta: StreamEvents['meta']): void;
  delta(markdown: string): void;
  done(result: StreamEvents['done'], markdown: string, generationId: string): void;
  fail(error: { code: ErrorCode; message: string }, markdown: string): void;
}

export type GenerationOutcome = 'done' | 'failed' | 'cancelled';

/**
 * 消费一次生成的事件流。收到 done 或 error 立即结束，不等 HTTP 连接关闭；
 * 结束后连接上再发生什么（迟迟不关、读取出错）都不会改变已经展示的结果。
 */
export async function runGeneration(
  input: { url: string; instructions: string },
  ui: GenerationUi,
  options: RequestOptions = {},
): Promise<GenerationOutcome> {
  let markdown = '';
  let generationId = '';
  try {
    for await (const message of streamGeneration(input, options)) {
      switch (message.event) {
        case 'stage':
          ui.stage(message.data.stage === 'transcript' ? 'transcript' : 'waiting');
          break;
        case 'meta':
          generationId = message.data.generationId;
          ui.meta(message.data);
          break;
        case 'delta':
          if (!markdown) ui.stage('writing');
          markdown += message.data.text;
          ui.delta(markdown);
          break;
        case 'done':
          ui.done(message.data, markdown, generationId);
          return 'done';
        case 'error':
          ui.fail(message.data, markdown);
          return 'failed';
      }
    }
    ui.fail({ code: 'interrupted', message: ERROR_MESSAGES.interrupted }, markdown);
    return 'failed';
  } catch (err) {
    const error = err instanceof ApiError ? err : new ApiError('network');
    ui.fail({ code: error.code, message: error.message }, markdown);
    return error.code === 'cancelled' ? 'cancelled' : 'failed';
  }
}
