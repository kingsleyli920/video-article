import { countArticleChars, parseArticle, validateArticle } from '../shared/article';
import { LIMITS } from '../shared/limits';
import { parseVideoId } from '../shared/video-id';
import { AppError, isBusy, toAppError } from './app-error';
import { fallbackModel, geminiOptions, transcriptOptions } from './config';
import { ClientGone, EventStream } from './event-stream';
import { streamText } from './gemini';
import { checkDamagedNumbers } from './number-check';
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
 * 客户端断开、输出流关闭或出错、写入受阻时 events.signal 中止：进行中的字幕请求和 Gemini 请求随之取消，
 * 之后不再启动新的生成或保存（保存前会再检查一次）。已经发出的保存请求可能仍会完成，取消与保存不是原子的。
 */
async function runGeneration(input: GenerationInput, env: Env, events: EventStream): Promise<void> {
  const startedAt = Date.now();
  const since = () => Date.now() - startedAt;
  const log: Record<string, unknown> = { event: 'generation', videoId: input.videoId };
  let markdown = '';
  const stopHeartbeat = events.heartbeat(HEARTBEAT_INTERVAL_MS);
  // 记录服务端发现客户端离开的时点，用于和客户端停止时间、上游终止时间对照
  events.signal.addEventListener('abort', () => (log.clientGoneMs = since()), { once: true });

  try {
    await events.send('stage', { stage: 'transcript' });
    const { transcript, info } = await loadTranscript(input.videoId, { ...transcriptOptions(env), signal: events.signal });
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
    const write = (model: string) =>
      streamText(
        { ...gemini, model },
        prompt,
        async (text) => {
          firstTokenMs ??= since();
          markdown += text;
          if (markdown.length > LIMITS.articleChars) throw new AppError('article_too_long');
          await events.send('delta', { text });
        },
        events.signal,
      );
    let model = gemini.model;
    let finishReason: string | null;
    try {
      finishReason = await write(model);
    } catch (err) {
      // 主模型还没输出任何内容就持续繁忙：整篇改用备用模型。已经有输出时不换，避免拼接两个模型的输出
      const fallback = fallbackModel(env);
      if (!fallback || !isBusy(err) || markdown !== '') throw err;
      Object.assign(log, { fallbackFrom: model, fallbackReason: err.detail ?? null, fallbackMs: since() });
      model = fallback;
      finishReason = await write(model);
    }
    const modelDoneMs = since();
    const chars = countArticleChars(markdown);
    Object.assign(log, { model, finishReason, firstTokenMs, modelDoneMs, articleChars: chars });
    assertFinished(finishReason);

    const article = parseArticle(markdown);
    const problem = validateArticle(article);
    if (problem) throw new AppError('invalid_structure', problem);
    const numberWarnings = checkDamagedNumbers(transcriptText, markdown);
    events.throwIfGone(); // 模型结束到保存之间客户端已经离开：不再保存

    const context: GenerationContext = {
      version: 1,
      generationId,
      createdAt: new Date(startedAt).toISOString(),
      model,
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
    Object.assign(log, { ok: true, chapters: article.chapters.length, savedMs: timing.savedMs, numberWarnings: numberWarnings.length });
    await events.send('done', { chapters: article.chapters.map(({ id, title }) => ({ id, title })), chars, timing, numberWarnings, model });
  } catch (err) {
    if (err instanceof ClientGone) {
      // stoppedMs：上游请求已经被取消、本流程停止的时点
      Object.assign(log, { ok: false, code: `client_${err.reason}`, stoppedMs: since() });
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
