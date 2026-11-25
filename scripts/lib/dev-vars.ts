/**
 * 本地 Worker 运行环境只拿这几项。Cloudflare 令牌等部署凭据不在白名单里，不会进入 .dev.vars。
 */
export const DEV_VARS_ALLOWLIST = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL', 'GEMINI_THINKING_LEVEL'] as const;

export function devVarsContent(env: Record<string, string | undefined>): { content: string; keys: string[] } {
  if (!env.GEMINI_API_KEY) throw new Error('.env 里缺少 GEMINI_API_KEY');
  const keys = DEV_VARS_ALLOWLIST.filter((key) => env[key]);
  const lines = keys.map((key) => `${key}=${env[key]}`);
  return {
    content: `# 由 scripts/dev-vars.ts 按白名单从 .env 生成，不要手改，不要提交。\n${lines.join('\n')}\n`,
    keys,
  };
}
