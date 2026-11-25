/**
 * 离线分析已保存的生成记录，不调用模型。
 *   tsx scripts/analyze-runs.ts <目录…>
 *
 * 两种记录：
 * - 直接调用模型（scripts/screen-model.ts）：raw.sse 是 Gemini 原样返回的字节，result.json 有首个文本时间，
 *   新版还有 timeline.json（每个正文分块的到达时间）。
 * - 经过 Worker（scripts/stream-probe.ts）：raw.sse 是 Worker 发出的 SSE，timeline.json 记录每个网络分块的到达时间和事件。
 *
 * 输出每次的 token 用量（输入、思考、输出、缓存命中）、结束原因、模型版本、服务档、首个文本时间、首个可读段落时间。
 * 缺失的字段输出 "未知"，不当成 0。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hasReadableParagraph } from '../src/shared/article';
import { SseParser } from '../src/shared/sse';

interface Row {
  run: string;
  kind: '直接调用' | '经 Worker';
  model: string;
  thinking: string;
  input: number | null;
  thoughts: number | null;
  output: number | null;
  cached: number | null;
  finishReason: string | null;
  modelVersion: string | null;
  serviceTier: string | null;
  firstTextMs: number | null;
  firstParagraphMs: number | null;
  totalMs: number | null;
}

const show = (v: number | string | null) => (v === null || v === undefined ? '未知' : String(v));

function geminiEvents(raw: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      events.push(JSON.parse(line.slice(5)) as Record<string, unknown>);
    } catch {
      // 不完整的行跳过
    }
  }
  return events;
}

function direct(dir: string): Row {
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Record<string, unknown>;
  const events = geminiEvents(readFileSync(join(dir, 'raw.sse'), 'utf8'));
  let usage: Record<string, number | string> | null = null;
  let finishReason: string | null = null;
  let modelVersion: string | null = null;
  for (const e of events) {
    if (e.usageMetadata) usage = e.usageMetadata as Record<string, number | string>;
    if (typeof e.modelVersion === 'string') modelVersion = e.modelVersion;
    const candidate = (e.candidates as { finishReason?: string }[] | undefined)?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
  }
  const num = (k: string) => (usage && typeof usage[k] === 'number' ? (usage[k] as number) : null);
  // 首个可读段落：新版记录有 timeline.json（正文分块的到达时间），旧记录没有，只能记为未知
  let firstParagraphMs = (result.firstParagraphMs as number | null | undefined) ?? null;
  if (firstParagraphMs === null && existsSync(join(dir, 'timeline.json'))) {
    const chunks = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as { ms: number; chars: number }[];
    const article = readFileSync(join(dir, 'article.md'), 'utf8');
    firstParagraphMs = chunks.find((c) => hasReadableParagraph(article.slice(0, c.chars)))?.ms ?? null;
  }
  return {
    run: basename(dir),
    kind: '直接调用',
    model: String(result.model),
    thinking: String(result.thinkingLevel ?? '未知'),
    input: num('promptTokenCount'),
    thoughts: num('thoughtsTokenCount'),
    output: num('candidatesTokenCount'),
    cached: num('cachedContentTokenCount'),
    finishReason: finishReason ?? ((result.finishReason as string | null) ?? null),
    modelVersion: modelVersion ?? ((result.modelVersion as string | null | undefined) ?? null),
    serviceTier: (result.serviceTierHeader as string | null | undefined) ?? (usage && typeof usage.serviceTier === 'string' ? usage.serviceTier : null),
    firstTextMs: (result.firstTextMs as number | null) ?? null,
    firstParagraphMs,
    totalMs: (result.totalMs as number | null) ?? null,
  };
}

function viaWorker(dir: string): Row {
  const timeline = JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as {
    firstDeltaAt: number | null;
    endAt: number | null;
    meta: { model?: string } | null;
    done: { timing?: Record<string, number | null> } | null;
    timeline: { ms: number; events: string[] }[];
  };
  // 按到达顺序回放 Worker 的 delta 事件，和网络分块的时间对上
  const parser = new SseParser();
  const deltas = parser.push(readFileSync(join(dir, 'raw.sse'), 'utf8')).filter((m) => m.event === 'delta');
  let index = 0;
  let markdown = '';
  let firstParagraphMs: number | null = null;
  for (const chunk of timeline.timeline) {
    for (const event of chunk.events) {
      if (event !== 'delta') continue;
      markdown += (JSON.parse(deltas[index++]?.data ?? '{"text":""}') as { text: string }).text;
      if (firstParagraphMs === null && hasReadableParagraph(markdown)) firstParagraphMs = chunk.ms;
    }
  }
  return {
    run: basename(dir),
    kind: '经 Worker',
    model: timeline.meta?.model ?? '未知',
    thinking: '未知',
    input: null,
    thoughts: null,
    output: null,
    cached: null,
    finishReason: timeline.done ? 'STOP' : null,
    modelVersion: null,
    serviceTier: null,
    firstTextMs: timeline.firstDeltaAt,
    firstParagraphMs,
    totalMs: timeline.endAt,
  };
}

const rows: Row[] = [];
for (const dir of process.argv.slice(2)) {
  if (existsSync(join(dir, 'result.json'))) rows.push(direct(dir));
  else if (existsSync(join(dir, 'timeline.json'))) rows.push(viaWorker(dir));
}
console.log('| 记录 | 方式 | 模型 | 思考 | 输入 | 思考 token | 输出 | 缓存命中 | 结束原因 | 模型版本 | 服务档 | 首个文本 | 首个可读段落 | 全文 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(
    `| ${r.run} | ${r.kind} | ${r.model} | ${r.thinking} | ${show(r.input)} | ${show(r.thoughts)} | ${show(r.output)} | ${show(r.cached)} | ${show(r.finishReason)} | ${show(r.modelVersion)} | ${show(r.serviceTier)} | ${show(r.firstTextMs)} | ${show(r.firstParagraphMs)} | ${show(r.totalMs)} |`,
  );
}
