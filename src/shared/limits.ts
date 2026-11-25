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
