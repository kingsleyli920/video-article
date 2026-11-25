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
