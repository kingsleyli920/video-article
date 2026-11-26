/**
 * 补充验收的字幕预检：用生产的字幕模块（fetchTranscript + prepareTranscript）直连 YouTube，不调用模型。
 *   tsx scripts/preflight-videos.ts <输出目录> <videoId…>
 *
 * 每个视频记录：实际标题、频道、时长、全部字幕轨、选中轨的语言和类型（人工 / 自动识别）、是否翻译轨、
 * 抓取结果或失败原因（无字幕、被拦截、视频不可用、超时、网络错误）、原始字幕和整理后文本的字符数与 SHA-256、
 * 是否超过整理后字符上限、代码版本。原始字幕和整理后文本另存文件。
 *
 * 注意：这里是本机出口直连 YouTube，不是 Cloudflare 出口；线上 Worker 能否取到要另外验证。
 * 字幕轨列表是在脚本里旁路记录播放器接口的响应得到的，生产代码本身不改；被拦后换客户端重试时记录的是最后一次的响应。
 * attempts 是生产代码返回的每次尝试（客户端、结果、耗时）。
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../src/shared/limits';
import { AppError } from '../src/worker/app-error';
import { fetchTranscript, prepareTranscript, TranscriptError, type CaptionTrack, type DefaultAudio } from '../src/worker/youtube';

const [outDir, ...ids] = process.argv.slice(2);
if (!outDir || ids.length === 0 || !ids.every((id) => /^[A-Za-z0-9_-]{11}$/.test(id))) {
  console.error('用法：tsx scripts/preflight-videos.ts <输出目录> <11 位视频 ID…>');
  process.exit(2);
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const commit = execSync('git rev-parse --short HEAD').toString().trim();
const dirty = execSync('git status --porcelain -- src').toString().trim() !== '';

// 旁路记录播放器接口返回的字幕轨和视频信息
interface SeenPlayer {
  status?: string;
  reason?: string;
  tracks: CaptionTrack[];
  audio: DefaultAudio | null;
  details: Record<string, unknown>;
}
const seen: { player: SeenPlayer | null } = { player: null };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  if (String(input).includes('/youtubei/v1/player')) {
    const body = (await res.clone().json().catch(() => null)) as {
      playabilityStatus?: { status?: string; reason?: string };
      videoDetails?: Record<string, unknown>;
      captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[]; audioTracks?: DefaultAudio[]; defaultAudioTrackIndex?: number } };
    } | null;
    const renderer = body?.captions?.playerCaptionsTracklistRenderer;
    const audio = renderer?.audioTracks?.[renderer.defaultAudioTrackIndex ?? 0];
    seen.player = {
      status: body?.playabilityStatus?.status,
      reason: body?.playabilityStatus?.reason,
      tracks: renderer?.captionTracks ?? [],
      audio: audio ? { audioTrackId: audio.audioTrackId, defaultCaptionTrackIndex: audio.defaultCaptionTrackIndex } : null,
      details: body?.videoDetails ?? {},
    };
  }
  return res;
};

const rows: Record<string, unknown>[] = [];
for (const id of ids) {
  seen.player = null;
  const dir = join(outDir, id);
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  let row: Record<string, unknown>;
  try {
    const transcript = await fetchTranscript(id);
    const prepared = prepareTranscript(transcript.cues);
    const rawJson = JSON.stringify(transcript.cues.map((c) => [c.start, c.text]));
    const rawChars = transcript.cues.reduce((n, c) => n + c.text.length, 0);
    const player = seen.player as SeenPlayer | null;
    const chosen = player?.tracks.find((t) => (t.vssId ?? '') === transcript.trackVssId && t.languageCode === transcript.language);
    writeFileSync(join(dir, 'raw-cues.json'), rawJson);
    writeFileSync(join(dir, 'prepared.txt'), prepared.text);
    row = {
      id,
      result: 'ok',
      attempts: transcript.attempts,
      title: transcript.video.title,
      channel: transcript.video.channel,
      lengthSeconds: transcript.video.lengthSeconds,
      defaultAudio: player?.audio ?? null,
      tracks: (player?.tracks ?? []).map((t) => ({ languageCode: t.languageCode, kind: t.kind ?? 'manual', vssId: t.vssId ?? null, name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? null, variant: new URL(t.baseUrl).searchParams.get('variant'), translated: /[?&]tlang=/.test(t.baseUrl) })),
      selected: { language: transcript.language, kind: transcript.kind, trackName: transcript.trackName, vssId: transcript.trackVssId, variant: chosen ? new URL(chosen.baseUrl).searchParams.get('variant') : null, translated: chosen ? /[?&]tlang=/.test(chosen.baseUrl) : null },
      cues: transcript.cues.length,
      rawChars,
      rawSha256: sha256(rawJson),
      preparedChars: prepared.text.length,
      preparedSha256: sha256(prepared.text),
      damagedNumbers: prepared.damagedNumbers.map((d) => `${d.time} ${d.fragment}`),
      overLimit: prepared.text.length > LIMITS.transcriptChars,
      limit: LIMITS.transcriptChars,
    };
  } catch (err) {
    const player = seen.player as SeenPlayer | null;
    const code = err instanceof AppError ? err.code : 'unknown';
    row = {
      id,
      result: 'failed',
      errorCode: code,
      errorDetail: err instanceof AppError ? (err.detail ?? null) : String(err),
      attempts: err instanceof TranscriptError ? err.attempts : null,
      playability: player ? { status: player.status ?? null, reason: player.reason ?? null } : null,
      title: (player?.details.title as string | undefined) ?? null,
      lengthSeconds: player?.details.lengthSeconds ? Number(player.details.lengthSeconds) : null,
      defaultAudio: player?.audio ?? null,
      tracks: (player?.tracks ?? []).map((t) => ({ languageCode: t.languageCode, kind: t.kind ?? 'manual', vssId: t.vssId ?? null, variant: new URL(t.baseUrl).searchParams.get('variant') })),
    };
  }
  row = { ...row, fetchedAt: startedAt, ms: Math.round(performance.now() - t0), egress: '本机直连（非 Cloudflare 出口）', code: `${commit}${dirty ? '（src 有未提交改动）' : ''}` };
  writeFileSync(join(dir, 'preflight.json'), JSON.stringify(row, null, 2));
  rows.push(row);
  const sel = row.selected as { language: string; kind: string } | undefined;
  console.log(
    row.result === 'ok'
      ? `✓ ${id} ${row.title} | ${row.lengthSeconds}s | ${sel!.language} ${sel!.kind} | 整理后 ${row.preparedChars} 字符${row.overLimit ? '（超上限）' : ''} | 轨道 ${(row.tracks as unknown[]).length} 条`
      : `✗ ${id} ${row.errorCode}：${row.errorDetail}`,
  );
  await new Promise((r) => setTimeout(r, 1_500));
}
writeFileSync(join(outDir, 'preflight-summary.json'), JSON.stringify(rows, null, 2));
