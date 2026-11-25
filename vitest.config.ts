import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// 分层沿用 cert-admin-console：
// L1a 后端单测（node）、L1b 后端功能测试（Workers 运行时 + SQLite DO，出站请求全部替身）、
// L1c 前端单测（jsdom，DOMPurify 在 happy-dom 下清洗结果不可靠）、L1d 前端功能测试（jsdom 里加载真实页面和 main.ts，网络受控）、
// L3 后端 E2E（真实启动 wrangler dev，上游指向模拟上游，只经 HTTP 入口）。
export default defineConfig({
  test: {
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/worker/transcripts/**'],
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'test-results/coverage',
    },
    projects: [
      { test: { name: 'be-unit', include: ['test/be-unit/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'fe-unit', include: ['test/fe-unit/**/*.test.ts'], environment: 'jsdom' } },
      { test: { name: 'fe-ft', include: ['test/fe-ft/**/*.test.ts'], environment: 'jsdom' } },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // 测试一律用假 key 和固定模型；出站请求全部被测试里的 fetch 替身拦截
            miniflare: { bindings: { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'test-model', GEMINI_FALLBACK_MODEL: 'test-fallback', GEMINI_THINKING_LEVEL: 'high', GEMINI_FALLBACK_THINKING_LEVEL: 'low' } },
          }),
        ],
        test: { name: 'be-ft', include: ['test/be-ft/**/*.test.ts'] },
      },
      {
        test: {
          name: 'be-e2e',
          include: ['test/be-e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
