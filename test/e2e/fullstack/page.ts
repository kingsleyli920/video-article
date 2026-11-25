/**
 * L5 全栈（受控上游）用的页面助手：用户操作（填表、生成、点 5W1H）和只读的观测记录。
 * 观测只在测试里注入（包装 TextDecoder、MutationObserver、监听请求），不改应用代码。
 */
import type { Locator, Page } from '@playwright/test';

/** 模拟上游里默认可用的视频（不是内置备份的示例视频，取不到字幕就直接报错） */
export const VIDEO_URL = 'https://www.youtube.com/watch?v=mockvideo01';

/** 默认视频的状态条附注（标题 · 字幕类型 · 来源） */
export const VIDEO_SOURCE = '受控上游测试视频 · 自动生成字幕（en）· 来源：YouTube 实时获取';

interface ArticleSample {
  t: number;
  state: string;
  len: number;
  toggles: number;
  enabledToggles: number;
}

type ObservedWindow = Window & { __fsSse: string[]; __fsArticle: ArticleSample[] };

/** 在页面脚本运行前包装 TextDecoder，记录浏览器解码的每个响应分块，用来取 SSE meta 里的 generationId（页面上不显示它）。 */
export async function recordSse(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as ObservedWindow;
    w.__fsSse = [];
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (this: TextDecoder, input?: AllowSharedBufferSource, options?: TextDecodeOptions) {
      const text = decode.call(this, input, options);
      if (text) w.__fsSse.push(text);
      return text;
    };
  });
}

/** 本页面各次生成的 generationId（按 SSE meta 事件的先后） */
export async function sseGenerationIds(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => (window as unknown as ObservedWindow).__fsSse.join(''));
  return [...text.matchAll(/"generationId":"([^"]+)"/g)].map((m) => m[1]!);
}

/** 在 #article 上挂 MutationObserver：每次重绘记下时间、状态、正文长度和 5W1H 按钮的可点数量 */
export async function recordArticle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.getElementById('article')!;
    const log: ArticleSample[] = [];
    (window as unknown as ObservedWindow).__fsArticle = log;
    new MutationObserver(() => {
      log.push({
        t: performance.now(),
        state: root.dataset.state ?? '',
        len: (root.textContent ?? '').length,
        toggles: root.querySelectorAll('.summary-toggle').length,
        enabledToggles: root.querySelectorAll('.summary-toggle:not(:disabled)').length,
      });
    }).observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-state'] });
  });
}

export async function articleLog(page: Page): Promise<ArticleSample[]> {
  return page.evaluate(() => (window as unknown as ObservedWindow).__fsArticle);
}

export interface SummaryRequest {
  method: string;
  path: string;
  body: string | null;
}

/** 记录浏览器发出的 5W1H 请求（方法、路径、请求体） */
export function recordSummaryRequests(page: Page): SummaryRequest[] {
  const list: SummaryRequest[] = [];
  page.on('request', (req) => {
    const { pathname } = new URL(req.url());
    if (pathname.endsWith('/summary')) list.push({ method: req.method(), path: pathname, body: req.postData() });
  });
  return list;
}

/** 像用户一样填链接和生成要求，点"生成文章" */
export async function fillAndGenerate(page: Page, url: string, instructions = ''): Promise<void> {
  await page.getByLabel('YouTube 链接').fill(url);
  await page.getByLabel('生成要求').fill(instructions);
  await page.getByRole('button', { name: '生成文章' }).click();
}

export function chapter(page: Page, id: string): Locator {
  return page.locator(`#article section.chapter[data-chapter-id="${id}"]`);
}

/** 章节标题旁的 5W1H 按钮（按无障碍名称找，名称是"章节标题：5W1H 总结"） */
export function summaryToggle(page: Page, chapterTitle: string): Locator {
  return page.getByRole('button', { name: `${chapterTitle}：5W1H 总结`, exact: true });
}

/** 5W1H 表格的 [表头, 内容] 行 */
export async function summaryRows(section: Locator): Promise<[string, string][]> {
  return section
    .locator('.summary-table tr')
    .evaluateAll((trs) => trs.map((tr) => [tr.querySelector('th')?.textContent ?? '', tr.querySelector('td')?.textContent ?? ''] as [string, string]));
}

/** 状态条的主文案（不含附注小字和按钮） */
export async function statusMessage(page: Page): Promise<string> {
  return page.locator('#status .status-text').evaluate((el) => el.firstChild?.textContent ?? '');
}

/** 生成结束后表单应恢复可用 */
export async function controlsIdle(page: Page): Promise<{ submit: string; submitEnabled: boolean; urlEnabled: boolean; instructionsEnabled: boolean; sampleEnabled: boolean; stopVisible: boolean }> {
  const submit = page.locator('#submit');
  return {
    submit: (await submit.textContent()) ?? '',
    submitEnabled: await submit.isEnabled(),
    urlEnabled: await page.getByLabel('YouTube 链接').isEnabled(),
    instructionsEnabled: await page.getByLabel('生成要求').isEnabled(),
    sampleEnabled: await page.getByRole('button', { name: '填入示例视频' }).isEnabled(),
    stopVisible: await page.getByRole('button', { name: '停止生成' }).isVisible(),
  };
}

export const IDLE_CONTROLS = { submit: '生成文章', submitEnabled: true, urlEnabled: true, instructionsEnabled: true, sampleEnabled: true, stopVisible: false };
