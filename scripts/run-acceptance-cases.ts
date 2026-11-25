/**
 * 按案例编号跑补充验收：从 test/fixtures/additional-real-videos.json（V 开头）和
 * test/fixtures/additional-semantic.json（R 开头）取链接和生成要求，逐个调用 stream-probe，输出到 <输出目录>/<案例>/。
 *   tsx scripts/run-acceptance-cases.ts <站点地址> <输出目录> <案例编号…>
 *
 * 会真实调用 Gemini，产生费用。语义案例的站点必须是 YOUTUBE_PLAYER_URL 指向 test/harness/serve-semantic-fixtures.ts
 * 的本地 Worker；真实视频用线上地址或直连 YouTube 的本地 Worker。案例之间串行，不并发。
 * 结果需要人工通读并回字幕核对（检查点在夹具的 checks / requiredFacts / prohibitedChanges 里）。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Case {
  id: string;
  url: string;
  instructions: string;
}

const [base, outDir, ...ids] = process.argv.slice(2);
if (!base || !outDir || ids.length === 0) {
  console.error('用法：tsx scripts/run-acceptance-cases.ts <站点地址> <输出目录> <案例编号…>');
  process.exit(2);
}

const root = join(import.meta.dirname, '..');
const real = JSON.parse(readFileSync(join(root, 'test/fixtures/additional-real-videos.json'), 'utf8')) as { cases: { id: string; url: string; instructions: string }[] };
const semantic = JSON.parse(readFileSync(join(root, 'test/fixtures/additional-semantic.json'), 'utf8')) as { cases: { id: string; videoId: string; instructions: string }[] };
const cases = new Map<string, Case>([
  ...real.cases.map((c) => [c.id, { id: c.id, url: c.url, instructions: c.instructions }] as const),
  ...semantic.cases.map((c) => [c.id, { id: c.id, url: `https://www.youtube.com/watch?v=${c.videoId}`, instructions: c.instructions }] as const),
]);

let failed = 0;
for (const id of ids) {
  const c = cases.get(id);
  if (!c) {
    console.error(`没有案例 ${id}`);
    failed++;
    continue;
  }
  console.log(`== ${id} ${c.url}`);
  const run = spawnSync('npx', ['tsx', join(root, 'scripts/stream-probe.ts'), base, c.url, c.instructions, '--out', join(outDir, id)], { stdio: 'inherit' });
  if (run.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
