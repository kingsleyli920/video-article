import { describe, expect, it } from 'vitest';
import { devVarsContent } from '../../scripts/lib/dev-vars';
import { parseEnvFile } from '../../scripts/lib/env-file';

describe('devVarsContent', () => {
  // 抓：把整份 .env（含 Cloudflare 令牌）复制进 Worker 的本地运行环境
  it('只写入白名单里的应用配置，部署凭据不进入 .dev.vars', () => {
    const env = parseEnvFile(
      ['CLOUDFLARE_ACCOUNT_ID=d5c3', 'CLOUDFLARE_API_TOKEN=cf-secret', 'GEMINI_API_KEY="g-key"', 'GEMINI_MODEL=gemini-3.6-flash', 'GEMINI_FALLBACK_MODEL=gemini-3.5-flash', 'OTHER=x'].join('\n'),
    );
    const { content, keys } = devVarsContent(env);
    expect(keys).toEqual(['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL']);
    expect(content).toBe('# 由 scripts/dev-vars.ts 按白名单从 .env 生成，不要手改，不要提交。\nGEMINI_API_KEY=g-key\nGEMINI_MODEL=gemini-3.6-flash\nGEMINI_FALLBACK_MODEL=gemini-3.5-flash\n');
    expect(content).not.toContain('cf-secret');
    expect(content).not.toContain('CLOUDFLARE');
  });

  it('缺少 GEMINI_API_KEY 时报错', () => {
    expect(() => devVarsContent({ CLOUDFLARE_API_TOKEN: 'x' })).toThrow('.env 里缺少 GEMINI_API_KEY');
  });
});

describe('parseEnvFile', () => {
  it('忽略注释和空行，去掉引号', () => {
    expect(parseEnvFile('# 注释\n\nA=1\nB = "two"\n#C=3\nD=\n')).toEqual({ A: '1', B: 'two', D: '' });
  });
});
