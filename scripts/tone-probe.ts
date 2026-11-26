/**
 * 只跑语气清单核对这一路（真实模型，不带整段字幕，费用很低），打印每条判为 dropped 的结论，可选地打印指定编号的结论。
 *   tsx scripts/tone-probe.ts <文章.md> <整理后的字幕.txt> <视频元数据.json> [编号…]
 */
import { readFileSync } from 'node:fs';
import { generateJson } from '../src/worker/gemini';
import { chunkExcerpts, hedgedExcerpts, hedgeReviewPrompt, parseToneChecks, TONE_SCHEMA } from '../src/worker/hedges';
import { readEnvFile } from './lib/env-file';

const [articlePath, transcriptPath, metaPath, ...watch] = process.argv.slice(2);
const section = readFileSync(articlePath!, 'utf8');
const { excerpts } = hedgedExcerpts(readFileSync(transcriptPath!, 'utf8'));
const video = JSON.parse(readFileSync(metaPath!, 'utf8')).video;
const chunks = chunkExcerpts(excerpts);
const gemini = { apiKey: readEnvFile('.env').GEMINI_API_KEY!, model: 'gemini-4-hydrogen', thinkingLevel: 'high', timeouts: { requestMs: 600_000 } };
let first = 1;
await Promise.all(
  chunks.map(async (chunk) => {
    const start = first;
    first += chunk.length;
    const raw = (await generateJson(gemini, hedgeReviewPrompt({ video, excerpts: chunk, first: start, section }), TONE_SCHEMA, {})) as { checks: { index: number; status: string; quote: string; replacement: string }[] };
    console.log(`第 ${start}–${start + chunk.length - 1} 条：${parseToneChecks(raw, start, chunk.length) ? '结论齐全' : '结论不全'}`);
    for (const c of raw.checks) {
      if (c.status === 'dropped' || watch.includes(String(c.index))) console.log(`  #${c.index} ${c.status} [${excerpts[c.index - 1]!.text.slice(0, 90)}]${c.status === 'dropped' ? `\n     ${c.quote} => ${c.replacement}` : ''}`);
    }
  }),
);
