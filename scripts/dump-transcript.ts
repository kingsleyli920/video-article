/**
 * 把一个视频交给模型的输入存下来：整理后的字幕正文（prepared.txt）和视频元数据（meta.json）。
 * 用生产的字幕模块从本机直连 YouTube，不调用模型。给离线核对探针（review-probe.ts）准备输入。
 *   tsx scripts/dump-transcript.ts <输出目录> <视频 ID…>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchTranscript, prepareTranscript } from '../src/worker/youtube';

const [outDir, ...ids] = process.argv.slice(2);
if (!outDir || ids.length === 0) {
  console.error('用法：tsx scripts/dump-transcript.ts <输出目录> <视频 ID…>');
  process.exit(2);
}
for (const id of ids) {
  const transcript = await fetchTranscript(id);
  const prepared = prepareTranscript(transcript.cues);
  const dir = join(outDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prepared.txt'), prepared.text);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ video: transcript.video, language: transcript.language, kind: transcript.kind, damagedNumbers: prepared.damagedNumbers }, null, 2));
  console.log(`${id} ${transcript.language} ${transcript.kind} ${prepared.text.length} 字符`);
}
