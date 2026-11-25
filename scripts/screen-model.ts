/**
 * 模型筛选：用固定输入直接调用生产代码里的 streamText，保存实际请求和原始流式输出。
 * 字幕固定为内置的示例视频真实字幕（与实时获取的同一字幕轨逐条一致），提示词和请求参数与线上相同。
 *
 *   tsx scripts/screen-model.ts <模型> <输出目录> [生成要求] [--thinking low]
 *
 * 写出：request.json（实际发出的请求体，不含 API key）、raw.sse（Gemini 原样返回的字节）、
 * article.md、result.json（首个正文、总耗时、结束原因、统一口径字数）。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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

// 包一层 fetch：记录实际发出的请求体，并把响应字节原样写盘（边收边写）
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  writeFileSync(join(outDir, 'request.json'), JSON.stringify({ url: String(input), body: JSON.parse(String(init?.body)) }, null, 2));
  const res = await realFetch(input, init);
  if (!res.body) return res;
  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      appendFileSync(join(outDir, 'raw.sse'), chunk);
      controller.enqueue(chunk);
    },
  });
  return new Response(res.body.pipeThrough(tee), { status: res.status, headers: res.headers });
};

const t0 = performance.now();
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
const result = {
  model,
  thinkingLevel,
  instructions,
  transcript: { source: '内置备份（与实时字幕轨 a.en 逐条一致）', chars: transcriptText.length },
  firstTextMs,
  totalMs,
  finishReason,
  error,
  chapters: article.chapters.length,
  structureProblem: markdown ? validateArticle(article) : '没有输出',
  chars: countArticleChars(markdown),
};
writeFileSync(join(outDir, 'article.md'), markdown);
writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
