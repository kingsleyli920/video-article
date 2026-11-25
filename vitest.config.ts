import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// 分层沿用 cert-admin-console：L1a 后端单测（node）、L1b 后端功能测试（Workers 运行时）、L1c 前端单测（jsdom，DOMPurify 在 happy-dom 下清洗结果不可靠）
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'be-unit', include: ['test/be-unit/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'fe-unit', include: ['test/fe-unit/**/*.test.ts'], environment: 'jsdom' } },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // 测试一律用假 key 和固定模型；出站请求全部被测试里的 fetch 替身拦截
            miniflare: { bindings: { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'test-model', GEMINI_FALLBACK_MODEL: 'test-fallback', GEMINI_THINKING_LEVEL: 'low' } },
          }),
        ],
        test: { name: 'be-ft', include: ['test/be-ft/**/*.test.ts'] },
      },
    ],
  },
});
