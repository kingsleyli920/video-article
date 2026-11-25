/**
 * 补充验收用的字幕替身：只替代 YouTube（播放器接口和 timedtext），字幕来自 test/fixtures/additional-semantic.json。
 * 配合 wrangler dev --var YOUTUBE_PLAYER_URL:http://127.0.0.1:<端口>/youtube/player 使用；Gemini 仍是真实接口。
 *   tsx test/harness/serve-semantic-fixtures.ts [端口，默认 8796]
 * 字幕按 YouTube srv1 的方式做两层转义（"<" 写成 "&amp;lt;"），和线上取到的字幕走同样的解码。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMockUpstream, type VideoScenario } from './mock-upstream';

const port = Number(process.argv[2] ?? 8796);
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/additional-semantic.json'), 'utf8')) as {
  cases: { id: string; videoId: string; title: string; channel: string; description: string; cues: [number, string][] }[];
};
const escapeTwice = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/&/g, '&amp;');

const upstream = await startMockUpstream(port);
const videos: Record<string, VideoScenario> = {};
for (const c of fixture.cases) {
  videos[c.videoId] = { kind: 'ok', title: c.title, channel: c.channel, description: c.description, cues: c.cues.map(([s, t]) => [s, escapeTwice(t)]) };
}
const res = await fetch(`${upstream.url}/__scenario`, { method: 'PUT', body: JSON.stringify({ videos }) });
if (!res.ok) throw new Error(`设置场景失败：${res.status}`);
console.log(`字幕替身就绪：${upstream.url}/youtube/player，${fixture.cases.length} 个案例`);
process.on('SIGTERM', () => void upstream.close().then(() => process.exit(0)));
process.on('SIGINT', () => void upstream.close().then(() => process.exit(0)));
