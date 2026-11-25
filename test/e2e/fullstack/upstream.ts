/**
 * L5 全栈（受控上游）用的模拟上游管理助手：设场景、清空记录、读 Worker 实际发给上游的请求。
 * 地址用 MOCK_UPSTREAM_PORT 拼，和 playwright.config.ts 里 webServer 启动的模拟上游一致（默认 8790）。
 * 模拟上游是全局状态，所以 fullstack 项目只能单 worker 串行跑（配置里 workers: 1）。
 */
import type { RecordedRequest, Scenario } from '../../harness/mock-upstream';

export const UPSTREAM_URL = `http://127.0.0.1:${process.env.MOCK_UPSTREAM_PORT ?? 8790}`;

async function admin(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${UPSTREAM_URL}${path}`, init);
  if (!res.ok) throw new Error(`模拟上游管理接口 ${path} 返回 HTTP ${res.status}`);
  return res;
}

/** 整体替换场景：没给的顶层部分（videos / streams / summaries）用默认值；场景里没列出的模型一律 503 繁忙 */
export async function setScenario(scenario: Partial<Scenario>): Promise<void> {
  await admin('/__scenario', { method: 'PUT', body: JSON.stringify(scenario) });
}

/** 恢复默认场景并清空请求记录 */
export async function resetUpstream(): Promise<void> {
  await admin('/__reset', { method: 'POST' });
}

export async function upstreamRequests(): Promise<RecordedRequest[]> {
  return (await (await admin('/__requests')).json()) as RecordedRequest[];
}

export async function requestsOf(kind: RecordedRequest['kind']): Promise<RecordedRequest[]> {
  return (await upstreamRequests()).filter((r) => r.kind === kind);
}

/** 某类 Gemini 请求依次用到的模型名 */
export async function modelsOf(kind: 'stream' | 'summary'): Promise<(string | undefined)[]> {
  return (await requestsOf(kind)).map((r) => r.model);
}

interface GeminiPayload {
  systemInstruction?: { parts?: { text?: string }[] };
  contents?: { parts?: { text?: string }[] }[];
  generationConfig?: Record<string, unknown>;
}

/** 从记录的 Gemini 请求体里取出系统提示和用户提示 */
export function promptOf(request: RecordedRequest | undefined): { system: string; user: string; config: Record<string, unknown> } {
  if (!request) throw new Error('没有这条上游请求');
  const body = request.body as GeminiPayload;
  return {
    system: body.systemInstruction?.parts?.[0]?.text ?? '',
    user: body.contents?.[0]?.parts?.[0]?.text ?? '',
    config: body.generationConfig ?? {},
  };
}
