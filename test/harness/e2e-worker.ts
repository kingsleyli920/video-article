/**
 * 真实启动 Worker（wrangler dev，本地 workerd + SQLite Durable Object），上游指向模拟上游。
 *
 * - 用单独生成的配置和 .dev.vars（假 key），放在 test-results/ 下；工作目录也在那里，
 *   因此不会读到项目根目录的 .env 和 .dev.vars，真实凭据不会进入测试进程，也不会发给模拟上游。
 * - 子进程环境只保留 PATH、HOME 等必要变量，去掉 CLOUDFLARE_* 和 GEMINI_*。
 * - 超时按 TIMEOUT_SCALE 缩短（默认 0.05：5W1H 主模型 2.5 秒、主备合计 4.25 秒；文章首个分块 6 秒），
 *   这样失败、超时和备用切换都能在几秒内测完。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const E2E_TIMEOUT_SCALE = 0.05;

export interface E2EWorkerOptions {
  port: number;
  upstreamUrl: string;
  /** Durable Object 的存储目录；传同一个目录重启，可以验证数据确实落盘 */
  persistDir: string;
  /** 为 true 时先清空存储目录 */
  fresh?: boolean;
}

export interface E2EWorker {
  url: string;
  process: ChildProcess;
  stop(): Promise<void>;
}

export function buildClientIfNeeded(): void {
  if (existsSync(join(ROOT, 'dist/client/app.js'))) return;
  const result = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('前端构建失败');
}

export async function startE2EWorker(options: E2EWorkerOptions): Promise<E2EWorker> {
  const dir = join(ROOT, `test-results/e2e-worker-${options.port}`);
  mkdirSync(dir, { recursive: true });
  if (options.fresh) rmSync(options.persistDir, { recursive: true, force: true });

  // 每个实例用自己的一份静态资源：wrangler dev 监视资源目录，别的测试进程重新构建 dist/client 时会让它中途重载、掐断进行中的请求
  const assetsDir = join(dir, 'assets');
  rmSync(assetsDir, { recursive: true, force: true });
  cpSync(join(ROOT, 'dist/client'), assetsDir, { recursive: true });

  const base = JSON.parse(stripJsonComments(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'))) as Record<string, unknown>;
  const config = {
    name: 'video-article-e2e',
    main: join(ROOT, 'src/worker/index.ts'),
    compatibility_date: base.compatibility_date,
    assets: { directory: assetsDir },
    durable_objects: base.durable_objects,
    migrations: base.migrations,
    vars: {
      ...(base.vars as Record<string, string>),
      GEMINI_MODEL: 'mock-primary',
      GEMINI_FALLBACK_MODEL: 'mock-fallback',
      GEMINI_API_BASE: `${options.upstreamUrl}/gemini`,
      YOUTUBE_PLAYER_URL: `${options.upstreamUrl}/youtube/player`,
      TIMEOUT_SCALE: String(E2E_TIMEOUT_SCALE),
    },
  };
  writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, '.dev.vars'), 'GEMINI_API_KEY=e2e-fake-key\n');

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    WRANGLER_SEND_METRICS: 'false',
    NO_COLOR: '1',
  };
  const child = spawn(
    join(ROOT, 'node_modules/.bin/wrangler'),
    ['dev', '--config', join(dir, 'wrangler.jsonc'), '--port', String(options.port), '--ip', '127.0.0.1', '--persist-to', options.persistDir, '--inspector-port', String(options.port + 1000), '--log-level', 'warn', '--show-interactive-dev-session=false'],
    { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output: string[] = [];
  child.stdout!.on('data', (d: Buffer) => output.push(d.toString()));
  child.stderr!.on('data', (d: Buffer) => output.push(d.toString()));

  const url = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev 退出（${child.exitCode}）：\n${output.join('')}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) break;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (Date.now() >= deadline) {
    child.kill('SIGTERM');
    throw new Error(`wrangler dev 60 秒内没有就绪：\n${output.join('')}`);
  }

  return {
    url,
    process: child,
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      }),
  };
}

/** 去掉 JSONC 的行注释（wrangler.jsonc 里只有行注释，且字符串里没有 //） */
function stripJsonComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}
