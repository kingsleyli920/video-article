import { LIMITS } from './limits';

/** 错误码和面向用户的中文说明。服务端返回 code + message，前端直接展示 message。 */
export const ERROR_MESSAGES = {
  invalid_request: '请求格式不正确',
  method_not_allowed: '不支持的请求方法',
  not_found: '接口不存在',
  invalid_url: '请输入有效的 YouTube 视频链接',
  instructions_too_long: `生成要求不能超过 ${LIMITS.instructionsChars} 字`,
  video_unavailable: '视频不存在或无法播放',
  no_captions: '这个视频没有可用的字幕',
  youtube_blocked: 'YouTube 拒绝了字幕请求，可能触发了人机验证',
  youtube_error: '获取字幕失败',
  youtube_timeout: '获取字幕超时，请稍后重试',
  transcript_too_long: '字幕过长，超过支持的上限',
  gemini_quota: 'Gemini 免费额度已用完或请求过于频繁，请稍后再试',
  gemini_busy: 'Gemini 模型繁忙，请稍后重试',
  gemini_billing: 'Gemini 账户的预付额度已用完，暂时无法生成',
  gemini_region: '服务器所在地区不支持 Gemini API',
  gemini_error: '调用 Gemini 失败',
  truncated: '输出达到长度上限，文章不完整',
  blocked: '内容被模型的安全策略拦截，文章不完整',
  interrupted: '生成中断，文章不完整',
  article_too_long: '文章超过长度上限，已停止生成',
  invalid_structure: '文章缺少有效的章节结构，无法提供章节总结',
  save_failed: '保存生成上下文失败，章节总结不可用',
  generation_not_found: '这次生成已过期或不存在，请重新生成',
  chapter_not_found: '找不到这个章节',
  body_not_allowed: '总结请求不接受请求体',
  summary_invalid: '模型返回的总结格式无效，请重试',
  network: '网络连接中断',
  client_timeout: '长时间没有收到服务器的数据，已停止等待',
  cancelled: '已停止生成',
  internal: '服务器内部错误',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;
