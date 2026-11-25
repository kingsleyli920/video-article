import { DurableObject } from 'cloudflare:workers';
import type { Chapter } from '../shared/article';
import type { ErrorCode } from '../shared/errors';
import type { ArticleReview, ChapterSummary, Revision, TranscriptInfo } from '../shared/types';
import { AppError, toAppError } from './app-error';
import { fallbackConfig, geminiOptions, timeoutScale } from './config';
import { generateSummaryJson, summaryBudget } from './summary-model';
import { summaryPrompt } from './prompts';
import { normalizeSummary, SUMMARY_SCHEMA } from './summary-schema';
import type { Requirements } from './requirements';
import type { DamagedNumber, VideoMeta } from './youtube';

/** 一次生成的完整上下文，5W1H 只从这里读取，不接收前端提交的内容。 */
export interface GenerationContext {
  version: 1;
  generationId: string;
  createdAt: string;
  model: string;
  video: VideoMeta;
  /** text 是交给模型的正文（残缺数字已换成占位）；damagedNumbers 是残缺数字的原始证据（旧数据没有这个字段） */
  transcript: TranscriptInfo & { text: string; damagedNumbers?: DamagedNumber[] };
  instructions: string;
  /** 最终文章（核对修订之后的版本）；5W1H 的章节取自这里 */
  article: { title: string; markdown: string; chapters: Chapter[] };
  /** 核对记录：采用的修订、提取到的约束；最终文章和流式初稿不同时另存一份初稿（旧数据没有这个字段） */
  review?: ArticleReview & { items: Revision[]; requirements: Requirements; draft?: string };
}

/** RPC 跨不了自定义错误类，失败用错误码表示 */
export type SummaryResult = { ok: true; summary: ChapterSummary; cached: boolean } | { ok: false; code: ErrorCode; detail?: string };

const CONTEXT_KEY = 'context';
export const CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 每次生成对应一个 SQLite 存储的 Durable Object。
 * 存储强一致：save() 的 RPC 返回时写入已经落盘（输出闸门会等写入确认），随后的读取一定能看到。
 * 保存时设置 7 天后的 alarm，到期 deleteAll() 清掉上下文和总结。
 */
export class GenerationStore extends DurableObject<Env> {
  /** 正在生成的章节总结。同一章的并发请求共用一个 Promise，只调用一次 Gemini */
  readonly #inflight = new Map<string, Promise<SummaryResult>>();

  async save(context: GenerationContext): Promise<void> {
    await this.ctx.storage.put(CONTEXT_KEY, context);
    await this.ctx.storage.setAlarm(Date.now() + CONTEXT_TTL_MS);
  }

  async load(): Promise<GenerationContext | null> {
    return (await this.ctx.storage.get<GenerationContext>(CONTEXT_KEY)) ?? null;
  }

  async getSummary(chapterId: string): Promise<ChapterSummary | null> {
    return (await this.ctx.storage.get<ChapterSummary>(summaryKey(chapterId))) ?? null;
  }

  /**
   * 返回章节 5W1H：有缓存直接用；同一章已有请求在生成时等它的结果；否则调用 Gemini 生成、校验后存下。
   * 查重和登记之间没有 await，Durable Object 单线程执行，所以不会有两个请求同时判定"没有进行中的任务"。
   */
  summarize(chapterId: string): Promise<SummaryResult> {
    const running = this.#inflight.get(chapterId);
    if (running) return running;
    const task = this.#createSummary(chapterId).finally(() => this.#inflight.delete(chapterId));
    this.#inflight.set(chapterId, task);
    return task;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async #createSummary(chapterId: string): Promise<SummaryResult> {
    try {
      const context = await this.load();
      if (!context) throw new AppError('generation_not_found');
      const chapter = context.article.chapters.find((c) => c.id === chapterId);
      if (!chapter) throw new AppError('chapter_not_found');

      const cached = await this.getSummary(chapterId);
      if (cached) return { ok: true, summary: cached, cached: true };

      const options = geminiOptions(this.env);
      const prompt = summaryPrompt({
        video: context.video,
        transcriptText: context.transcript.text,
        instructions: context.instructions,
        chapterTitles: context.article.chapters.map((c) => c.title),
        chapter,
      });
      // 结构化输出一次返回，没有"已输出一半"的问题：主模型繁忙或超时就在剩余预算内整次改用备用模型
      const { raw, model, stats, ms } = await generateSummaryJson(options, fallbackConfig(this.env), prompt, SUMMARY_SCHEMA, summaryBudget(timeoutScale(this.env)));
      // 记录实际完成总结的模型、用量和服务档，供验收核对
      console.log(
        JSON.stringify({
          event: 'summary',
          chapterId,
          model,
          modelVersion: stats.modelVersion ?? null,
          serviceTier: stats.serviceTierHeader ?? stats.usage?.serviceTier ?? null,
          usage: stats.usage ?? null,
          ms,
        }),
      );
      const summary = normalizeSummary(raw);
      // 上下文已过期被删时不再写入，避免留下没有 alarm 的孤立数据
      if (await this.ctx.storage.get(CONTEXT_KEY)) await this.ctx.storage.put(summaryKey(chapterId), summary);
      return { ok: true, summary, cached: false };
    } catch (err) {
      const error = toAppError(err);
      if (error.code === 'internal') console.error(err);
      return { ok: false, code: error.code, detail: error.detail };
    }
  }
}

function summaryKey(chapterId: string): string {
  return `summary:${chapterId}`;
}

/** 新建一次生成的存储对象；generationId 就是 Durable Object ID 的字符串形式，不可猜测。 */
export function createStore(env: Env): { generationId: string; store: DurableObjectStub<GenerationStore> } {
  const id = env.GENERATIONS.newUniqueId();
  return { generationId: id.toString(), store: env.GENERATIONS.get(id) };
}

export function openStore(env: Env, generationId: string): DurableObjectStub<GenerationStore> {
  if (!/^[0-9a-f]{64}$/.test(generationId)) throw new AppError('generation_not_found');
  try {
    return env.GENERATIONS.get(env.GENERATIONS.idFromString(generationId));
  } catch {
    throw new AppError('generation_not_found');
  }
}
