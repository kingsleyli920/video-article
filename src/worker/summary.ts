import type { SummaryResponse } from '../shared/types';
import { AppError } from './app-error';
import { geminiOptions } from './config';
import { generateJson } from './gemini';
import { summaryPrompt } from './prompts';
import { normalizeSummary, SUMMARY_SCHEMA } from './summary-schema';
import { openStore } from './store';

/**
 * 章节 5W1H：请求里只有 generationId 和章节 id（都在路径上），不接受请求体。
 * 字幕全文、用户要求和章节内容全部从 Durable Object 读取；成功的结果按章节存回同一个对象，重复请求直接复用。
 */
export async function handleSummary(request: Request, env: Env, generationId: string, chapterId: string): Promise<Response> {
  if ((await request.arrayBuffer()).byteLength > 0) throw new AppError('body_not_allowed');

  const store = openStore(env, generationId);
  const context = await store.load();
  if (!context) throw new AppError('generation_not_found');
  const chapter = context.article.chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new AppError('chapter_not_found');

  const cached = await store.getSummary(chapterId);
  if (cached) return json({ chapterId, summary: cached, cached: true });

  const raw = await generateJson(
    geminiOptions(env),
    summaryPrompt({
      video: context.video,
      transcriptText: context.transcript.text,
      instructions: context.instructions,
      chapterTitles: context.article.chapters.map((c) => c.title),
      chapter,
    }),
    SUMMARY_SCHEMA,
  );
  const summary = normalizeSummary(raw);
  await store.saveSummary(chapterId, summary);
  return json({ chapterId, summary, cached: false });
}

function json(body: SummaryResponse): Response {
  return Response.json(body);
}
