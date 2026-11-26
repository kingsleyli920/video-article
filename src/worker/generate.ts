import { countArticleChars, hasReadableParagraph, parseArticle, validateArticle } from '../shared/article';
import { LIMITS, REQUIREMENTS_TIMING, REVIEW_TIMING } from '../shared/limits';
import { parseVideoId } from '../shared/video-id';
import { AppError, isBusy, toAppError } from './app-error';
import { fallbackConfig, geminiOptions, timeoutScale, transcriptOptions } from './config';
import { ClientGone, EventStream } from './event-stream';
import { finalizeArticle } from './finalize';
import { streamText, type FallbackConfig, type GeminiOptions, type GeminiStats } from './gemini';
import { generateJsonWithFallback, scaleBudget } from './json-model';
import { checkDamagedNumbers } from './number-check';
import { articlePrompt } from './prompts';
import { NO_REQUIREMENTS, parseRequirements, REQUIREMENTS_SCHEMA, requirementsPrompt, type Requirements } from './requirements';
import { createStore, type GenerationContext } from './store';
import { loadTranscript } from './transcripts';
import { transcriptPreview } from './transcript-preview';
import { prepareTranscript, TranscriptError } from './youtube';

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
  const events = new EventStream(writable.getWriter(), { clientSignal: request.signal });
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
 * 收尾阶段（修订、核对）期间不再有 delta 写出，入站请求的中止信号在 wrangler dev 里也不会提前触发（见 event-stream.ts），
 * 客户端断开只能靠写入失败发现。这期间每秒写一次心跳，断开后一两秒内就能取消核对请求并放弃保存，
 * 而不是等核对结束（线上每章可能一两分钟）后照样保存。
 */
const FINALIZE_HEARTBEAT_MS = 1_000;

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
    const { text: transcriptText, damagedNumbers } = prepareTranscript(transcript.cues);
    if (transcriptText.length > LIMITS.transcriptChars) {
      throw new AppError('transcript_too_long', `${transcriptText.length} 字符，上限 ${LIMITS.transcriptChars}`);
    }
    const transcriptMs = since();
    const gemini = geminiOptions(env);
    const { generationId, store } = createStore(env);
    Object.assign(log, {
      source: info.source,
      transcriptAttempts: transcript.attempts,
      transcriptChars: transcriptText.length,
      damagedNumbers: damagedNumbers.map((d) => `${d.time} ${d.fragment}`),
      model: gemini.model,
      transcriptMs,
    });

    await events.send('meta', {
      generationId,
      video: { id: transcript.video.id, title: transcript.video.title, channel: transcript.video.channel, lengthSeconds: transcript.video.lengthSeconds },
      transcript: { ...info, chars: transcriptText.length, preview: transcriptPreview(transcript.cues) },
      model: gemini.model,
    });
    await events.send('stage', { stage: 'generating' });

    const scale = timeoutScale(env);
    const fallback = fallbackConfig(env);
    const usage: { requirements: unknown; rewrite: unknown; review: unknown[] } = { requirements: null, rewrite: null, review: [] };
    // 用户要求里的可计算约束（字数、章数、小节）：和写文章同时开始提取，文章写完时已经有结果，不增加等待
    const requirements = extractRequirements(input.instructions, gemini, fallback, scale, events.signal, usage);
    requirements.catch(() => {}); // 出错留到收尾阶段统一处理，这里只避免未处理的拒绝

    let firstTokenMs: number | null = null;
    let firstParagraphMs: number | null = null;
    let lastDeltaMs: number | null = null;
    const stats: GeminiStats = {};
    const prompt = articlePrompt({ video: transcript.video, transcriptText, instructions: input.instructions });
    // 思考档由调用方明确给出，不设默认值：备用模型没配思考档时传进来的是 undefined，请求里就不带 thinkingConfig，
    // 不会悄悄用回主模型的档位
    const write = (model: string, thinkingLevel: string | undefined) =>
      streamText(
        { ...gemini, model, thinkingLevel },
        prompt,
        async (text) => {
          firstTokenMs ??= since();
          markdown += text;
          if (markdown.length > LIMITS.articleChars) throw new AppError('article_too_long');
          await events.send('delta', { text });
          lastDeltaMs = since();
          if (firstParagraphMs === null && hasReadableParagraph(markdown)) firstParagraphMs = lastDeltaMs;
        },
        events.signal,
        stats,
      );
    let model = gemini.model;
    let finishReason: string | null;
    try {
      finishReason = await write(model, gemini.thinkingLevel);
    } catch (err) {
      // 主模型还没输出任何内容就持续繁忙：整篇改用备用模型。已经有输出时不换，避免拼接两个模型的输出
      if (!fallback || !isBusy(err) || markdown !== '') throw err;
      Object.assign(log, { fallbackFrom: model, fallbackTo: fallback.model, fallbackThinkingLevel: fallback.thinkingLevel ?? null, fallbackReason: err.detail ?? null, fallbackMs: since() });
      model = fallback.model;
      finishReason = await write(model, fallback.thinkingLevel);
    }
    const modelDoneMs = since();
    // 文章只有一段正文时，要到最后一段发出才算读到完整段落
    if (firstParagraphMs === null && finishReason === 'STOP' && hasReadableParagraph(markdown, true)) firstParagraphMs = lastDeltaMs;
    // 用量、模型版本、服务档都来自已经收到的终止事件和响应头，不为它多等连接关闭
    Object.assign(log, {
      model,
      modelVersion: stats.modelVersion ?? null,
      serviceTier: stats.serviceTierHeader ?? stats.usage?.serviceTier ?? null,
      usage: stats.usage ?? null,
      finishReason,
      firstTokenMs,
      firstParagraphMs,
      modelDoneMs,
      draftChars: countArticleChars(markdown),
    });
    assertFinished(finishReason);
    const draftProblem = validateArticle(parseArticle(markdown));
    if (draftProblem) throw new AppError('invalid_structure', draftProblem);

    // 初稿已经流式发给页面。保存之前先核对：可计算的用户约束、逐章对照字幕（见 finalize.ts）
    const draft = markdown;
    const stopFinalizeHeartbeat = events.heartbeat(FINALIZE_HEARTBEAT_MS);
    const final = await finalizeArticle(
      { draft, video: transcript.video, transcriptText, instructions: input.instructions, requirements },
      {
        json: async (prompt, schema) => {
          const { raw, model: usedModel, stats: s } = await generateJsonWithFallback(gemini, fallback, prompt, schema, scaleBudget(REVIEW_TIMING, scale), { purpose: 'review', signal: events.signal });
          usage.review.push({ model: usedModel, usage: s.usage ?? null });
          return raw;
        },
        rewrite: async (prompt) => {
          let text = '';
          const s: GeminiStats = {};
          const reason = await streamText(gemini, prompt, async (chunk) => void (text += chunk), events.signal, s);
          usage.rewrite = { model: gemini.model, usage: s.usage ?? null };
          assertFinished(reason);
          return text;
        },
      },
      (stage) => events.send('stage', { stage }),
    ).finally(stopFinalizeHeartbeat);
    markdown = final.markdown;
    const reviewedMs = since();
    const article = parseArticle(markdown);
    const chars = countArticleChars(markdown);
    const numberWarnings = checkDamagedNumbers(damagedNumbers, transcriptText, markdown);
    Object.assign(log, { articleChars: chars, review: final.review, reviewRejected: final.rejected, requirements: final.requirements, reviewUsage: usage, reviewedMs });
    events.throwIfGone(); // 核对结束到保存之间客户端已经离开：不再保存

    const context: GenerationContext = {
      version: 1,
      generationId,
      createdAt: new Date(startedAt).toISOString(),
      model,
      video: transcript.video,
      transcript: { ...info, chars: transcriptText.length, text: transcriptText, damagedNumbers },
      instructions: input.instructions,
      article: { title: article.title, markdown, chapters: article.chapters },
      review: { ...final.review, items: final.revisions, requirements: final.requirements, ...(markdown === draft ? {} : { draft }) },
    };
    try {
      await store.save(context);
    } catch (err) {
      console.error(JSON.stringify({ event: 'save_failed', generationId, error: String(err) }));
      throw new AppError('save_failed');
    }

    // 最终文章和初稿不同：先把最终版本发给页面，页面显示的和刚保存的是同一份
    if (markdown !== draft) await events.send('revised', { markdown, revisions: final.revisions });
    const timing = { transcriptMs, firstTokenMs, firstParagraphMs, modelDoneMs, reviewedMs, savedMs: since() };
    Object.assign(log, { ok: true, chapters: article.chapters.length, savedMs: timing.savedMs, numberWarnings: numberWarnings.length });
    await events.send('done', { chapters: article.chapters.map(({ id, title }) => ({ id, title })), chars, timing, numberWarnings, model, review: final.review });
  } catch (err) {
    if (err instanceof ClientGone) {
      // stoppedMs：上游请求已经被取消、本流程停止的时点
      Object.assign(log, { ok: false, code: `client_${err.reason}`, stoppedMs: since() });
      return;
    }
    const error = toAppError(err);
    if (error.code === 'internal') console.error(err);
    Object.assign(log, { ok: false, code: error.code });
    if (err instanceof TranscriptError) log.transcriptAttempts = err.attempts;
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

/** 没有用户要求时不调用模型；提取用低档思考（只是从一句话里找数字），主模型繁忙时换备用模型 */
async function extractRequirements(
  instructions: string,
  gemini: GeminiOptions,
  fallback: FallbackConfig | null,
  scale: number,
  signal: AbortSignal,
  usage: { requirements: unknown },
): Promise<Requirements> {
  if (!instructions.trim()) return NO_REQUIREMENTS;
  const { raw, model, stats } = await generateJsonWithFallback({ ...gemini, thinkingLevel: 'low' }, fallback, requirementsPrompt(instructions), REQUIREMENTS_SCHEMA, scaleBudget(REQUIREMENTS_TIMING, scale), {
    purpose: 'requirements',
    signal,
  });
  const { requirements, dropped } = parseRequirements(raw, instructions);
  usage.requirements = { model, usage: stats.usage ?? null, dropped };
  return requirements;
}
