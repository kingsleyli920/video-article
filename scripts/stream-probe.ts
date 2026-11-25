/**
 * 流式验证探针：对本地或线上地址发起一次真实生成，按网络分块记录到达时间，
 * 把"第一段正文到达客户端的时间"和服务端回报的"模型结束时间"放在一起比较。
 *   tsx scripts/stream-probe.ts <站点地址> <YouTube 链接> [生成要求] [--out 目录]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SseParser } from '../src/shared/sse';
import type { StreamEvents } from '../src/shared/types';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? args.splice(outIndex, 2)[1] : undefined;
const [base, url, instructions = ''] = args;
if (!base || !url) {
  console.error('用法：tsx scripts/stream-probe.ts <站点地址> <YouTube 链接> [生成要求] [--out 目录]');
  process.exit(2);
}

const t0 = performance.now();
const at = () => Math.round(performance.now() - t0);
const res = await fetch(new URL('/api/generations', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url, instructions }),
});
const headersAt = at();
console.log(`HTTP ${res.status} ${res.headers.get('content-type')}，响应头到达 ${headersAt} ms`);
if (!res.ok || !res.body) {
  console.log(await res.text());
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
const parser = new SseParser();
const timeline: { ms: number; bytes: number; events: string[] }[] = [];
const growth: [number, number][] = [];
let markdown = '';
let firstDeltaAt: number | null = null;
let lastDeltaAt: number | null = null;
let deltaEvents = 0;
let meta: StreamEvents['meta'] | null = null;
let done: StreamEvents['done'] | null = null;
let failure: StreamEvents['error'] | null = null;

for (;;) {
  const { done: end, value } = await reader.read();
  if (end) break;
  const ms = at();
  const messages = parser.push(decoder.decode(value, { stream: true }));
  timeline.push({ ms, bytes: value.byteLength, events: messages.map((m) => m.event) });
  for (const message of messages) {
    const data = JSON.parse(message.data);
    if (message.event === 'meta') meta = data;
    if (message.event === 'done') done = data;
    if (message.event === 'error') failure = data;
    if (message.event === 'delta') {
      markdown += (data as StreamEvents['delta']).text;
      deltaEvents++;
      firstDeltaAt ??= ms;
      lastDeltaAt = ms;
    }
  }
  if (messages.some((m) => m.event === 'delta')) growth.push([ms, markdown.length]);
}
const endAt = at();

console.log(`字幕来源：${meta?.transcript.source}（${meta?.transcript.kind}，${meta?.transcript.chars} 字符），模型：${meta?.model}`);
console.log(`网络分块 ${timeline.length} 个，delta 事件 ${deltaEvents} 个，正文 ${markdown.length} 字符`);
console.log(`客户端：第一段正文 ${firstDeltaAt} ms，最后一段正文 ${lastDeltaAt} ms，流结束 ${endAt} ms`);
if (done) {
  const t = done.timing;
  console.log(`服务端：字幕就绪 ${t.transcriptMs} ms，模型首个 token ${t.firstTokenMs} ms，模型结束 ${t.modelDoneMs} ms，保存完成 ${t.savedMs} ms`);
  console.log(`结果：done，共 ${done.chapters.length} 章`);
  if (firstDeltaAt !== null) console.log(`第一段正文比模型结束早到 ${t.modelDoneMs - firstDeltaAt} ms`);
} else {
  console.log(`结果：${failure ? `error ${failure.code}：${failure.message}` : '没有收到 done 或 error'}`);
}
const step = Math.max(1, Math.floor(growth.length / 12));
console.log('正文增长（毫秒 → 字符数）：' + growth.filter((_, i) => i % step === 0 || i === growth.length - 1).map(([ms, n]) => `${ms}→${n}`).join('  '));

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'article.md'), markdown);
  writeFileSync(join(outDir, 'timeline.json'), JSON.stringify({ headersAt, firstDeltaAt, lastDeltaAt, endAt, meta, done, failure, timeline }, null, 2));
  console.log(`已写入 ${outDir}/article.md 和 timeline.json`);
}
