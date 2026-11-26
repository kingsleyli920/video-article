import {
  FALLBACK_MODEL,
  FIXED_TIME,
  SAMPLE_URL,
  WARNINGS,
  done,
  expect,
  generationEvents,
  meta,
  sourceRows,
  sseReply,
  statusMain,
  test,
} from './api-mock';

test.beforeEach(async ({ page }) => {
  // Date.now 固定，状态条里的用时稳定为 0 秒；计时器照常运行
  await page.clock.setFixedTime(FIXED_TIME);
});

// 抓：请求体漏带或没去掉首尾空白的生成要求；文章、章节、5W1H 按钮、完成状态、数字提示位置任一处渲染错误
test('输入链接和生成要求后提交：请求体带两者，文章、5W1H、数字提示和完成状态都正确', async ({ page, api }) => {
  api.queueGeneration(sseReply(generationEvents({ end: ['done', done({ numberWarnings: WARNINGS })] })));
  await page.goto('/');

  await page.getByLabel('YouTube 链接').fill(`  ${SAMPLE_URL}  `);
  await page.getByLabel(/生成要求/).fill('  写给投资人，只保留商业相关内容  ');
  await page.getByRole('button', { name: '生成文章' }).click();

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'ok');
  expect(api.generations).toHaveLength(1);
  expect(api.generations[0]!.method).toBe('POST');
  expect(api.generations[0]!.contentType).toBe('application/json');
  expect(JSON.parse(api.generations[0]!.postData ?? 'null')).toEqual({
    url: 'https://www.youtube.com/watch?v=xRh2sVcNXQ8',
    instructions: '写给投资人，只保留商业相关内容',
  });

  const article = page.locator('#article');
  await expect(article).toHaveAttribute('data-state', 'done');
  await expect(article.locator('h1')).toHaveText('对话安德森：AI 革命的万亿美金之问');
  await expect(article.locator('h2')).toHaveText(['一、AI 是新的计算平台', '二、开源模型与创业公司']);
  await expect(article.locator('.chapter-body').first()).toContainText('这一轮基础设施投入约 1200 亿美元。');
  await expect(article.locator('.chapter-body h3')).toHaveText(['平台级变化', '开源的影响']);
  await expect(article.locator('.chapter-body ol li')).toHaveText(['算力：数据中心和芯片的投入仍在加速。', '模型：前沿模型的能力每年都有明显提升。']);

  const toggles = article.getByRole('button', { name: /5W1H 总结/ });
  await expect(toggles).toHaveCount(2);
  for (const toggle of await toggles.all()) {
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveText('5W1H');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  }
  await expect(page.locator('.summary-panel:not([hidden])')).toHaveCount(0);
  await expect(page.locator('.incomplete-note')).toHaveCount(0);

  // 数字提示紧跟在标题下方，两条各占一段
  await expect(article.locator('h1 + .article-notice p')).toHaveText([
    '字幕 34:25 附近有一处数字残缺（原文"of,200"），文中写成了"1200"，疑似补全了残缺数字，请核对原字幕或原视频。',
    '字幕里有一处数字残缺（原文"3,"），文中写成了"3000"、"3万"，疑似补全了残缺数字，请核对原字幕或原视频。',
  ]);

  expect(await statusMain(page)).toBe('已完成，共 2 章、1,234 字，用时 0 秒。已对照字幕核对。文中有 2 处疑似补全了残缺数字，见标题下方的提示。点击章节标题旁的 5W1H 查看总结。');
  // 来源只写在来源面板里，状态条不重复
  await expect(status.locator('.status-detail')).toHaveCount(0);
  await expect(status.getByRole('button', { name: '重新生成' })).toHaveCount(0);
  await expect(page.locator('#source')).toBeVisible();
  expect(await sourceRows(page)).toEqual([
    ['来源视频', '对话安德森', 'a16z · 时长 1:00:00'],
    ['字幕', '英语 · 人工字幕', '整理后 52,000 字符'],
    ['字幕来源', 'YouTube 实时获取'],
  ]);

  // 控件恢复，输入保留
  await expect(page.getByRole('button', { name: '生成文章' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止生成' })).toBeHidden();
  await expect(page.getByLabel('YouTube 链接')).toHaveValue(`  ${SAMPLE_URL}  `);
});

// 抓：没有数字问题时仍显示提示框或"文中有 0 处"之类的多余文案
test('没有数字问题时不显示数字提示，状态条也不提', async ({ page, api }) => {
  api.queueGeneration(sseReply(generationEvents({})));
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByRole('button', { name: '生成文章' }).click();

  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  expect(JSON.parse(api.generations[0]!.postData ?? 'null')).toEqual({ url: SAMPLE_URL, instructions: '' });
  await expect(page.locator('.article-notice')).toHaveCount(0);
  expect(await statusMain(page)).toBe('已完成，共 2 章、1,234 字，用时 0 秒。已对照字幕核对。点击章节标题旁的 5W1H 查看总结。');
});

// 抓：done.model 与 meta.model 不同时没有告诉用户换了备用模型（备用模型提示随来源说明一起被删掉）；字幕来自内置备份时没说明原因
test('备用模型写出文章时，状态条注明主模型繁忙和实际模型；来源面板注明备份字幕和实时获取失败的原因', async ({ page, api }) => {
  api.queueGeneration(
    sseReply(
      generationEvents({
        meta: meta({ transcript: { source: 'backup', language: 'en', kind: 'asr', chars: 52000, liveError: 'YouTube 拒绝了字幕请求，可能触发了人机验证' } }),
        end: ['done', done({ model: FALLBACK_MODEL })],
      }),
    ),
  );
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByRole('button', { name: '生成文章' }).click();

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'ok');
  await expect(status.locator('.status-detail')).toHaveText('主模型繁忙，本次由 gemini-3.6-flash 生成');
  expect(await sourceRows(page)).toEqual([
    ['来源视频', '对话安德森', 'a16z · 时长 1:00:00'],
    ['字幕', '英语 · 自动生成字幕', '整理后 52,000 字符'],
    ['字幕来源', '内置备份（实时获取失败：YouTube 拒绝了字幕请求，可能触发了人机验证）'],
  ]);
  await expect(page.locator('#article h1')).toHaveText('对话安德森：AI 革命的万亿美金之问');
});

// 抓：生成中控件没有锁住（可重复提交）、按钮文案不变、停止按钮不出现；阶段文案不随事件推进
test('生成中锁住输入和提交按钮、显示停止按钮和阶段进度', async ({ page, api }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  api.queueGeneration(sseReply(generationEvents({}), { gate }));
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByRole('button', { name: '生成文章' }).click();

  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-tone', 'busy');
  expect(await statusMain(page)).toBe('正在获取字幕 · 已用时 0 秒');
  await expect(page.locator('#submit')).toBeDisabled();
  await expect(page.locator('#submit')).toHaveText('生成中…');
  await expect(page.getByLabel('YouTube 链接')).toBeDisabled();
  await expect(page.getByLabel(/生成要求/)).toBeDisabled();
  await expect(page.getByRole('button', { name: '填入示例视频' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await expect(page.locator('#article')).toBeEmpty();

  // 表单的回车提交在生成中也不会发第二个请求
  await page.locator('#generate-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
  release();
  await expect(status).toHaveAttribute('data-tone', 'ok');
  expect(api.generations).toHaveLength(1);
  await expect(page.locator('#article h1')).toHaveText('对话安德森：AI 革命的万亿美金之问');
});
