/**
 * 流式验证探针：对本地或线上地址发起一次真实生成，按网络分块记录到达时间，
 * 把"第一段正文到达客户端的时间"和服务端回报的"模型结束时间"放在一起比较。
 *
 *   tsx scripts/stream-probe.ts <站点地址> <YouTube 链接> [生成要求] [--out 目录] [--idle 秒]
 *
 * 指定 --out 时，收到的原始字节边收边追加到 raw.sse；无论正常结束、出错还是超时，
 * 都会写出 input.json、timeline.json 和（可能不完整的）article.md，不会只留下最后的报错。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasReadableParagraph } from '../src/shared/article';
import { SseParser } from '../src/shared/sse';
import type { StreamEvents } from '../src/shared/types';

const args = process.argv.slice(2);
const takeFlag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const outDir = takeFlag('--out');
const idleSeconds = Number(takeFlag('--idle') ?? 120);
const [base, url, instructions = ''] = args;
if (!base || !url) {
  console.error('用法：tsx scripts/stream-probe.ts <站点地址> <YouTube 链接> [生成要求] [--out 目录] [--idle 秒]');
  process.exit(2);
}

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'input.json'), JSON.stringify({ base, url, instructions, startedAt: new Date().toISOString() }, null, 2));
  writeFileSync(join(outDir, 'raw.sse'), '');
}

const t0 = performance.now();
const at = () => Math.round(performance.now() - t0);
const controller = new AbortController();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const touch = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => controller.abort(new Error(`${idleSeconds} 秒没有收到任何字节`)), idleSeconds * 1000);
};

const timeline: { ms: number; bytes: number; events: string[] }[] = [];
const growth: [number, number][] = [];
let headersAt: number | null = null;
let responseHeaders: Record<string, string> = {};
let markdown = '';
let firstDeltaAt: number | null = null;
/** 第一段写完、不是标题的正文到达探针的时间（不是浏览器可见时间） */
let firstParagraphAt: number | null = null;
let metaAt: number | null = null;
let lastDeltaAt: number | null = null;
let deltaEvents = 0;
let meta: StreamEvents['meta'] | null = null;
let done: StreamEvents['done'] | null = null;
let failure: StreamEvents['error'] | null = null;
let probeError: string | null = null;
/** 阶段事件到达的时间；核对修订相关：初稿、修订列表、最终文章到达的时间 */
const stages: [number, string][] = [];
let draft: string | null = null;
let revisions: StreamEvents['revised']['revisions'] = [];
let revisedAt: number | null = null;

try {
  touch();
  const res = await fetch(new URL('/api/generations', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, instructions }),
    signal: controller.signal,
  });
  headersAt = at();
  responseHeaders = Object.fromEntries(['content-type', 'content-encoding', 'cache-control', 'cf-ray'].map((h) => [h, res.headers.get(h) ?? '']));
  console.log(`HTTP ${res.status} ${responseHeaders['content-type']}，响应头到达 ${headersAt} ms`);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}：${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    touch();
    const ms = at();
    const text = decoder.decode(value, { stream: true });
    if (outDir) appendFileSync(join(outDir, 'raw.sse'), text);
    const messages = parser.push(text);
    timeline.push({ ms, bytes: value.byteLength, events: messages.map((m) => m.event) });
    for (const message of messages) {
      const data = JSON.parse(message.data);
      if (message.event === 'meta') {
        meta = data;
        metaAt ??= ms;
      }
      if (message.event === 'stage') stages.push([ms, (data as StreamEvents['stage']).stage]);
      if (message.event === 'revised') {
        // 核对后的最终文章：初稿另存，article.md 写最终版本
        draft = markdown;
        markdown = (data as StreamEvents['revised']).markdown;
        revisions = (data as StreamEvents['revised']).revisions;
        revisedAt = ms;
      }
      if (message.event === 'done') done = data;
      if (message.event === 'error') failure = data;
      if (message.event === 'delta') {
        markdown += (data as StreamEvents['delta']).text;
        deltaEvents++;
        firstDeltaAt ??= ms;
        lastDeltaAt = ms;
        if (firstParagraphAt === null && hasReadableParagraph(markdown)) firstParagraphAt = ms;
      }
    }
    if (messages.some((m) => m.event === 'delta')) growth.push([ms, markdown.length]);
  }
} catch (err) {
  probeError = controller.signal.aborted ? String((controller.signal.reason as Error).message) : String((err as Error)?.message ?? err);
} finally {
  clearTimeout(idleTimer);
}

const endAt = at();
console.log(`字幕来源：${meta?.transcript.source ?? '?'}（${meta?.transcript.kind ?? '?'}，${meta?.transcript.chars ?? '?'} 字符），模型：${meta?.model ?? '?'}`);
console.log(`网络分块 ${timeline.length} 个，delta 事件 ${deltaEvents} 个，正文 ${markdown.length} 字符`);
// 文章只有一段正文时，要到最后一段正文到达才算读到完整段落
if (firstParagraphAt === null && done && hasReadableParagraph(markdown, true)) firstParagraphAt = lastDeltaAt;
console.log(`探针：来源信息 ${metaAt} ms，首个正文文本 ${firstDeltaAt} ms，首个可读段落 ${firstParagraphAt} ms，最后一段正文 ${lastDeltaAt} ms，流结束 ${endAt} ms`);
if (done) {
  const t = done.timing;
  console.log(`服务端：字幕就绪 ${t.transcriptMs} ms，模型首个 token ${t.firstTokenMs} ms，模型结束 ${t.modelDoneMs} ms，保存完成 ${t.savedMs} ms`);
  console.log(`结果：done，共 ${done.chapters.length} 章、${done.chars} 字`);
  if (done.review) {
    const r = done.review;
    console.log(`核对：${r.sections} 个单元，修订 ${r.revisions} 处${r.rewritten ? `；按要求修订过（${r.rewritten.unmet.join('；')}，${r.rewritten.charsBefore} → ${r.rewritten.charsAfter} 字）` : ''}${r.checks.length ? `；${r.checks.join('；')}` : ''}；核对结束 ${t.reviewedMs ?? '?'} ms`);
  }
  console.log(`阶段：${stages.map(([ms, s]) => `${s}@${ms}`).join('  ')}`);
  if (firstDeltaAt !== null) console.log(`第一段正文比模型结束早到 ${t.modelDoneMs - firstDeltaAt} ms`);
} else {
  console.log(`结果：${failure ? `error ${failure.code}：${failure.message}` : probeError ? `探针异常：${probeError}` : '没有收到 done 或 error'}`);
}
const step = Math.max(1, Math.floor(growth.length / 12));
console.log('正文增长（毫秒 → 字符数）：' + growth.filter((_, i) => i % step === 0 || i === growth.length - 1).map(([ms, n]) => `${ms}→${n}`).join('  '));

if (outDir) {
  writeFileSync(join(outDir, 'article.md'), markdown);
  if (draft !== null) writeFileSync(join(outDir, 'draft.md'), draft);
  writeFileSync(join(outDir, 'revisions.json'), JSON.stringify(revisions, null, 2));
  writeFileSync(
    join(outDir, 'timeline.json'),
    JSON.stringify({ outcome: done ? 'done' : failure ? 'error' : 'incomplete', probeError, headersAt, responseHeaders, metaAt, firstDeltaAt, firstParagraphAt, lastDeltaAt, stages, revisedAt, endAt, meta, done, failure, timeline }, null, 2),
  );
  console.log(`已写入 ${outDir}/（input.json、raw.sse、timeline.json、article.md）`);
}
