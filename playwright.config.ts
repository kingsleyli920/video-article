import { defineConfig, devices } from '@playwright/test';

// Playwright 分层（沿用 cert-admin-console）：
// - web-mock（L2 前端 E2E）：真实浏览器，后端响应全部用 page.route 控制。
// - fullstack（L5 全栈，受控上游）：真实浏览器 + 真实启动的 Worker 和 Durable Object 存储，YouTube/Gemini 换成模拟上游。
// - visual-desktop / visual-mobile（L5 视觉）：关键界面状态的截图比对，桌面 1280×860 和手机（iPhone 13 尺寸，Chromium 模拟）。
// - live（L5 全栈，真实上游）：真实 YouTube 和 Gemini，会消耗额度；E2E_BASE_URL 指向线上地址，不设时打本地 npm run dev（8787）。
// 前四个项目共用 webServer 启动的受控环境：模拟上游（MOCK_UPSTREAM_PORT，默认 8790）+ wrangler dev（E2E_WORKER_PORT，默认 8788）。
const workerPort = Number(process.env.E2E_WORKER_PORT ?? 8788);
const upstreamPort = Number(process.env.MOCK_UPSTREAM_PORT ?? 8790);
const local = `http://127.0.0.1:${workerPort}`;
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } };
const mobile = { ...devices['iPhone 13'], defaultBrowserType: 'chromium' as const };

export default defineConfig({
  testDir: 'test/e2e',
  // 多个 Playwright 同时跑（不同端口）时用 PW_OUTPUT_DIR 分开输出目录，避免互相清空
  outputDir: process.env.PW_OUTPUT_DIR ?? 'test-results/playwright',
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.PW_REPORT_DIR ?? 'test-results/playwright-report' }]],
  // 同一台机器上渲染是逐像素稳定的；按比例放宽会漏掉状态条里改几个字这类变化，所以只容忍极少量像素差异
  expect: { toHaveScreenshot: { maxDiffPixels: 20, animations: 'disabled', caret: 'hide' } },
  use: { locale: 'zh-CN', timezoneId: 'Asia/Shanghai', video: 'on', trace: 'retain-on-failure' },
  projects: [
    { name: 'web-mock', testDir: 'test/e2e/web-mock', timeout: 60_000, use: { ...desktop, baseURL: local } },
    { name: 'fullstack', testDir: 'test/e2e/fullstack', timeout: 90_000, use: { ...desktop, baseURL: local } },
    { name: 'visual-desktop', testDir: 'test/e2e/visual', timeout: 60_000, use: { ...desktop, baseURL: local, video: 'off' } },
    { name: 'visual-mobile', testDir: 'test/e2e/visual', timeout: 60_000, use: { ...mobile, baseURL: local, video: 'off' } },
    { name: 'live', testDir: 'test/e2e/live', timeout: 300_000, use: { ...desktop, baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787' } },
  ],
  webServer: {
    command: 'npm run build && tsx test/harness/serve-e2e.ts',
    url: local,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { E2E_WORKER_PORT: String(workerPort), MOCK_UPSTREAM_PORT: String(upstreamPort) },
  },
});
