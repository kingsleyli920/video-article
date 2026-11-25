/**
 * 直接测 5W1H 在指定模型和思考档位下的耗时和用量：用线上同一份提示词（summaryPrompt + SUMMARY_SCHEMA），
 * 不设线上的等待上限，测出真实耗时，用来定 SUMMARY_TIMING。不经过 Worker，也不写 Durable Object。
 *   tsx scripts/measure-summary.ts <模型> <思考档> <文章目录（含 article.md）> <章节号,章节号>
 * 结果写到 evidence/round8/summary-direct/<模型>-<思考档>-<文章目录名>-ch<章节号>/result.json。
 */
import { Agent, setGlobalDispatcher } from 'undici';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readEnvFile } from './lib/env-file';
import { parseArticle } from '../src/shared/article';
import { generateJson, type GeminiStats } from '../src/worker/gemini';
import { summaryPrompt } from '../src/worker/prompts';
import { normalizeSummary, SUMMARY_SCHEMA } from '../src/worker/summary-schema';
import sample from '../src/worker/transcripts/xRh2sVcNXQ8.json' with { type: 'json' };
import { formatTranscript } from '../src/worker/youtube';

const [model, thinkingLevel, articleDir, ids] = process.argv.slice(2);
if (!model || !thinkingLevel || !articleDir || !ids) {
  console.error('用法：tsx scripts/measure-summary.ts <模型> <思考档> <文章目录> <章节号,章节号>');
  process.exit(2);
}
// 高档思考可能超过 Node fetch 默认的 300 秒响应头等待；本脚本放宽到 20 分钟
setGlobalDispatcher(new Agent({ headersTimeout: 1_200_000, bodyTimeout: 1_200_000 }));
const apiKey = readEnvFile('.env').GEMINI_API_KEY;
if (!apiKey) throw new Error('.env 里没有 GEMINI_API_KEY');

const transcriptText = formatTranscript(sample.cues.map(([start, text]) => ({ start: start as number, text: text as string })));
const article = parseArticle(readFileSync(join(articleDir, 'article.md'), 'utf8'));
for (const id of ids.split(',')) {
  const chapter = article.chapters.find((c) => c.id === id);
  if (!chapter) throw new Error(`文章里没有第 ${id} 章`);
  const prompt = summaryPrompt({ video: sample.video, transcriptText, instructions: '', chapterTitles: article.chapters.map((c) => c.title), chapter });
  const out = join('evidence/round8/summary-direct', `${model}-${thinkingLevel}-${basename(articleDir)}-ch${id}`);
  mkdirSync(out, { recursive: true });
  const stats: GeminiStats = {};
  const t0 = performance.now();
  let raw: unknown = null;
  let error: string | null = null;
  try {
    raw = await generateJson({ apiKey, model, thinkingLevel, timeouts: { requestMs: 600_000 } }, prompt, SUMMARY_SCHEMA, stats);
  } catch (err) {
    error = (err as Error).message;
  }
  const ms = Math.round(performance.now() - t0);
  let summary: unknown = null;
  try {
    summary = raw ? normalizeSummary(raw) : null;
  } catch (err) {
    error ??= `字段校验失败：${(err as Error).message}`;
  }
  const result = { model, thinkingLevel, chapterId: id, chapterTitle: chapter.title, ms, error, modelVersion: stats.modelVersion ?? null, serviceTierHeader: stats.serviceTierHeader ?? null, usage: stats.usage ?? null, summary };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ chapterId: id, ms, error, usage: stats.usage ?? null, modelVersion: stats.modelVersion ?? null }));
}
