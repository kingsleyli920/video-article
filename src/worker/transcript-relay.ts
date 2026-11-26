import { DurableObject } from 'cloudflare:workers';
import { toAppError } from './app-error';
import { timeoutScale, transcriptOptions } from './config';
import { RELAY_TIMEOUT_MS, type LoadOptions, type RelayResult, type TranscriptRelay as Relay } from './transcripts';
import { fetchTranscript, TranscriptError } from './youtube';

/**
 * 代取字幕的区域，按实测成功率从高到低，只试前 3 个。
 * 依据 2026-11-25 实测：同一时刻从四个区域的 Durable Object 发同样的请求（实际落在 DEN / MIA / CDG / SIN），
 * 184 轮里 wnam、enam 全部成功，apac 时好时坏，weur 全部被人机验证拦住，所以不用 weur。
 * enam 和 wnam 都没失败过，谁先谁后实测分不出来，按需求给定的顺序 enam 在前。
 */
const RELAY_REGIONS = ['enam', 'wnam', 'apac'] as const satisfies readonly DurableObjectLocationHint[];

/**
 * 在自己所在的区域取字幕，供本地出口被人机验证拦住时代取。每个区域一个固定名字的对象（relay-enam 等），
 * 首次创建时按 locationHint 建在那个区域，之后一直留在那里，出站请求走那个区域的出口。不存任何数据。
 */
export class TranscriptRelay extends DurableObject<Env> {
  async relay(videoId: string): Promise<RelayResult> {
    try {
      return { ok: true, transcript: await fetchTranscript(videoId, transcriptOptions(this.env)) };
    } catch (err) {
      const error = toAppError(err);
      if (error.code === 'internal') console.error(err);
      return { ok: false, code: error.code, ...(error.detail ? { detail: error.detail } : {}), attempts: err instanceof TranscriptError ? err.attempts : [] };
    }
  }
}

/** loadTranscript 换区域要用的选项：各区域的代取入口和每个区域的上限（测试时按 TIMEOUT_SCALE 缩短） */
export function relayOptions(env: Env): Pick<LoadOptions, 'relays' | 'relayTimeoutMs'> {
  const relays: Relay[] = RELAY_REGIONS.map((region) => ({
    region,
    fetch: (videoId) => env.TRANSCRIPT_RELAY.get(env.TRANSCRIPT_RELAY.idFromName(`relay-${region}`), { locationHint: region }).relay(videoId),
  }));
  return { relays, relayTimeoutMs: RELAY_TIMEOUT_MS * timeoutScale(env) };
}
