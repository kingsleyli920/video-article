/**
 * 用 Worker 里同一个字幕模块直连 YouTube，把真实字幕存成内置备份，并记录来源。
 *   npm run transcript:fetch -- <videoId>
 */
import { writeFileSync } from 'node:fs';
import type { BackupFile } from '../src/worker/transcripts';
import { fetchTranscript } from '../src/worker/youtube';

const videoId = process.argv[2];
if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
  console.error('用法：npm run transcript:fetch -- <11 位视频 ID>');
  process.exit(2);
}

const transcript = await fetchTranscript(videoId);
const file: BackupFile = {
  source: {
    method: 'YouTube InnerTube player 接口（ANDROID 客户端）选字幕轨，再从 timedtext 拉取 fmt=srv1；与线上直连用的是同一个模块',
    fetchedAt: new Date().toISOString(),
    trackVssId: transcript.trackVssId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  },
  video: transcript.video,
  language: transcript.language,
  kind: transcript.kind,
  trackName: transcript.trackName,
  cues: transcript.cues.map((cue) => [cue.start, cue.text]),
};

// 元数据按缩进排版，字幕每条一行，方便审阅和比对
const { cues, ...meta } = file;
const json = JSON.stringify(meta, null, 2).replace(/\n}$/, `,\n  "cues": [\n${cues.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]\n}\n`);
const path = `src/worker/transcripts/${videoId}.json`;
writeFileSync(path, json);
console.log(`已保存 ${path}：${transcript.video.title}｜${transcript.trackName}｜${cues.length} 条字幕`);
