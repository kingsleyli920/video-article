/**
 * L5 全栈（受控上游）：主流程和第二次生成。真实浏览器 + 真实 wrangler dev（workerd + SQLite Durable Object），
 * 只有 YouTube 和 Gemini 是模拟上游。所有操作都走页面；上游实际收到的请求从模拟上游的记录核对。
 */
import { expect, test } from '@playwright/test';
import {
  articleLog,
  chapter,
  controlsIdle,
  fillAndGenerate,
  IDLE_CONTROLS,
  recordArticle,
  recordSse,
  recordSummaryRequests,
  sseGenerationIds,
  statusMessage,
  summaryRows,
  summaryToggle,
  SOURCE_ROWS,
  SOURCE_SNIPPETS,
  sourceRows,
  VIDEO_URL,
} from './page';
import { promptOf, requestsOf, resetUpstream, setScenario, upstreamRequests } from './upstream';

/** 和模拟上游默认文章同样的内容，切成 7 段、每段间隔 300 毫秒 */
const SLOW_ARTICLE = [
  '# 对话测试嘉宾：受控上游\n\n',
  '## 第一章：开场\n\n',
  '**主持人:** 我们从哪里开始？\n\n',
  '**嘉宾:** 从第一个问题开始。\n\n',
  '## 第二章：数字\n\n',
  '**主持人:** 有多少项？\n\n',
  '**嘉宾:** 大约有1200项。',
];

const SECOND_ARTICLE = [
  '# 对话第二位嘉宾：新的要求\n\n',
  '## 第一章：背景\n\n**主持人:** 为什么换要求？\n\n',
  '**嘉宾:** 为了测试第二次生成。\n\n',
  '## 第二章：结论\n\n**主持人:** 结果如何？\n\n',
  '**嘉宾:** 一切正常。',
];

const NUMBER_NOTICE = '字幕 34:25 附近有一处数字残缺（原文"of,200"），文中写成了"1200"，疑似补全了残缺数字，请核对原字幕或原视频。';

test.beforeEach(async () => {
  await resetUpstream();
});

// 抓：假流式（正文在模型结束后一次性出现）、生成中 5W1H 可点、完成状态/章节/数字提示缺失或写错、5W1H 请求没带服务端保存的字幕和人物规则（或重新拉字幕、或由前端提交内容）、同章收起再展开重复请求
test('主流程：正文逐步出现 → 完成状态、章节、数字提示 → 第 2 章 5W1H 用服务端上下文，收起再展开不重复请求', async ({ page }) => {
  const instructions = '写给投资人看，语言简洁';
  await setScenario({
    streams: { 'mock-primary': { kind: 'ok', texts: SLOW_ARTICLE, intervalMs: 300 } },
    summaries: { 'mock-primary': { kind: 'ok', delayMs: 800, summary: { who: '主持人与嘉宾', what: '讨论项目数量', when: '', where: '', why: '说明规模', how: '一问一答' } } },
  });
  const summaryRequests = recordSummaryRequests(page);
  await page.goto('/');
  await recordArticle(page);
  await fillAndGenerate(page, VIDEO_URL, instructions);

  // 生成中：表单锁定，可以停止
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await expect(page.locator('#submit')).toBeDisabled();
  await expect(page.locator('#submit')).toHaveText('生成中…');
  await expect(page.getByLabel('YouTube 链接')).toBeDisabled();

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'ok', { timeout: 15_000 });

  // 流式：done 之前，页面上的正文长度在生成中状态下至少增长两次；生成中出现过章节，但 5W1H 一直不可点
  const log = await articleLog(page);
  const doneAt = log.findIndex((s) => s.state === 'done');
  expect(doneAt).toBeGreaterThan(0);
  const streaming = log.slice(0, doneAt).filter((s) => s.state === 'streaming');
  const lengths = [...new Set(streaming.map((s) => s.len))];
  expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  expect(lengths.length - 1).toBeGreaterThanOrEqual(2);
  expect(streaming.some((s) => s.toggles > 0)).toBe(true);
  expect(streaming.every((s) => s.enabledToggles === 0)).toBe(true);
  console.log(`生成中的正文长度：${lengths.join(' → ')}；完成时 ${log[doneAt]!.len}`);

  // 完成：状态条、标题、章节、标题下方的数字提示，5W1H 可点，表单恢复
  expect(await statusMessage(page)).toMatch(/^已完成，共 2 章、68 字，用时 \d+ 秒。已对照字幕核对。文中有 1 处疑似补全了残缺数字，见标题下方的提示。点击章节标题旁的 5W1H 查看总结。$/);
  // 来源信息在状态条下方的面板里，状态条不再附带来源；结束后面板保留
  await expect(status.locator('.status-detail')).toHaveCount(0);
  expect(await sourceRows(page)).toEqual(SOURCE_ROWS);
  // 字幕原文片段来自真实 Worker 的 meta：默认收起，展开后是原始字幕（残缺数字原样，不是给模型的遮蔽版本）
  const preview = page.locator('#source details');
  await expect(preview.locator('summary')).toHaveText('字幕原文片段（节选 3 段，自动生成字幕可能有识别错误）');
  await expect(preview.locator('li').first()).toBeHidden();
  await preview.locator('summary').click();
  await expect(preview.locator('li')).toHaveText(SOURCE_SNIPPETS);
  await expect(page.locator('#article h1')).toHaveText('对话测试嘉宾：受控上游');
  await expect(page.locator('#article h2')).toHaveText(['第一章：开场', '第二章：数字']);
  await expect(page.locator('#article > h1 + .article-notice')).toHaveText(NUMBER_NOTICE);
  await expect(page.locator('#article .caret')).toHaveCount(0);
  await expect(summaryToggle(page, '第一章：开场')).toBeEnabled();
  await expect(summaryToggle(page, '第二章：数字')).toBeEnabled();
  await expect.poll(() => controlsIdle(page)).toEqual(IDLE_CONTROLS);

  // 点第 2 章 5W1H：先显示加载中，再出现固定六行的表格；空值显示"原文未明确提及"
  const second = chapter(page, '2');
  const toggle = summaryToggle(page, '第二章：数字');
  await toggle.click();
  await expect(second.locator('.summary-loading')).toHaveText('正在生成 5W1H 总结…');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(second.locator('.summary-table tr')).toHaveCount(6);
  expect(await summaryRows(second)).toEqual([
    ['Who', '主持人与嘉宾'],
    ['What', '讨论项目数量'],
    ['When', '原文未明确提及'],
    ['Where', '原文未明确提及'],
    ['Why', '说明规模'],
    ['How', '一问一答'],
  ]);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).not.toHaveAttribute('aria-busy');
  await expect(chapter(page, '1').locator('.summary-panel')).toBeHidden();

  // 浏览器只发了路径（generationId + 章节 id），没有请求体
  expect(summaryRequests).toHaveLength(1);
  expect(summaryRequests[0]!.method).toBe('POST');
  expect(summaryRequests[0]!.path).toMatch(/^\/api\/generations\/[0-9a-f]{64}\/chapters\/2\/summary$/);
  expect(summaryRequests[0]!.body).toBeNull();

  // 上游：字幕只在生成时取了一次；5W1H 请求里的字幕、简介、用户要求和章节都来自服务端保存的上下文，系统提示带人物规则全文
  // 有生成要求时，约束提取和写文章同时开始（两者到达上游的先后不固定，所以单独数）；文章写完后两章各核对一次，然后才是 5W1H
  const upstream = await upstreamRequests();
  expect(upstream.filter((r) => r.kind !== 'requirements').map((r) => r.kind)).toEqual(['player', 'captions', 'stream', 'review', 'review', 'review', 'summary']);
  expect(upstream.filter((r) => r.kind === 'requirements')).toHaveLength(1);
  const summaryRequest = upstream.find((r) => r.kind === 'summary');
  const { system, user, config } = promptOf(summaryRequest);
  expect(summaryRequest!.model).toBe('mock-primary');
  expect(system).toContain('人物身份与发言归属：');
  expect(system).toContain('依据不足时，提问写"主持人"，回答写"嘉宾"（单人演讲写"演讲者"）');
  expect(system).toContain('who 字段同样遵守上面的人物规则');
  expect(user).toContain("[00:00] welcome to the show Alex here let us start with the first question\n\n[34:25] >> we're tracking on the order of〔字幕此处数字不清，无法确定具体数量〕 bills");
  expect(user).not.toContain(',200');
  expect(user).toContain('本期主持人 Alex Chen');
  expect(user).toContain(`\n写给投资人看，语言简洁\n</user_requirements>`);
  expect(user).toContain('<article_outline>\n1. 第一章：开场\n2. 第二章：数字\n</article_outline>');
  expect(user).toContain('<current_chapter id="2">\n## 第二章：数字\n\n**主持人:** 有多少项？\n\n**嘉宾:** 大约有1200项。\n</current_chapter>');
  expect(config.responseMimeType).toBe('application/json');
  // 生成请求同样带上了用户要求
  expect(promptOf(upstream.find((r) => r.kind === 'stream')).user).toContain(`<user_requirements>\n写给投资人看，语言简洁\n</user_requirements>`);

  // 同一章收起再展开：只切换显示，不重新请求（加载中状态不再出现）
  await toggle.click();
  await expect(second.locator('.summary-panel')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(second.locator('.summary-panel')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(second.locator('.summary-loading')).toHaveCount(0);
  await expect(second.locator('.summary-table tr')).toHaveCount(6);
  await page.waitForTimeout(500); // 给可能的重复请求留出到达上游的时间
  expect(summaryRequests).toHaveLength(1);
  expect(await requestsOf('summary')).toHaveLength(1);
});

// 抓：第二次生成残留旧文章、旧数字提示、旧 5W1H 面板；旧的 5W1H 点击绑定没解除（新面板收不起来、点新文章仍带旧 generationId 发请求）；新文章的 5W1H 读到上一次的上下文
test('第二次生成：换生成要求再生成，旧文章、旧提示、旧 5W1H 面板消失，新的 5W1H 请求用新的 generationId', async ({ page }) => {
  await setScenario({ summaries: { 'mock-primary': { kind: 'ok', summary: { who: '第一次的人物', what: '第一次的事情', when: '', where: '', why: '', how: '' } } } });
  await recordSse(page);
  const summaryRequests = recordSummaryRequests(page);
  await page.goto('/');

  // 第一次：默认文章（含残缺数字提示），打开第 2 章 5W1H
  await fillAndGenerate(page, VIDEO_URL, '第一次的要求：写给学生');
  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'ok', { timeout: 15_000 });
  await expect(page.locator('#article .article-notice')).toHaveText(NUMBER_NOTICE);
  await summaryToggle(page, '第二章：数字').click();
  await expect(chapter(page, '2').locator('.summary-table tr')).toHaveCount(6);
  await expect.poll(() => controlsIdle(page)).toEqual(IDLE_CONTROLS);

  // 第二次：换生成要求，上游换一篇没有数字的文章和另一份总结
  await setScenario({
    streams: { 'mock-primary': { kind: 'ok', texts: SECOND_ARTICLE, intervalMs: 300 } },
    summaries: { 'mock-primary': { kind: 'ok', summary: { who: '第二位嘉宾', what: '第二次生成的结论', when: '', where: '', why: '验证换要求', how: '' } } },
  });
  await page.getByLabel('生成要求').fill('第二次的要求：写给投资人');
  await page.getByRole('button', { name: '生成文章' }).click();

  // 生成中：旧标题、旧提示、旧表格已经清掉
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await expect(page.locator('#article')).not.toContainText('受控上游');
  await expect(page.locator('#article .article-notice')).toHaveCount(0);
  await expect(page.locator('#article .summary-table')).toHaveCount(0);

  await expect(status).toHaveAttribute('data-tone', 'ok', { timeout: 15_000 });
  expect(await statusMessage(page)).toMatch(/^已完成，共 2 章、65 字，用时 \d+ 秒。已对照字幕核对。点击章节标题旁的 5W1H 查看总结。$/);
  await expect(page.locator('#article h1')).toHaveText('对话第二位嘉宾：新的要求');
  await expect(page.locator('#article h2')).toHaveText(['第一章：背景', '第二章：结论']);
  await expect(page.locator('#article .article-notice')).toHaveCount(0);
  await expect(page.locator('#article .summary-table')).toHaveCount(0);
  await expect(page.locator('#article .summary-panel:visible')).toHaveCount(0);
  const toggle = summaryToggle(page, '第二章：结论');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // 新文章第 2 章的 5W1H：发新请求，表格是第二份总结
  await toggle.click();
  const second = chapter(page, '2');
  await expect(second.locator('.summary-table tr')).toHaveCount(6);
  expect(await summaryRows(second)).toEqual([
    ['Who', '第二位嘉宾'],
    ['What', '第二次生成的结论'],
    ['When', '原文未明确提及'],
    ['Where', '原文未明确提及'],
    ['Why', '验证换要求'],
    ['How', '原文未明确提及'],
  ]);

  // 旧绑定若没解除，会和新绑定同时响应：收起时被翻转两次（面板仍显示），点第 1 章时还会带旧 generationId 再发一次请求
  await toggle.click();
  await expect(second.locator('.summary-panel')).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await summaryToggle(page, '第一章：背景').click();
  await expect(chapter(page, '1').locator('.summary-table tr')).toHaveCount(6);
  await page.waitForTimeout(500); // 给可能的多余请求留出发出的时间

  // 请求路径里的 generationId：两次生成各一个且不同，分别和各自 SSE meta 里的一致；第二次生成后的请求全部用新的
  const ids = await sseGenerationIds(page);
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
  expect(ids[0]).not.toBe(ids[1]);
  expect(summaryRequests.map((r) => r.path)).toEqual([
    `/api/generations/${ids[0]}/chapters/2/summary`,
    `/api/generations/${ids[1]}/chapters/2/summary`,
    `/api/generations/${ids[1]}/chapters/1/summary`,
  ]);

  // 上游：第二次的生成请求和 5W1H 请求都用第二次的要求和新文章
  const streams = await requestsOf('stream');
  expect(streams).toHaveLength(2);
  expect(promptOf(streams[1]).user).toContain('<user_requirements>\n第二次的要求：写给投资人\n</user_requirements>');
  const summaries = await requestsOf('summary');
  expect(summaries).toHaveLength(3);
  const { user } = promptOf(summaries[1]);
  expect(user).toContain('\n第二次的要求：写给投资人\n</user_requirements>');
  expect(user).not.toContain('第一次的要求');
  expect(user).toContain('<current_chapter id="2">\n## 第二章：结论\n\n**主持人:** 结果如何？\n\n**嘉宾:** 一切正常。\n</current_chapter>');
});
