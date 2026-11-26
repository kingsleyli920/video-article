/** 一次采样：[点击"生成文章"后的毫秒数, 页面上文章正文的字符数（标题、导语、各章标题和正文；不含核对记录、提示和按钮）] */
export type Sample = readonly [number, number];

/** 页面上只算文章正文的选择器：核对记录（.article-review）、提示、5W1H 按钮和面板都不在内 */
export const BODY_SELECTOR = '#article > h1, #article > .article-intro, #article .chapter-heading h2, #article .chapter-body';

export interface BodyGrowth {
  ok: boolean;
  /** 不通过的原因；通过时是空串 */
  reason: string;
  /** 第一次采样时的正文长度（正文还没开始到达时页面上已有的字数，正常是 0） */
  baseLength: number;
  /** 初稿写完时的正文长度 */
  draftLength: number;
  /** 初稿写完之前看到中间长度的采样条数 */
  intermediateSamples: number;
  /** 初稿写完之前看到过多少种不同的中间长度 */
  distinctLengths: number;
}

/**
 * 页面上的正文是不是在初稿生成阶段就陆续增长。
 *
 * 判断只看初稿生成阶段，也就是浏览器收到"修订/核对"阶段事件（没有这两个阶段时是 done）之前：
 * 这段时间里有没有哪次采样看到的是"中间长度"——比开始时多、比初稿写完时少。
 * 之后页面还会变（核对后的最终文章替换初稿、多出核对记录），那些变化与流式无关，不能算作增长：
 * 否则"整篇初稿一次贴出，核对完又多出一块核对记录"也会被当成持续增长。
 * - 真流式：正文一边到一边画，初稿写完前必然出现过中间长度。长文章会有几十条，短文章哪怕只抓到一条也算。
 * - 等全部生成完再一次贴上去：初稿写完前一直是开始时的长度，然后一步变成完整长度，没有中间长度。
 * - 页面上留着旧内容：长度没有增长，或者从旧长度一步跳到新长度，同样没有中间长度。
 *
 * 不要求流式阶段持续多久，也不要求有多少个不同的采样值：高档思考下短文的正文不到半秒就发完。
 * 能不能抓到中间长度取决于采样够不够密，调用方要保证采样间隔明显短于正文的到达时长。
 *
 * @param samples 按时间先后的采样，量的是正文（BODY_SELECTOR），最后一条必须在初稿写完之后
 * @param draftEndAt 浏览器收到第一个 revising/reviewing 阶段事件的时刻（都没有时用 done 的时刻），和采样用同一个时钟
 */
export function bodyGrowth(samples: readonly Sample[], draftEndAt: number): BodyGrowth {
  const fail = (reason: string, baseLength = 0, draftLength = 0): BodyGrowth => ({ ok: false, reason, baseLength, draftLength, intermediateSamples: 0, distinctLengths: 0 });
  const first = samples[0];
  const settled = samples.find(([t]) => t >= draftEndAt);
  if (!first) return fail('没有采样');
  const baseLength = first[1];
  if (!settled) return fail(`没有初稿写完之后的采样：最后一次采样在 ${samples.at(-1)![0]} ms，初稿写完在 ${draftEndAt} ms`, baseLength, samples.at(-1)![1]);
  const draftLength = settled[1];
  if (draftLength <= baseLength) return fail(`正文没有增长：开始时 ${baseLength} 字，初稿写完时 ${draftLength} 字`, baseLength, draftLength);

  const intermediate = samples.filter(([t, length]) => t < draftEndAt && length > baseLength && length < draftLength);
  if (intermediate.length === 0) {
    return fail(`初稿写完前没有看到中间长度：正文从 ${baseLength} 字一步变成 ${draftLength} 字`, baseLength, draftLength);
  }
  return { ok: true, reason: '', baseLength, draftLength, intermediateSamples: intermediate.length, distinctLengths: new Set(intermediate.map(([, length]) => length)).size };
}

/**
 * 采样很密时，哪些值得留进证据文件：第一条、长度变了的、或者距上一条留下的已经过了 quietMs 的。
 * 等模型思考的几十秒里长度一直是 0，不必每 100 毫秒记一条。
 */
export function worthKeeping(previous: Sample | undefined, next: Sample, quietMs = 1_500): boolean {
  return !previous || next[1] !== previous[1] || next[0] - previous[0] >= quietMs;
}
