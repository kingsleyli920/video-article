import { parseArticle, validateArticle } from '../shared/article';
import { LIMITS } from '../shared/limits';
import { parseVideoId } from '../shared/video-id';
import { AppError, toAppError } from './app-error';
import { geminiOptions } from './config';
import { ClientGone, EventStream } from './event-stream';
import { streamText } from './gemini';
import { articlePrompt } from './prompts';
import { createStore, type GenerationContext } from './store';
import { loadTranscript } from './transcripts';
import { formatTranscript } from './youtube';

interface GenerationInput {
  videoId: string;
  instructions: string;
}

export async function readGenerationInput(request: Request): Promise<GenerationInput> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > LIMITS.requestBodyBytes) throw new AppError('invalid_request', '请求体过大');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError('invalid_request', '不是合法 JSON');
  }
  const { url, instructions = '' } = (body ?? {}) as { url?: unknown; instructions?: unknown };
  if (typeof url !== 'string' || url.length > LIMITS.urlChars) throw new AppError('invalid_url');
  if (typeof instructions !== 'string') throw new AppError('invalid_request', 'instructions 必须是字符串');
  if (instructions.length > LIMITS.instructionsChars) throw new AppError('instructions_too_long');
  const videoId = parseVideoId(url);
  if (!videoId) throw new AppError('invalid_url');
  return { videoId, instructions: instructions.trim() };
}

/** 生成接口：立即返回 SSE 响应，后台依次取字幕、流式生成、校验结构、保存上下文。 */
export async function handleGenerate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const input = await readGenerationInput(request);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const events = new EventStream(writable.getWriter());
  ctx.waitUntil(runGeneration(input, env, events));
  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** 模型首个 token 在线上可能要等几十秒；期间定时发 SSE 注释，让连接保持活跃（客户端按规范忽略注释）。 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * 客户端断开、写入失败或写入受阻时 events.signal 中止：字幕请求和 Gemini 请求随之取消，
 * 后续 send 抛 ClientGone，流程不再保存上下文。
 */
async function runGeneration(input: GenerationInput, env: Env, events: EventStream): Promise<void> {
  const startedAt = Date.now();
  const since = () => Date.now() - startedAt;
  const log: Record<string, unknown> = { event: 'generation', videoId: input.videoId };
  let markdown = '';
  const stopHeartbeat = events.heartbeat(HEARTBEAT_INTERVAL_MS);

  try {
    await events.send('stage', { stage: 'transcript' });
    const { transcript, info } = await loadTranscript(input.videoId, { signal: events.signal });
    const transcriptText = formatTranscript(transcript.cues);
    if (transcriptText.length > LIMITS.transcriptChars) {
      throw new AppError('transcript_too_long', `${transcriptText.length} 字符，上限 ${LIMITS.transcriptChars}`);
    }
    const transcriptMs = since();
    const gemini = geminiOptions(env);
    const { generationId, store } = createStore(env);
    Object.assign(log, { source: info.source, transcriptChars: transcriptText.length, model: gemini.model, transcriptMs });

    await events.send('meta', {
      generationId,
      video: { id: transcript.video.id, title: transcript.video.title, channel: transcript.video.channel, lengthSeconds: transcript.video.lengthSeconds },
      transcript: { ...info, chars: transcriptText.length },
      model: gemini.model,
    });
    await events.send('stage', { stage: 'generating' });

    let firstTokenMs: number | null = null;
    const prompt = articlePrompt({ video: transcript.video, transcriptText, instructions: input.instructions });
    const finishReason = await streamText(
      gemini,
      prompt,
      async (text) => {
        firstTokenMs ??= since();
        markdown += text;
        if (markdown.length > LIMITS.articleChars) throw new AppError('article_too_long');
        await events.send('delta', { text });
      },
      events.signal,
    );
    const modelDoneMs = since();
    Object.assign(log, { finishReason, firstTokenMs, modelDoneMs, articleChars: markdown.length });
    assertFinished(finishReason);

    const article = parseArticle(markdown);
    const problem = validateArticle(article);
    if (problem) throw new AppError('invalid_structure', problem);

    const context: GenerationContext = {
      version: 1,
      generationId,
      createdAt: new Date(startedAt).toISOString(),
      model: gemini.model,
      video: transcript.video,
      transcript: { ...info, chars: transcriptText.length, text: transcriptText },
      instructions: input.instructions,
      article: { title: article.title, markdown, chapters: article.chapters },
    };
    try {
      await store.save(context);
    } catch (err) {
      console.error(JSON.stringify({ event: 'save_failed', generationId, error: String(err) }));
      throw new AppError('save_failed');
    }

    const timing = { transcriptMs, firstTokenMs, modelDoneMs, savedMs: since() };
    Object.assign(log, { ok: true, chapters: article.chapters.length, savedMs: timing.savedMs });
    await events.send('done', { chapters: article.chapters.map(({ id, title }) => ({ id, title })), timing });
  } catch (err) {
    if (err instanceof ClientGone) {
      Object.assign(log, { ok: false, code: `client_${err.reason}` });
      return;
    }
    const error = toAppError(err);
    if (error.code === 'internal') console.error(err);
    Object.assign(log, { ok: false, code: error.code });
    await events.send('error', { code: error.code, message: error.message, partial: markdown.length > 0 }).catch(() => {});
  } finally {
    stopHeartbeat();
    await events.close();
    console.log(JSON.stringify({ ...log, totalMs: since() }));
  }
}

function assertFinished(finishReason: string | null): void {
  if (finishReason === 'STOP') return;
  if (finishReason === 'MAX_TOKENS') throw new AppError('truncated');
  if (finishReason === null) throw new AppError('interrupted', '模型没有给出结束标记');
  throw new AppError('blocked', finishReason);
}
