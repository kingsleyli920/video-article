/**
 * L3 后端 E2E 的测试环境：每个测试文件在 beforeAll 里启动一套"模拟上游 + 真实 wrangler dev"，afterAll 关闭。
 * 测试只经 HTTP 入口（Worker 的公开接口）操作，用模拟上游的管理接口设置场景、读取上游实际收到的请求。
 */
import { join } from 'node:path';
import { ROOT, buildClientIfNeeded, startE2EWorker, type E2EWorker } from '../harness/e2e-worker';
import { startMockUpstream, type MockUpstream, type RecordedRequest, type Scenario } from '../harness/mock-upstream';

export interface Stack {
  /** Worker 地址，如 http://127.0.0.1:8798 */
  url: string;
  upstreamUrl: string;
  /** 整体替换模拟上游的场景（没给的部分用默认值） */
  scenario(s: Partial<Scenario>): Promise<void>;
  /** 恢复默认场景并清空请求记录 */
  reset(): Promise<void>;
  /** 模拟上游收到的请求 */
  requests(): Promise<RecordedRequest[]>;
  /** 用同一个存储目录重启 Worker，验证数据确实落盘 */
  restartWorker(): Promise<void>;
  stop(): Promise<void>;
}

export async function startStack(ports: { worker: number; upstream: number }): Promise<Stack> {
  buildClientIfNeeded();
  const upstream: MockUpstream = await startMockUpstream(ports.upstream);
  const persistDir = join(ROOT, `test-results/e2e-state-${ports.worker}`);
  let worker: E2EWorker = await startE2EWorker({ port: ports.worker, upstreamUrl: upstream.url, persistDir, fresh: true });
  const admin = (path: string, init?: RequestInit) => fetch(`${upstream.url}${path}`, init);
  return {
    url: worker.url,
    upstreamUrl: upstream.url,
    async scenario(s) {
      await admin('/__scenario', { method: 'PUT', body: JSON.stringify(s) });
    },
    async reset() {
      await admin('/__reset', { method: 'POST' });
    },
    async requests() {
      return (await (await admin('/__requests')).json()) as RecordedRequest[];
    },
    async restartWorker() {
      await worker.stop();
      worker = await startE2EWorker({ port: ports.worker, upstreamUrl: upstream.url, persistDir });
    },
    async stop() {
      await worker.stop();
      await upstream.close();
    },
  };
}
