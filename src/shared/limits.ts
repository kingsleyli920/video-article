/** 输入、字幕和生成内容的大小上限。前后端共用，超限时给出明确提示。 */
export const LIMITS = {
  /** 生成请求体（JSON）上限 */
  requestBodyBytes: 8_192,
  urlChars: 2_048,
  instructionsChars: 1_000,
  /** 整理后的字幕正文上限，约 4 小时英文对话 */
  transcriptChars: 300_000,
  /** 生成文章上限，远高于正常输出，用来兜住异常的长输出 */
  articleChars: 100_000,
} as const;

/**
 * 5W1H 的等待时间，前后端共用一份，保证两边协调：
 * - 前端整体等 clientMs；
 * - 服务端主模型最多 primaryMs，主备模型合计不超过 serverBudgetMs（比前端短 15 秒，留给网络和 Durable Object 往返），
 *   这样前端总能收到服务端给出的结果或明确错误，而不是自己先超时；
 * - 主模型失败后剩余预算不足 minFallbackMs 时不再换备用模型，直接报繁忙。
 */
export const SUMMARY_TIMING = { clientMs: 100_000, serverBudgetMs: 85_000, primaryMs: 50_000, minFallbackMs: 15_000 } as const;

/**
 * 文章写完之后的核对阶段，都在同一条生成连接里进行（服务端每 15 秒发心跳，前端整次生成的上限是 10 分钟）：
 * - REVIEW_TIMING：按章核对字幕，各章并行，每一章主模型最多 primaryMs，主备合计 serverBudgetMs。
 *   高档思考实测每章 34 到 67 秒，所以给到 150 秒。
 * - REQUIREMENTS_TIMING：从用户要求里提取可计算的约束，低档思考，一般几秒。
 * - maxUnits：核对请求的总并行上限；预留一个整篇语义限定复核，其余用于按章核对，章节更多时相邻合并。
 */
export const REVIEW_TIMING = { serverBudgetMs: 210_000, primaryMs: 150_000, minFallbackMs: 20_000, maxUnits: 6 } as const;
export const REQUIREMENTS_TIMING = { serverBudgetMs: 50_000, primaryMs: 30_000, minFallbackMs: 10_000 } as const;
