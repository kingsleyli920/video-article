/**
 * 已存字幕的隔离内容复验。正常 /api 请求直接进入生产 Worker；只有 YouTube 被已存字幕替代。
 *
 * tsx scripts/revalidate-content.ts V13 --source-project /path/to/project --out /new/output --live
 * --smoke：Gemini 也用本地替身，不读取真实凭据；用于验证整个入口，不是内容验收。
 *
 * 实际 Gemini key 只留在本进程内，由代理发给固定官方地址。Worker 只拿随机本地令牌，
 * 临时配置和数据库退出时删除；正式证据不含请求头。已有输出目录一律拒绝覆盖。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { prepareTranscript, type VideoMeta } from '../src/worker/youtube';
import { startMockUpstream, type MockUpstream } from '../test/harness/mock-upstream';
import { geminiPurpose, NO_REQUIREMENTS_JSON } from '../test/fixtures/upstream';
import { readEnvFile } from './lib/env-file';

const ROOT = resolve(import.meta.dirname, '..');
const OFFICIAL_GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const SOURCE_WORKTREE = '.claude/worktrees/continue-previous-work-90e737';
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const jsonFile = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

interface Options { caseId: string; sourceProject: string; out: string; smoke: boolean; port?: number }
interface Preflight {
  id: string; title: string; channel: string; description?: string; lengthSeconds: number;
  preparedSha256: string; selected: { language: string; kind: string; trackName: string; vssId: string };
}
interface ModelRequest {
  startedAt: string; model: string; purpose: string; requestBody: unknown; requestBodySha256: string;
  transcriptSha256: string | null; transcriptMatches: boolean | null;
  status: number | null; responseBase64: string; ms: number | null; aborted: boolean; error: string | null;
}
interface Timeline { outcome: string; meta?: { generationId: string }; done?: unknown; failure?: unknown; probeError?: string }
interface SavedContext {
  generationId: string;
  article: { markdown: string };
  transcript: { text: string };
  review?: { draft?: string };
}

function options(): Options {
  const args = process.argv.slice(2);
  const take = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少值`);
    args.splice(index, 2);
    return value;
  };
  const sourceProject = take('--source-project');
  const out = take('--out');
  const port = take('--port');
  const smokeIndex = args.indexOf('--smoke');
  const smoke = smokeIndex >= 0;
  if (smoke) args.splice(smokeIndex, 1);
  const liveIndex = args.indexOf('--live');
  const live = liveIndex >= 0;
  if (live) args.splice(liveIndex, 1);
  const caseId = args[0];
  if (!caseId || args.length !== 1 || !sourceProject || !out || !/^V\d+$/.test(caseId) || live === smoke) {
    throw new Error('用法：tsx scripts/revalidate-content.ts V13 --source-project <注册源根目录> --out <新目录> (--smoke | --live) [--port <本地端口>]');
  }
  if (port && (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 64535)) throw new Error('端口须在 1024–64535 之间');
  return { caseId, sourceProject: resolve(sourceProject), out: resolve(out), smoke, ...(port ? { port: Number(port) } : {}) };
}

function sourceHashes(sourceRoot: string): Record<string, string> {
  const files = ['wrangler.jsonc', 'scripts/stream-probe.ts', 'scripts/revalidate-content.ts', 'scripts/lib/env-file.ts', 'test/harness/mock-upstream.ts', 'test/fixtures/upstream.ts'];
  const visit = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit('src/worker');
  visit('src/shared');
  return Object.fromEntries(files.sort().map((path) => {
    const bytes = readFileSync(join(ROOT, path));
    if (!existsSync(join(sourceRoot, path)) || sha(bytes) !== sha(readFileSync(join(sourceRoot, path)))) {
      throw new Error(`私有与源工作树不一致：${path}，先同步入口及实现再复验`);
    }
    return [path, sha(bytes)];
  }));
}

function progress(message: string) {
  console.log(message);
  if (process.env.BEANEST_PROGRESS_FILE) {
    try { appendFileSync(process.env.BEANEST_PROGRESS_FILE, message + '\n'); } catch { /* 进度文件失败不改变执行结果 */ }
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('未取得本地端口');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function cleanEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1',
  };
}

async function stop(child: ChildProcess | undefined) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timeout); }
}

async function runProbe(base: string, input: { url: string; instructions: string }, out: string, log: (text: string) => void, register: (child: ChildProcess) => void) {
  const child = spawn(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'scripts/stream-probe.ts'), base, input.url, input.instructions, '--out', out, '--idle', '240'], {
    cwd: ROOT, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  register(child);
  child.stdout!.on('data', (data: Buffer) => log(data.toString()));
  child.stderr!.on('data', (data: Buffer) => log(data.toString()));
  const result = await once(child, 'exit');
  if (result[0] !== 0) throw new Error(`流式探针退出码 ${String(result[0])}`);
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function writeChunk(res: ServerResponse, chunk: Uint8Array) {
  if (res.destroyed) throw new Error('下游连接已关闭');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      res.removeListener('close', closed);
      res.removeListener('error', failed);
      if (error) reject(error); else resolve();
    };
    const closed = () => finish(new Error('下游连接已关闭'));
    const failed = (error: Error) => finish(error);
    res.once('close', closed);
    res.once('error', failed);
    res.write(chunk, finish);
  });
}

async function main(opts: Options) {
  const sourceRoot = join(opts.sourceProject, SOURCE_WORKTREE);
  const hashes = sourceHashes(sourceRoot);
  const originalDir = join(opts.sourceProject, 'evidence/final2/online-cases-2', opts.caseId);
  const inputPath = join(originalDir, 'input.json');
  const inputBytes = readFileSync(inputPath);
  const input = JSON.parse(inputBytes.toString('utf8')) as { url: string; instructions: string };
  const videoId = new URL(input.url).searchParams.get('v');
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('原始案例URL缺少有效视频ID');
  const preflightDir = join(opts.sourceProject, 'evidence/additional/preflight', videoId);
  const preflightBytes = readFileSync(join(preflightDir, 'preflight.json'));
  const rawCuesBytes = readFileSync(join(preflightDir, 'raw-cues.json'));
  const preparedBytes = readFileSync(join(preflightDir, 'prepared.txt'));
  const preflight = JSON.parse(preflightBytes.toString('utf8')) as Preflight;
  const rawCues = JSON.parse(rawCuesBytes.toString('utf8')) as [number, string][];
  const prepared = preparedBytes.toString('utf8');
  const inputFiles: [string, Buffer][] = [
    [inputPath, inputBytes], [join(preflightDir, 'preflight.json'), preflightBytes],
    [join(preflightDir, 'raw-cues.json'), rawCuesBytes], [join(preflightDir, 'prepared.txt'), preparedBytes],
  ];
  const inputHashes = Object.fromEntries(inputFiles.map(([path, bytes]) => [relative(opts.sourceProject, path), sha(bytes)]));
  if (preflight.id !== videoId || sha(prepared) !== preflight.preparedSha256) throw new Error('预检字幕版本不匹配');
  if (prepareTranscript(rawCues.map(([start, text]) => ({ start, text }))).text !== prepared) throw new Error('当前生产字幕整理结果与prepared.txt不一致');
  const video: VideoMeta = { id: videoId, title: preflight.title, channel: preflight.channel, description: preflight.description ?? '', lengthSeconds: preflight.lengthSeconds };
  const config = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').split('\n').map((line) => line.replace(/^\s*\/\/.*$/, '')).join('\n')) as {
    compatibility_date: string; durable_objects: unknown; migrations: unknown; vars: Record<string, string>;
  };
  // 正式模式不接受代理或线上Worker地址，真实凭据只能发到固定Google官方域名。
  if (config.vars.GEMINI_API_BASE && config.vars.GEMINI_API_BASE !== OFFICIAL_GEMINI) throw new Error('生产配置的Gemini地址不是当前支持的官方地址');
  const key = opts.smoke ? '' : readEnvFile(join(sourceRoot, '.env')).GEMINI_API_KEY;
  if (!opts.smoke && !key) throw new Error('源最新工作树.env缺少GEMINI_API_KEY');
  if (existsSync(opts.out)) throw new Error('输出目录已存在；请用新目录保留每轮原始产物');
  mkdirSync(opts.out, { recursive: true });
  const log = (text: string) => { appendFileSync(join(opts.out, 'run.log'), redact(text)); };
  const redact = (text: string) => key ? text.split(key).join('[REDACTED]') : text;
  const startedAt = new Date().toISOString();
  const temporary = mkdtempSync(join(tmpdir(), 'video-article-content-'));
  const localToken = randomBytes(24).toString('hex');
  const requests: ModelRequest[] = [];
  const active = new Set<AbortController>();
  let mock: MockUpstream | undefined;
  let worker: ChildProcess | undefined;
  let probe: ChildProcess | undefined;
  let saved: SavedContext | null = null;
  let success = false;
  let error: string | null = null;
  let wrapperSha = '';
  const port = opts.port ?? await unusedPort();
  const inspectorPort = await unusedPort();
  const pending = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const operation = handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: redact(String(err)) }));
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  let proxyBase = '';
  const signal = () => { void stop(probe); void stop(worker); for (const controller of active) controller.abort(); };
  process.once('SIGTERM', signal);
  process.once('SIGINT', signal);
  const heartbeat = setInterval(() => progress(`${opts.caseId} ${opts.smoke ? '本地烟测' : '真实模型复验'}进行中，已收到 ${requests.length} 个模型请求`), 30_000);
  heartbeat.unref();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', proxyBase);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    // 字幕路由拒绝Gemini令牌，不将任何请求头转发给字幕替身。
    if (url.pathname.startsWith('/youtube/')) {
      if (req.headers['x-goog-api-key'] || req.headers.authorization) throw new Error('字幕请求意外携带模型凭据');
      if (url.pathname === '/youtube/player' && JSON.parse(rawBody).videoId === videoId) {
        res.setHeader('content-type', 'application/json');
        return void res.end(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          videoDetails: { title: video.title, author: video.channel, shortDescription: video.description, lengthSeconds: String(video.lengthSeconds) },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
            baseUrl: `${proxyBase}/youtube/timedtext?v=${videoId}`, languageCode: preflight.selected.language,
            ...(preflight.selected.kind === 'asr' ? { kind: 'asr' } : {}), vssId: preflight.selected.vssId,
            name: { simpleText: preflight.selected.trackName },
          }] } },
        }));
      }
      if (url.pathname === '/youtube/timedtext' && url.searchParams.get('v') === videoId) {
        res.setHeader('content-type', 'text/xml; charset=utf-8');
        return void res.end(`<?xml version="1.0"?><transcript>${rawCues.map(([ms, text]) => `<text start="${ms / 1000}" dur="0">${escapeXml(escapeXml(text))}</text>`).join('')}</transcript>`);
      }
      res.writeHead(404); return void res.end();
    }
    const route = /^\/gemini\/([^/:]+):(streamGenerateContent|generateContent)$/.exec(url.pathname);
    if (!route || req.method !== 'POST' || req.headers['x-goog-api-key'] !== localToken) { res.writeHead(403); return void res.end(); }
    const model = decodeURIComponent(route[1]!);
    if (![config.vars.GEMINI_MODEL, config.vars.GEMINI_FALLBACK_MODEL].includes(model)) throw new Error('请求了未配置的模型');
    const body = JSON.parse(rawBody) as { contents?: { parts?: { text?: string }[] }[] };
    const purpose = geminiPurpose(url.pathname, body);
    const text = body.contents?.flatMap((entry) => entry.parts?.map((part) => part.text ?? '') ?? []).join('\n') ?? '';
    const transcript = /<transcript>\n([\s\S]*?)\n<\/transcript>/.exec(text)?.[1];
    const needsTranscript = ['article', 'rewrite', 'review'].includes(purpose);
    const record: ModelRequest = {
      startedAt: new Date().toISOString(), model, purpose, requestBody: body, requestBodySha256: sha(rawBody),
      transcriptSha256: transcript === undefined ? null : sha(transcript), transcriptMatches: needsTranscript ? transcript === prepared : null,
      status: null, responseBase64: '', ms: null, aborted: false, error: null,
    };
    requests.push(record);
    if (purpose === 'summary') throw new Error('内容复验不应调用5W1H');
    if (needsTranscript && !record.transcriptMatches) throw new Error('实际模型请求的字幕与prepared.txt不一致，已阻止转发');
    const controller = new AbortController();
    active.add(controller);
    const began = performance.now();
    const responseChunks: Buffer[] = [];
    res.on('close', () => { if (!res.writableFinished) { record.aborted = true; controller.abort(); } });
    try {
      const target = opts.smoke ? `${mock!.url}${url.pathname}${url.search}` : `${OFFICIAL_GEMINI}/${encodeURIComponent(model)}:${route[2]}${url.search}`;
      const upstream = await fetch(target, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(opts.smoke ? {} : { 'x-goog-api-key': key! }) },
        body: rawBody, signal: controller.signal, redirect: 'error',
      });
      record.status = upstream.status;
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          responseChunks.push(Buffer.from(chunk));
          await writeChunk(res, chunk);
        }
      }
      res.end();
    } catch (err) {
      record.error = redact(String(err));
      if (!record.aborted) throw err;
    } finally {
      record.responseBase64 = Buffer.concat(responseChunks).toString('base64');
      record.ms = Math.round(performance.now() - began);
      active.delete(controller);
    }
  }

  try {
    if (opts.smoke) {
      mock = await startMockUpstream(await unusedPort());
      const article = '# 复验入口烟测\n\n## 第一章：框架\n\n这是一篇只用于入口检查的模拟文章。\n\n## 第二章：依据\n\n模型响应来自本地替身。\n\n## 第三章：边界\n\n此结果不用于内容验收。';
      const models = [config.vars.GEMINI_MODEL, config.vars.GEMINI_FALLBACK_MODEL].filter((value): value is string => !!value);
      await fetch(`${mock.url}/__scenario`, { method: 'PUT', body: JSON.stringify({
        streams: Object.fromEntries(models.map((model) => [model, { kind: 'ok', texts: [article] }])),
        requirements: Object.fromEntries(models.map((model) => [model, { kind: 'ok', result: NO_REQUIREMENTS_JSON }])),
        reviews: Object.fromEntries(models.map((model) => [model, { kind: 'ok', issues: [] }])),
      }) });
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('代理没有本地地址');
    proxyBase = `http://127.0.0.1:${address.port}`;
    const entry = join(temporary, 'worker.ts');
    const index = join(ROOT, 'src/worker/index.ts');
    const wrapper = `import app, { GenerationStore, TranscriptRelay } from ${JSON.stringify(index)};\nexport { GenerationStore, TranscriptRelay };\nexport default { async fetch(request, env, ctx) { const p = new URL(request.url).pathname; if (p === '/__ready') return new Response('ready'); const m = /^\\/__evidence\\/([0-9a-f]{64})$/.exec(p); if (m && request.method === 'GET') return Response.json(await env.GENERATIONS.get(env.GENERATIONS.idFromString(m[1])).load()); return app.fetch(request, env, ctx); } };\n`;
    wrapperSha = sha(wrapper);
    writeFileSync(entry, wrapper);
    save(join(temporary, 'wrangler.jsonc'), {
      name: 'video-article-content-local', main: entry, compatibility_date: config.compatibility_date,
      durable_objects: config.durable_objects, migrations: config.migrations,
      vars: { ...config.vars, GEMINI_API_BASE: `${proxyBase}/gemini`, YOUTUBE_PLAYER_URL: `${proxyBase}/youtube/player` },
    });
    writeFileSync(join(temporary, '.dev.vars'), `GEMINI_API_KEY=${localToken}\n`, { mode: 0o600 });
    worker = spawn(join(ROOT, 'node_modules/.bin/wrangler'), ['dev', '--config', join(temporary, 'wrangler.jsonc'), '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspectorPort), '--persist-to', join(temporary, 'storage'), '--log-level', 'warn', '--show-interactive-dev-session=false'], {
      cwd: temporary, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    worker.stdout!.on('data', (data: Buffer) => log(data.toString()));
    worker.stderr!.on('data', (data: Buffer) => log(data.toString()));
    worker.on('error', (err) => log(redact(String(err)) + '\n'));
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (worker.exitCode !== null) throw new Error(`本地Worker提前退出：${worker.exitCode}`);
      try { ready = (await fetch(`${base}/__ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* 等待本地启动 */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('本地Worker未能在60秒内就绪');
    progress(`${opts.caseId} 本地Worker就绪，字幕版本已核对；${opts.smoke ? '全部模型请求使用替身' : '开始真实模型流程'}`);
    await runProbe(base, input, opts.out, log, (child) => { probe = child; });
    const timeline = jsonFile<Timeline>(join(opts.out, 'timeline.json'));
    if (timeline.outcome !== 'done' || timeline.failure || timeline.probeError) throw new Error(`生成未成功结束：${timeline.outcome}`);
    const generationId = timeline.meta?.generationId;
    if (!generationId || !/^[0-9a-f]{64}$/.test(generationId)) throw new Error('结果缺少有效generationId');
    const response = await fetch(`${base}/__evidence/${generationId}`);
    if (!response.ok) throw new Error('本地保存上下文读取失败');
    saved = await response.json() as SavedContext;
    if (!saved || saved.generationId !== generationId || saved.article.markdown !== readFileSync(join(opts.out, 'article.md'), 'utf8') || saved.transcript.text !== prepared) throw new Error('本地保存内容与最终SSE或原字幕不一致');
    for (const purpose of ['article', 'review', 'requirements']) if (!requests.some((record) => record.purpose === purpose)) throw new Error(`未观察到${purpose}模型请求`);
    if (requests.some((record) => record.transcriptMatches === false)) throw new Error('实际请求存在字幕不匹配');
    // 对运行前后再绑定一次，避免模型生成期间源码或字幕发生变化而误记版本。
    if (JSON.stringify(sourceHashes(sourceRoot)) !== JSON.stringify(hashes)) throw new Error('运行期间实现发生变化');
    for (const [path, hash] of Object.entries(inputHashes)) {
      if (!existsSync(join(opts.sourceProject, path)) || sha(readFileSync(join(opts.sourceProject, path))) !== hash) throw new Error(`运行期间输入发生变化：${path}`);
    }
    success = true;
    progress(`${opts.caseId} ${opts.smoke ? '本地完整烟测' : '真实模型流程'}完成；字幕和最终保存内容一致`);
  } catch (err) {
    error = redact(String(err));
    log(error + '\n');
  } finally {
    clearInterval(heartbeat);
    await stop(probe);
    await stop(worker);
    for (const controller of active) controller.abort();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([...pending]);
    await mock?.close();
    rmSync(temporary, { recursive: true, force: true });
    process.removeListener('SIGTERM', signal);
    process.removeListener('SIGINT', signal);
    const provenance = {
      format: 'video-article-content-revalidation-v1', caseId: opts.caseId, smoke: opts.smoke,
      startedAt, finishedAt: new Date().toISOString(), success, error,
      inputSource: relative(opts.sourceProject, originalDir), subtitleSource: relative(opts.sourceProject, preflightDir),
      originalInputSha256: sha(inputBytes), rawCuesSha256: sha(rawCuesBytes), inputSha256: inputHashes,
      preparedSha256: sha(prepared), preparedChars: prepared.length, video,
      metadataLimitation: preflight.description === undefined ? '已存preflight未记录视频简介；本轮简介为空，不联网补取' : null,
      sourceWorktree: SOURCE_WORKTREE, sourceGitHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).stdout.trim(),
      codeSha256: hashes, productionVars: config.vars, wrapperSha256: wrapperSha,
      executionOnly: '临时main仅增加/__ready和GET /__evidence/<id>调用生产GenerationStore.load；/api原样进入生产handler。无客户端assets。仅YouTube由已存字幕替代；smoke模式另替代Gemini。',
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      requests, savedContext: saved,
      checks: { everyTranscriptMatches: requests.filter((record) => record.transcriptMatches !== null).every((record) => record.transcriptMatches), savedFinalMatches: saved !== null && success, temporaryRemoved: !existsSync(temporary), noSummaryRequests: !requests.some((record) => record.purpose === 'summary') },
    };
    const serialized = JSON.stringify(provenance);
    if (key && serialized.includes(key)) throw new Error('证据意外包含凭据，拒绝写出');
    save(join(opts.out, 'provenance.json'), provenance);
    if (!existsSync(join(opts.out, 'draft.md')) && saved) writeFileSync(join(opts.out, 'draft.md'), saved.review?.draft ?? saved.article.markdown);
  }
  if (!success) throw new Error(error ?? '复验失败，详见新输出目录');
}

try { await main(options()); } catch (err) { console.error((err as Error).message); process.exitCode = 1; }
