/**
 * 模拟上游：在本机模拟 YouTube 播放器接口、timedtext 字幕和 Gemini 两个接口，供 L3 后端 E2E 和 L5 受控全栈使用。
 * 行为由"场景"控制（正常、繁忙、不响应、流中途出错等），每个请求都记录下来，包括请求体和连接是否被对方中止，
 * 测试据此核对 Worker 实际发出了什么、取消有没有传到上游。
 *
 * 管理接口：PUT /__scenario（整体替换场景）、POST /__reset（恢复默认场景并清空记录）、GET /__requests（请求记录）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { geminiPurpose, NO_REQUIREMENTS_JSON } from '../fixtures/upstream';

export type OkVideo = { kind: 'ok'; title?: string; channel?: string; description?: string; cues: [number, string][] };

export type VideoScenario =
  | OkVideo
  /** 一直被拦：每次播放器请求都返回 LOGIN_REQUIRED + bot */
  | { kind: 'blocked' }
  /** 前 times 次播放器请求被拦（http403：直接回 HTTP 403；login：200 + LOGIN_REQUIRED + bot），之后按 then 正常返回。计数随场景重置 */
  | { kind: 'blocked-first'; times: number; mode: 'http403' | 'login'; then: OkVideo }
  | { kind: 'unplayable' }
  | { kind: 'no-captions' }
  | { kind: 'hang' };

export type StreamScenario =
  /** 逐段输出 texts，每段间隔 intervalMs；最后一段带 finishReason（null 表示没有结束标记就断流） */
  | { kind: 'ok'; texts: string[]; intervalMs?: number; finishReason?: string | null; firstDelayMs?: number }
  /** 503 */
  | { kind: 'busy' }
  /** 一直不返回响应头 */
  | { kind: 'hang' }
  /** 先输出 texts，然后在流里发一个错误事件 */
  | { kind: 'error-after'; texts: string[]; code: number };

export type SummaryScenario =
  | { kind: 'ok'; summary: Record<string, string>; delayMs?: number }
  | { kind: 'busy' }
  | { kind: 'hang' }
  | { kind: 'invalid' };

/** 对照字幕核对（generateContent）的行为。ok：每个核对请求只返回 quote 出现在该请求 <section> 里的问题，各章因此各拿各的 */
export type ReviewScenario =
  /** 可解析的 JSON，但核对协议形状可能无效；用于经 HTTP 验证 fail-closed */
  | { kind: 'response'; result: unknown }
  | { kind: 'ok'; issues: { type: string; quote: string; evidence: string; problem: string; replacement: string }[]; delayMs?: number }
  | { kind: 'busy' }
  | { kind: 'hang' }
  | { kind: 'invalid' };

/** 约束提取（generateContent）的行为。ok：返回给定的提取结果 */
export type RequirementsScenario = { kind: 'ok'; result: Record<string, unknown> } | { kind: 'busy' } | { kind: 'hang' } | { kind: 'invalid' };

export interface Scenario {
  videos: Record<string, VideoScenario>;
  /** 按模型名，写文章（streamGenerateContent）的行为 */
  streams: Record<string, StreamScenario>;
  /** 按模型名，generateContent（5W1H）的行为 */
  summaries: Record<string, SummaryScenario>;
  /** 按模型名，对照字幕核对的行为；没列出的模型返回"没有问题" */
  reviews?: Record<string, ReviewScenario>;
  /** 按模型名，约束提取的行为；没列出的模型返回"没有可计算的约束" */
  requirements?: Record<string, RequirementsScenario>;
  /** 按模型名，按要求修订（streamGenerateContent）的行为；没列出的模型返回 503 */
  rewrites?: Record<string, StreamScenario>;
}

export interface RecordedRequest {
  at: string;
  method: string;
  path: string;
  /** stream：写文章；rewrite：按要求修订；review：对照字幕核对；requirements：约束提取；summary：5W1H */
  kind: 'player' | 'captions' | 'stream' | 'rewrite' | 'review' | 'requirements' | 'summary' | 'other';
  model?: string;
  videoId?: string;
  body: unknown;
  /** 对方（Worker）在响应结束前断开了连接 */
  aborted: boolean;
  /** 收到请求到响应结束或连接断开的毫秒数 */
  durationMs: number | null;
  /** 播放器和字幕请求的 User-Agent（核对换客户端时字幕是否用对应客户端的 UA 去拉） */
  userAgent?: string;
}

export const MOCK_VIDEO_ID = 'mockvideo01';

export const MOCK_ARTICLE_TEXTS = [
  '# 对话测试嘉宾：受控上游\n\n## 第一章：开场\n\n',
  '**主持人:** 我们从哪里开始？\n\n**嘉宾:** 从第一个问题开始。\n\n',
  '## 第二章：数字\n\n**主持人:** 有多少项？\n\n**嘉宾:** 大约有1200项。',
];

export const MOCK_SUMMARY = { who: '主持人与嘉宾', what: '开场讨论', when: '', where: '', why: '说明背景', how: '问答' };

export function defaultScenario(): Scenario {
  return {
    videos: {
      [MOCK_VIDEO_ID]: {
        kind: 'ok',
        title: '受控上游测试视频',
        channel: '测试频道',
        description: '本期主持人 Alex Chen',
        cues: [
          [0, 'welcome to the show Alex here'],
          [5, 'let us start with the first question'],
          [2065, '&amp;gt;&amp;gt; we&amp;#39;re tracking on the order of,200 bills'],
        ],
      },
    },
    streams: { 'mock-primary': { kind: 'ok', texts: MOCK_ARTICLE_TEXTS, intervalMs: 50 } },
    summaries: { 'mock-primary': { kind: 'ok', summary: MOCK_SUMMARY } },
  };
}

export interface MockUpstream {
  url: string;
  close(): Promise<void>;
}

export async function startMockUpstream(port: number): Promise<MockUpstream> {
  let scenario = defaultScenario();
  let log: RecordedRequest[] = [];
  /** blocked-first 场景下各视频已收到的播放器请求数 */
  let playerCounts = new Map<string, number>();
  const base = `http://127.0.0.1:${port}`;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', base);
    const text = await readBody(req);

    if (url.pathname === '/__scenario' && req.method === 'PUT') {
      scenario = { ...defaultScenario(), ...(JSON.parse(text) as Partial<Scenario>) };
      playerCounts = new Map();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__reset' && req.method === 'POST') {
      scenario = defaultScenario();
      log = [];
      playerCounts = new Map();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__requests') return json(res, 200, log);

    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // 保留原始文本
    }
    const entry: RecordedRequest = { at: new Date().toISOString(), method: req.method ?? '', path: url.pathname + url.search, kind: 'other', body, aborted: false, durationMs: null };
    log.push(entry);
    const started = Date.now();
    res.on('close', () => {
      entry.durationMs = Date.now() - started;
      if (!res.writableFinished) entry.aborted = true;
    });

    if (url.pathname === '/youtube/player') {
      entry.kind = 'player';
      entry.userAgent = req.headers['user-agent'];
      const videoId = (body as { videoId?: string } | null)?.videoId ?? '';
      entry.videoId = videoId;
      let video: VideoScenario = scenario.videos[videoId] ?? { kind: 'unplayable' };
      if (video.kind === 'blocked-first') {
        const count = (playerCounts.get(videoId) ?? 0) + 1;
        playerCounts.set(videoId, count);
        if (count <= video.times) {
          if (video.mode === 'http403') return json(res, 403, {});
          return json(res, 200, { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } });
        }
        video = video.then;
      }
      if (video.kind === 'hang') return;
      if (video.kind === 'blocked') return json(res, 200, { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } });
      if (video.kind === 'unplayable') return json(res, 200, { playabilityStatus: { status: 'ERROR', reason: 'Video unavailable' } });
      const tracks =
        video.kind === 'no-captions'
          ? []
          : [{ baseUrl: `${base}/youtube/timedtext?v=${videoId}&lang=en&kind=asr&fmt=srv3`, languageCode: 'en', kind: 'asr', vssId: 'a.en', name: { runs: [{ text: 'English (auto-generated)' }] } }];
      return json(res, 200, {
        playabilityStatus: { status: 'OK' },
        videoDetails: {
          title: video.kind === 'ok' ? (video.title ?? '') : '',
          author: video.kind === 'ok' ? (video.channel ?? '') : '',
          shortDescription: video.kind === 'ok' ? (video.description ?? '') : '',
          lengthSeconds: '600',
        },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
      });
    }

    if (url.pathname === '/youtube/timedtext') {
      entry.kind = 'captions';
      entry.userAgent = req.headers['user-agent'];
      const videoId = url.searchParams.get('v') ?? '';
      entry.videoId = videoId;
      const scenarioVideo = scenario.videos[videoId];
      const video = scenarioVideo?.kind === 'blocked-first' ? scenarioVideo.then : scenarioVideo;
      if (!video || video.kind !== 'ok') return json(res, 404, {});
      const cues = video.cues.map(([seconds, text]) => `<text start="${seconds}" dur="2.5">${text}</text>`).join('');
      res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
      return res.end(`<?xml version="1.0" encoding="utf-8" ?><transcript>${cues}</transcript>`);
    }

    const gemini = /^\/gemini\/([^/:]+):(streamGenerateContent|generateContent)$/.exec(url.pathname);
    if (gemini) {
      const model = decodeURIComponent(gemini[1]!);
      entry.model = model;
      const purpose = geminiPurpose(url.pathname, body);
      if (purpose === 'rewrite') {
        entry.kind = 'rewrite';
        return stream(res, scenario.rewrites?.[model] ?? { kind: 'busy' });
      }
      if (purpose === 'article') {
        entry.kind = 'stream';
        return stream(res, scenario.streams[model] ?? { kind: 'busy' });
      }
      if (purpose === 'review') {
        entry.kind = 'review';
        const behavior = scenario.reviews?.[model] ?? { kind: 'ok', issues: [] };
        if (behavior.kind === 'response') return structured(res, behavior.result);
        if (behavior.kind !== 'ok') return summary(res, behavior);
        const user = String((body as { contents?: { parts?: { text?: string }[] }[] } | null)?.contents?.[0]?.parts?.[0]?.text ?? '');
        // 用户消息末尾的"请核对 <section>，输出问题列表。"里也有 <section>，要找的是 "<section>\n" 开头的那一块
        const section = user.slice(user.indexOf('<section>\n'), user.lastIndexOf('\n</section>'));
        return structured(res, { issues: behavior.issues.filter((i) => section.includes(i.quote)) }, behavior.delayMs);
      }
      if (purpose === 'requirements') {
        entry.kind = 'requirements';
        const behavior = scenario.requirements?.[model] ?? { kind: 'ok', result: NO_REQUIREMENTS_JSON };
        return behavior.kind === 'ok' ? structured(res, behavior.result) : summary(res, behavior);
      }
      entry.kind = 'summary';
      return summary(res, scenario.summaries[model] ?? { kind: 'busy' });
    }

    json(res, 404, { error: `模拟上游没有这个地址：${url.pathname}` });
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: base,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function stream(res: ServerResponse, behavior: StreamScenario) {
  if (behavior.kind === 'hang') return;
  if (behavior.kind === 'busy') return busy(res);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const texts = behavior.texts;
  if (behavior.kind === 'ok' && behavior.firstDelayMs) await sleep(behavior.firstDelayMs);
  for (let i = 0; i < texts.length; i++) {
    if (res.destroyed) return;
    const last = i === texts.length - 1;
    const candidate: Record<string, unknown> = { content: { parts: [{ text: texts[i] }], role: 'model' }, index: 0 };
    if (behavior.kind === 'ok' && last) {
      const finishReason = behavior.finishReason === undefined ? 'STOP' : behavior.finishReason;
      if (finishReason) candidate.finishReason = finishReason;
    }
    res.write(`data: ${JSON.stringify({ candidates: [candidate], modelVersion: 'mock' })}\r\n\r\n`);
    if (behavior.kind === 'ok' && !last) await sleep(behavior.intervalMs ?? 0);
  }
  if (behavior.kind === 'error-after') {
    res.write(`data: ${JSON.stringify({ error: { code: behavior.code, message: 'The model is overloaded.', status: 'UNAVAILABLE' } })}\r\n\r\n`);
  }
  res.end();
}

async function summary(res: ServerResponse, behavior: SummaryScenario | { kind: 'busy' } | { kind: 'hang' } | { kind: 'invalid' }) {
  if (behavior.kind === 'hang') return;
  if (behavior.kind === 'busy') return busy(res);
  if (behavior.kind === 'invalid') {
    return json(res, 200, { candidates: [{ content: { parts: [{ text: '这不是 JSON' }], role: 'model' }, finishReason: 'STOP' }] });
  }
  return structured(res, behavior.summary, behavior.delayMs);
}

/** generateContent 的正常响应：把 value 作为 JSON 文本放进候选里 */
async function structured(res: ServerResponse, value: unknown, delayMs?: number) {
  if (delayMs) await sleep(delayMs);
  if (res.destroyed) return;
  json(res, 200, { candidates: [{ content: { parts: [{ text: JSON.stringify(value) }], role: 'model' }, finishReason: 'STOP' }] });
}

function busy(res: ServerResponse) {
  json(res, 503, { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } });
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
