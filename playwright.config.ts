import { defineConfig, devices } from '@playwright/test';

// L5 全栈：真实浏览器 + 真实 Worker + 真实 YouTube/Gemini。默认打本地 wrangler dev，E2E_BASE_URL 可指向线上地址。
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 300_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL, locale: 'zh-CN', video: 'on', trace: 'retain-on-failure', viewport: { width: 1280, height: 860 } },
  projects: [{ name: 'fullstack', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'npm run dev -- --port 8787 --ip 127.0.0.1', url: baseURL, reuseExistingServer: true, timeout: 120_000 },
});
