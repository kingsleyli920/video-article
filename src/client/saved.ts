import type { Revision, StreamEvents } from '../shared/types';
import type { SourceMeta } from './source-panel';

/**
 * 刷新页面后的恢复，只用浏览器本地存储，不涉及服务端：
 * - 最近一次生成完成的文章：刷新后原样恢复，5W1H 仍然用服务端保存的那次生成（服务端保留 7 天，这里也只留 7 天）；
 * - 正在进行的生成：只记下输入。刷新会断开连接，服务端随之停止、不保存，所以恢复不了正文，
 *   只能把链接和要求填回去并说明上次被中断。
 * 本地存储不可用（隐私模式、被禁用、写满）时这些功能静默失效，不影响正常使用。
 */
export interface GenerationInput {
  url: string;
  instructions: string;
}

export interface SavedArticle {
  version: 1;
  savedAt: number;
  input: GenerationInput;
  generationId: string;
  markdown: string;
  meta: SourceMeta | null;
  done: StreamEvents['done'];
  revisions: Revision[];
}

const ARTICLE_KEY = 'video-article:last-article';
const PENDING_KEY = 'video-article:pending-input';
/** 和服务端保存上下文的期限一致，过期后 5W1H 已不可用，不再恢复 */
export const SAVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 本地存储不可用：放弃保存
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上
  }
}

const isInput = (value: unknown): value is GenerationInput =>
  !!value && typeof value === 'object' && typeof (value as GenerationInput).url === 'string' && typeof (value as GenerationInput).instructions === 'string';

export function saveArticle(article: Omit<SavedArticle, 'version' | 'savedAt'>, now = Date.now()): void {
  write(ARTICLE_KEY, { version: 1, savedAt: now, ...article } satisfies SavedArticle);
}

/** 读取上次完成的文章；格式不对或已过期时清掉并返回 null */
export function loadArticle(now = Date.now()): SavedArticle | null {
  const value = read(ARTICLE_KEY) as Partial<SavedArticle> | null;
  const ok =
    !!value &&
    typeof value === 'object' &&
    value.version === 1 &&
    typeof value.savedAt === 'number' &&
    now - value.savedAt < SAVED_TTL_MS &&
    isInput(value.input) &&
    typeof value.generationId === 'string' &&
    value.generationId !== '' &&
    typeof value.markdown === 'string' &&
    value.markdown !== '' &&
    !!value.done &&
    Array.isArray(value.done.chapters) &&
    typeof value.done.chars === 'number' &&
    Array.isArray(value.revisions);
  if (!ok) {
    if (value !== null) remove(ARTICLE_KEY);
    return null;
  }
  return value as SavedArticle;
}

export function clearArticle(): void {
  remove(ARTICLE_KEY);
}

/** 开始生成时记下输入；生成结束（完成、失败、停止）时清掉。刷新后还在，说明上次生成被刷新或关闭打断了 */
export function markPending(input: GenerationInput): void {
  write(PENDING_KEY, input);
}

export function clearPending(): void {
  remove(PENDING_KEY);
}

/** 取出并清掉被打断的那次生成的输入；没有时返回 null */
export function takePending(): GenerationInput | null {
  const value = read(PENDING_KEY);
  remove(PENDING_KEY);
  return isInput(value) ? value : null;
}
