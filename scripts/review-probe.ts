/**
 * 离线核对探针：拿一篇已经保存的文章和交给模型的字幕正文，直接调用生产的核对提示词和修订规则，
 * 不经过 Worker。用来验证"已知错误能不能查出来、正确的内容会不会被误改"。会真实调用 Gemini，产生费用。
 *
 *   tsx scripts/review-probe.ts <文章.md> <整理后的字幕.txt> <视频元数据.json> <输出目录> [--instructions 文本] [--model 名称] [--thinking 档位]
 *
 * 视频元数据.json：{ id, title, channel, description, lengthSeconds }（内置备份文件的 video 字段可以直接用）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countArticleChars, parseArticle } from '../src/shared/article';
import { generateJson, type GeminiStats } from '../src/worker/gemini';
import { applyRevisions, parseIssues, REVIEW_SCHEMA, reviewPrompt, splitForReview } from '../src/worker/review';
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
const [articlePath, transcriptPath, metaPath, outDir] = args;
if (!articlePath || !transcriptPath || !metaPath || !outDir) {
  console.error('用法：tsx scripts/review-probe.ts <文章.md> <整理后的字幕.txt> <视频元数据.json> <输出目录> [--instructions 文本] [--model 名称] [--thinking 档位]');
  process.exit(2);
}

const apiKey = readEnvFile('.env').GEMINI_API_KEY;
if (!apiKey) throw new Error('.env 里没有 GEMINI_API_KEY');
const markdown = readFileSync(articlePath, 'utf8');
const transcriptText = readFileSync(transcriptPath, 'utf8');
const metaFile = JSON.parse(readFileSync(metaPath, 'utf8')) as { video?: VideoMeta } & Partial<VideoMeta>;
const video = (metaFile.video ?? metaFile) as VideoMeta;

mkdirSync(outDir, { recursive: true });
const sections = splitForReview(markdown) ?? [markdown];
const outline = parseArticle(markdown).chapters.map((c) => c.title);
const startedAt = Date.now();
const results = await Promise.all(
  sections.map(async (section, index) => {
    const stats: GeminiStats = {};
    const t0 = Date.now();
    const raw = await generateJson({ apiKey, model, thinkingLevel, timeouts: { requestMs: 600_000 } }, reviewPrompt({ video, transcriptText, instructions, outline, section }), REVIEW_SCHEMA, stats);
    const { issues, malformed } = parseIssues(raw);
    const outcome = applyRevisions(section, issues, transcriptText);
    return { index, ms: Date.now() - t0, usage: stats.usage ?? null, issues, malformed, outcome };
  }),
);
const ms = Date.now() - startedAt;
const revised = results.map((r) => r.outcome.markdown).join('');
const applied = results.flatMap((r) => r.outcome.applied.map((a) => ({ section: r.index + 1, ...a })));
const rejected = results.flatMap((r) => r.outcome.rejected.map((a) => ({ section: r.index + 1, ...a })));
const sum = (k: 'promptTokenCount' | 'candidatesTokenCount' | 'thoughtsTokenCount' | 'cachedContentTokenCount') => results.reduce((n, r) => n + (r.usage?.[k] ?? 0), 0);
const usage = { prompt: sum('promptTokenCount'), output: sum('candidatesTokenCount'), thoughts: sum('thoughtsTokenCount'), cached: sum('cachedContentTokenCount') };

writeFileSync(join(outDir, 'issues.json'), JSON.stringify({ model, thinkingLevel, ms, usage, sections: results.map((r) => ({ section: r.index + 1, ms: r.ms, usage: r.usage, issues: r.issues, malformed: r.malformed })) }, null, 2));
writeFileSync(join(outDir, 'outcome.json'), JSON.stringify({ applied, rejected, charsBefore: countArticleChars(markdown), charsAfter: countArticleChars(revised) }, null, 2));
writeFileSync(join(outDir, 'revised.md'), revised);

console.log(`${model} ${thinkingLevel}：${sections.length} 个单元并行，共 ${(ms / 1000).toFixed(1)} 秒（各单元 ${results.map((r) => (r.ms / 1000).toFixed(0)).join('、')} 秒），用量 ${JSON.stringify(usage)}`);
console.log(`采用 ${applied.length} 条，丢弃 ${rejected.length} 条`);
for (const r of applied) console.log(`\n[§${r.section} 采用 ${r.type}] ${r.reason}\n  原：${r.before}\n  改：${r.after}\n  据：${r.evidence.slice(0, 220)}`);
for (const r of rejected) console.log(`\n[§${r.section} 丢弃 ${r.reason}] ${JSON.stringify(r.issue).slice(0, 500)}`);
