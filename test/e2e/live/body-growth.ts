/** 一次采样：[点击"生成文章"后的毫秒数, 页面正文（#article）的字符数] */
export type Sample = readonly [number, number];

export interface BodyGrowth {
  ok: boolean;
  /** 不通过的原因；通过时是空串 */
  reason: string;
  /** 第一次采样时的正文长度（正文还没开始到达时页面上已有的字数，正常是 0） */
  baseLength: number;
  /** 完成后的正文长度 */
  finalLength: number;
  /** 完成前看到中间长度的采样条数 */
  intermediateSamples: number;
}

/**
 * 页面上的正文是不是在完成之前就开始增长了。
 *
 * 判断只看一件事：完成之前，有没有哪次采样看到的是"中间长度"——比开始时多、比完成时少。
 * - 真流式：正文一边到一边画，完成前必然出现过中间长度。长文章会有几十条，短文章哪怕只抓到一条也算。
 * - 等全部生成完再一次贴上去：完成前一直是开始时的长度，然后一步变成完整长度，没有中间长度。
 *   不管这一步发生在完成的那一刻，还是完成前一点点（比如服务端攒到模型结束才一次发出），都判不通过。
 * - 页面上留着旧内容：长度没有增长，或者从旧长度一步跳到新长度，同样没有中间长度。
 *
 * 不要求流式阶段持续多久，也不要求有多少个不同的采样值：高档思考下短文的正文不到半秒就发完。
 * 能不能抓到中间长度取决于采样够不够密，调用方要保证采样间隔明显短于正文的到达时长。
 *
 * @param samples 按时间先后的采样；最后一条必须是完成之后采的
 * @param doneAt 浏览器收到 done 事件的时刻，和采样用同一个时钟
 */
export function bodyGrowth(samples: readonly Sample[], doneAt: number): BodyGrowth {
  const fail = (reason: string, baseLength = 0, finalLength = 0): BodyGrowth => ({ ok: false, reason, baseLength, finalLength, intermediateSamples: 0 });
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return fail('没有采样');
  const [baseLength, finalLength] = [first[1], last[1]];
  if (last[0] < doneAt) return fail(`没有完成之后的采样：最后一次采样在 ${last[0]} ms，完成在 ${doneAt} ms`, baseLength, finalLength);
  if (finalLength <= baseLength) return fail(`正文没有增长：开始时 ${baseLength} 字，完成后 ${finalLength} 字`, baseLength, finalLength);

  const intermediateSamples = samples.filter(([t, length]) => t < doneAt && length > baseLength && length < finalLength).length;
  if (intermediateSamples === 0) {
    return fail(`完成前没有看到中间长度：正文从 ${baseLength} 字一步变成 ${finalLength} 字`, baseLength, finalLength);
  }
  return { ok: true, reason: '', baseLength, finalLength, intermediateSamples };
}

/**
 * 采样很密时，哪些值得留进证据文件：第一条、长度变了的、或者距上一条留下的已经过了 quietMs 的。
 * 等模型思考的几十秒里长度一直是 0，不必每 100 毫秒记一条。
 */
export function worthKeeping(previous: Sample | undefined, next: Sample, quietMs = 1_500): boolean {
  return !previous || next[1] !== previous[1] || next[0] - previous[0] >= quietMs;
}
