/**
 * 离线收尾探针：拿一篇已有的初稿和交给模型的字幕正文，直接跑生产的收尾流程（finalizeArticle：
 * 约束提取与核对、逐章核对、整篇复核、重叠建议的合并处理），不经过 Worker，也不重新写文章。
 * 用来验证"已知的内容错误能不能查出来、正确的内容会不会被误改"。会真实调用 Gemini，产生费用。
 *
 *   tsx scripts/finalize-probe.ts <初稿.md> <整理后的字幕.txt> <视频元数据.json> <输出目录> [--instructions 文本] [--model 名称] [--thinking 档位]
 *
 * 输出：final.md（最终稿）、result.json（修订、未采用的建议及处置、约束核对）、calls.json（每次模型调用的原始返回和用量）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countArticleChars } from '../src/shared/article';
import { finalizeArticle } from '../src/worker/finalize';
import { generateJson, streamText, type GeminiStats } from '../src/worker/gemini';
import { confirmRequirements, REQUIREMENTS_SCHEMA, requirementsPrompt } from '../src/worker/requirements';
import type { VideoMeta } from '../src/worker/youtube';
import { readEnvFile } from './lib/env-file';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const instructions = flag('--instructions') ?? '';
const model = flag('--model') ?? 'gemini-4-hydrogen';
const thinkingLevel = flag('--thinking') ?? 'high';
const [draftPath, transcriptPath, metaPath, outDir] = args;
if (!draftPath || !transcriptPath || !metaPath || !outDir) {
  console.error('用法：tsx scripts/finalize-probe.ts <初稿.md> <整理后的字幕.txt> <视频元数据.json> <输出目录> [--instructions 文本] [--model 名称] [--thinking 档位]');
  process.exit(2);
}

const apiKey = readEnvFile('.env').GEMINI_API_KEY;
if (!apiKey) throw new Error('.env 里没有 GEMINI_API_KEY');
const draft = readFileSync(draftPath, 'utf8');
const transcriptText = readFileSync(transcriptPath, 'utf8');
const metaFile = JSON.parse(readFileSync(metaPath, 'utf8')) as { video?: VideoMeta } & Partial<VideoMeta>;
const video = (metaFile.video ?? metaFile) as VideoMeta;
const gemini = { apiKey, model, thinkingLevel, timeouts: { requestMs: 600_000 } };

mkdirSync(outDir, { recursive: true });
const calls: { kind: string; ms: number; usage: unknown; system: string; raw: unknown }[] = [];
const stages: [number, string][] = [];
const startedAt = Date.now();
const timed = async <T>(kind: string, system: string, run: (stats: GeminiStats) => Promise<T>): Promise<T> => {
  const stats: GeminiStats = {};
  const t0 = Date.now();
  const raw = await run(stats);
  calls.push({ kind, ms: Date.now() - t0, usage: stats.usage ?? null, system: system.slice(0, 40), raw });
  return raw;
};

const requirements = confirmRequirements(instructions, () => {
  const prompt = requirementsPrompt(instructions);
  return timed('requirements', prompt.system, (stats) => generateJson({ ...gemini, thinkingLevel: 'low' }, prompt, REQUIREMENTS_SCHEMA, stats));
}).then((r) => r.requirements);

const result = await finalizeArticle(
  { draft, video, transcriptText, instructions, requirements },
  {
    json: (prompt, schema) => timed('json', prompt.system, (stats) => generateJson(gemini, prompt, schema, stats)),
    rewrite: (prompt) =>
      timed('rewrite', prompt.system, async (stats) => {
        let text = '';
        await streamText(gemini, prompt, async (chunk) => void (text += chunk), new AbortController().signal, stats);
        return text;
      }),
  },
  async (stage) => void stages.push([Date.now() - startedAt, stage]),
);
const ms = Date.now() - startedAt;

writeFileSync(join(outDir, 'final.md'), result.markdown);
writeFileSync(join(outDir, 'calls.json'), JSON.stringify(calls, null, 2));
writeFileSync(
  join(outDir, 'result.json'),
  JSON.stringify(
    { model, thinkingLevel, ms, stages, charsBefore: countArticleChars(draft), charsAfter: countArticleChars(result.markdown), requirements: result.requirements, review: result.review, rejected: result.rejected, revisions: result.revisions },
    null,
    2,
  ),
);

console.log(`${model} ${thinkingLevel}：${(ms / 1000).toFixed(1)} 秒，模型调用 ${calls.length} 次；${countArticleChars(draft)} → ${countArticleChars(result.markdown)} 字`);
console.log(`采用 ${result.revisions.length} 条，未采用 ${result.review.unapplied?.length ?? 0} 条，计数 ${JSON.stringify(result.rejected)}`);
for (const r of result.revisions) console.log(`\n[采用 ${r.type}] ${r.reason}\n  原：${r.before}\n  改：${r.after}\n  据：${r.evidence.slice(0, 220)}`);
for (const u of result.review.unapplied ?? []) console.log(`\n[未采用 ${u.stage}/${u.disposition}] ${u.problem}${u.note ? `（${u.note}）` : ''}\n  原：${u.quote}\n  改：${u.replacement}`);
