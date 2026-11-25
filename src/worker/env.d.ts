// 仅供测试使用的变量。生产配置（wrangler.jsonc）不设置它们，部署后检查（npm run cf:deploy-check）会确认线上没有。
// 本地 E2E 用它们把 YouTube 和 Gemini 指向模拟上游，并按比例缩短超时。
interface TestOnlyEnv {
  /** Gemini API 的模型地址前缀，默认 https://generativelanguage.googleapis.com/v1beta/models */
  GEMINI_API_BASE?: string;
  /** YouTube 播放器接口地址 */
  YOUTUBE_PLAYER_URL?: string;
  /** 模型、字幕和 5W1H 预算的超时倍率，0 到 1 之间，默认 1 */
  TIMEOUT_SCALE?: string;
}
interface Env extends TestOnlyEnv {}
declare namespace Cloudflare {
  interface Env extends TestOnlyEnv {}
}
