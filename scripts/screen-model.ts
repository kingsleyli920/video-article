/**
 * 模型筛选：用固定输入直接调用生产代码里的 streamText，保存实际请求和原始流式输出。
 * 字幕固定为内置的示例视频真实字幕（与实时获取的同一字幕轨逐条一致），提示词和请求参数与线上相同。
 *
 *   tsx scripts/screen-model.ts <模型> <输出目录> [生成要求] [--thinking low]
 *
 * 写出：request.json（实际发出的请求体，不含 API key）、raw.sse（Gemini 原样返回的字节，每次请求之间有分隔行）、
 * attempts.json（每次实际请求：开始时间、HTTP 状态、耗时、错误摘要；包括已有的一次 503 重试）、
 * article.md、result.json（首个正文到达本脚本的时间、总耗时、结束原因、统一口径字数、token 用量和估算费用、请求体哈希）。
 * 直接调用 streamText，不经过 Worker，不会切换备用模型。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile } from './lib/env-file';
import { countArticleChars, parseArticle, validateArticle } from '../src/shared/article';
import { streamText } from '../src/worker/gemini';
import { articlePrompt } from '../src/worker/prompts';
import sample from '../src/worker/transcripts/xRh2sVcNXQ8.json' with { type: 'json' };
import { formatTranscript } from '../src/worker/youtube';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const thinkingLevel = flag('--thinking') ?? 'low';
const [model, outDir, instructions = ''] = args;
if (!model || !outDir) {
  console.error('用法：tsx scripts/screen-model.ts <模型> <输出目录> [生成要求] [--thinking low]');
  process.exit(2);
}
const apiKey = readEnvFile('.env').GEMINI_API_KEY;
if (!apiKey) throw new Error('.env 里没有 GEMINI_API_KEY');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'raw.sse'), '');
const transcriptText = formatTranscript(sample.cues.map(([start, text]) => ({ start: start as number, text: text as string })));
const prompt = articlePrompt({ video: sample.video, transcriptText, instructions });

// 包一层 fetch：记录每次实际请求和请求体，并把响应字节原样写盘（边收边写）
const realFetch = globalThis.fetch;
const attempts: { startedAt: string; status: number | null; ms: number | null; error: string | null }[] = [];
const t0 = performance.now();
globalThis.fetch = async (input, init) => {
  writeFileSync(join(outDir, 'request.json'), JSON.stringify({ url: String(input), body: JSON.parse(String(init?.body)) }, null, 2));
  const attempt = { startedAt: new Date().toISOString(), status: null as number | null, ms: null as number | null, error: null as string | null };
  attempts.push(attempt);
  appendFileSync(join(outDir, 'raw.sse'), `\n# —— 第 ${attempts.length} 次请求 ${attempt.startedAt} ——\n`);
  const started = performance.now();
  let res: Response;
  try {
    res = await realFetch(input, init);
  } catch (err) {
    attempt.error = String(err);
    throw err;
  }
  attempt.status = res.status;
  attempt.ms = Math.round(performance.now() - started);
  if (!res.ok) {
    const text = await res.text();
    attempt.error = text.slice(0, 300);
    appendFileSync(join(outDir, 'raw.sse'), text);
    return new Response(text, { status: res.status, headers: res.headers });
  }
  if (!res.body) return res;
  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      appendFileSync(join(outDir, 'raw.sse'), chunk);
      controller.enqueue(chunk);
    },
  });
  return new Response(res.body.pipeThrough(tee), { status: res.status, headers: res.headers });
};

let firstTextMs: number | null = null;
let markdown = '';
let finishReason: string | null = null;
let error: string | null = null;
try {
  finishReason = await streamText({ apiKey, model, thinkingLevel }, prompt, async (text) => {
    firstTextMs ??= Math.round(performance.now() - t0);
    markdown += text;
  });
} catch (err) {
  error = (err as Error).message;
}
const totalMs = Math.round(performance.now() - t0);
const article = parseArticle(markdown);

// token 用量取最后一个带 usageMetadata 的事件；按 2026-11 官方标准价估算（每百万 token 美元，思考 token 按输出价计）
const PRICES: Record<string, { input: number; output: number }> = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-4-hydrogen': { input: 1.5, output: 7.5 },
};
interface Usage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}
let usage = null as Usage | null;
for (const line of readFileSync(join(outDir, 'raw.sse'), 'utf8').split('\n')) {
  if (!line.startsWith('data:')) continue;
  try {
    const event = JSON.parse(line.slice(5)) as { usageMetadata?: Usage };
    if (event.usageMetadata) usage = event.usageMetadata;
  } catch {
    // 不是完整 JSON 的行跳过
  }
}
const price = PRICES[model];
const outputTokens = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
const costUsd = price && usage ? Number((((usage.promptTokenCount ?? 0) * price.input + outputTokens * price.output) / 1e6).toFixed(4)) : null;
const requestBody = JSON.parse(readFileSync(join(outDir, 'request.json'), 'utf8')).body;
const result = {
  model,
  thinkingLevel,
  instructions,
  transcript: { source: '内置备份（与实时字幕轨 a.en 逐条一致）', chars: transcriptText.length },
  /** 首个正文到达本脚本的时间（不是浏览器可见时间） */
  firstTextMs,
  totalMs,
  attempts: attempts.length,
  finishReason,
  error,
  chapters: article.chapters.length,
  structureProblem: markdown ? validateArticle(article) : '没有输出',
  chars: countArticleChars(markdown),
  usage,
  costUsd,
  /** 请求体（不含模型名，模型名在 URL 里）的 SHA-256，用来核对不同模型拿到的输入完全相同 */
  requestBodySha256: createHash('sha256').update(JSON.stringify(requestBody)).digest('hex'),
};
writeFileSync(join(outDir, 'attempts.json'), JSON.stringify(attempts, null, 2));
writeFileSync(join(outDir, 'article.md'), markdown);
writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
