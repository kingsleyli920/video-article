import type { SummaryResponse } from '../shared/types';
import { AppError } from './app-error';
import { openStore } from './store';

/**
 * 章节 5W1H：请求里只有 generationId 和章节 id（都在路径上），不接受请求体。
 * 字幕全文、用户要求和章节内容全部在 Durable Object 里读取和生成（见 GenerationStore.summarize），
 * 成功的结果按章节存回同一个对象；同一章的并发请求在对象内合并。
 */
export async function handleSummary(request: Request, env: Env, generationId: string, chapterId: string): Promise<Response> {
  if ((await request.arrayBuffer()).byteLength > 0) throw new AppError('body_not_allowed');

  const result = await openStore(env, generationId).summarize(chapterId);
  if (!result.ok) throw new AppError(result.code, result.detail);
  const body: SummaryResponse = { chapterId, summary: result.summary, cached: result.cached };
  return Response.json(body);
}
