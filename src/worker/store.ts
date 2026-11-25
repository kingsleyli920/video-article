import { DurableObject } from 'cloudflare:workers';
import type { Chapter } from '../shared/article';
import type { ChapterSummary, TranscriptInfo } from '../shared/types';
import { AppError } from './app-error';
import type { VideoMeta } from './youtube';

/** 一次生成的完整上下文，5W1H 只从这里读取，不接收前端提交的内容。 */
export interface GenerationContext {
  version: 1;
  generationId: string;
  createdAt: string;
  model: string;
  video: VideoMeta;
  transcript: TranscriptInfo & { text: string };
  instructions: string;
  article: { title: string; markdown: string; chapters: Chapter[] };
}

const CONTEXT_KEY = 'context';
export const CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 每次生成对应一个 SQLite 存储的 Durable Object。
 * 存储强一致：save() 的 RPC 返回时写入已经落盘（输出闸门会等写入确认），随后的读取一定能看到。
 * 保存时设置 7 天后的 alarm，到期 deleteAll() 清掉上下文和总结。
 */
export class GenerationStore extends DurableObject<Env> {
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

  /** 上下文已过期被删时不再写入，避免留下没有 alarm 的孤立数据。 */
  async saveSummary(chapterId: string, summary: ChapterSummary): Promise<boolean> {
    if (!(await this.ctx.storage.get(CONTEXT_KEY))) return false;
    await this.ctx.storage.put(summaryKey(chapterId), summary);
    return true;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
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
