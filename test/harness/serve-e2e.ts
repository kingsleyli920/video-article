/**
 * Playwright 用的本地受控环境：模拟上游 + 真实启动的 Worker。由 playwright.config.ts 的 webServer 启动，
 * 收到 SIGTERM/SIGINT 时一并关闭。端口：E2E_WORKER_PORT（默认 8788）、MOCK_UPSTREAM_PORT（默认 8790）。
 */
import { join } from 'node:path';
import { ROOT, startE2EWorker } from './e2e-worker';
import { startMockUpstream } from './mock-upstream';

const workerPort = Number(process.env.E2E_WORKER_PORT ?? 8788);
const upstreamPort = Number(process.env.MOCK_UPSTREAM_PORT ?? 8790);

const upstream = await startMockUpstream(upstreamPort);
const worker = await startE2EWorker({
  port: workerPort,
  upstreamUrl: upstream.url,
  persistDir: join(ROOT, `test-results/e2e-state-${workerPort}`),
  fresh: true,
});
console.log(`受控环境就绪：Worker ${worker.url}，模拟上游 ${upstream.url}`);

const shutdown = async () => {
  await worker.stop();
  await upstream.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
