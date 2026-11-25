import { FIXED_TIME, SAMPLE_URL, expect, generationEvents, sseReply, statusMain, test } from './api-mock';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

const INVALID_URLS = [
  '',
  'https://example.com/watch?v=xRh2sVcNXQ8',
  'https://www.youtube.com/watch?v=short',
  'https://www.youtube.com/@a16z',
];

// 抓：无效链接也发请求、没给出错误提示、焦点没回到链接框；改对链接后不能继续提交
test('无效链接不发请求，提示错误并把焦点放回链接框；改对后能正常生成', async ({ page, api }) => {
  await page.goto('/');
  const urlInput = page.getByLabel('YouTube 链接');
  const status = page.locator('#status');

  for (const url of INVALID_URLS) {
    await urlInput.fill(url);
    await page.getByLabel(/生成要求/).focus();
    await page.getByRole('button', { name: '生成文章' }).click();
    await expect(status).toHaveAttribute('data-tone', 'error');
    expect(await statusMain(page)).toBe('请输入有效的 YouTube 视频链接');
    await expect(urlInput).toBeFocused();
    await expect(status.getByRole('button', { name: '重新生成' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '生成文章' })).toBeEnabled();
    await expect(page.locator('#article')).toBeEmpty();
  }
  expect(api.generations).toHaveLength(0);

  // 回车提交短链接
  api.queueGeneration(sseReply(generationEvents({})));
  await urlInput.fill('youtu.be/xRh2sVcNXQ8');
  await urlInput.press('Enter');
  await expect(status).toHaveAttribute('data-tone', 'ok');
  expect(api.generations).toHaveLength(1);
  expect(JSON.parse(api.generations[0]!.postData ?? 'null')).toEqual({ url: 'youtu.be/xRh2sVcNXQ8', instructions: '' });
});

// 抓：示例按钮自动开始生成、改掉已填的生成要求或填错链接
test('"填入示例视频"只填链接，不改生成要求也不发请求', async ({ page, api }) => {
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill('https://example.com/old');
  await page.getByLabel(/生成要求/).fill('只要商业相关的内容');
  await page.getByRole('button', { name: '填入示例视频' }).click();

  await expect(page.getByLabel('YouTube 链接')).toHaveValue('https://www.youtube.com/watch?v=xRh2sVcNXQ8');
  await expect(page.getByLabel('YouTube 链接')).toBeFocused();
  await expect(page.getByLabel(/生成要求/)).toHaveValue('只要商业相关的内容');
  await expect(page.locator('#status')).toBeHidden();
  await expect(page.locator('#submit')).toHaveText('生成文章');
  expect(api.generations).toHaveLength(0);
});

// 抓：生成要求超过 1000 字仍被原样发给服务端
test('生成要求输入框最多接受 1000 字，发出的请求不超过上限', async ({ page, api }) => {
  api.queueGeneration(sseReply(generationEvents({})));
  await page.goto('/');
  await page.getByLabel('YouTube 链接').fill(SAMPLE_URL);
  await page.getByLabel(/生成要求/).fill('要'.repeat(1001));
  await expect(page.getByLabel(/生成要求/)).toHaveValue('要'.repeat(1000));
  await page.getByRole('button', { name: '生成文章' }).click();

  await expect(page.locator('#status')).toHaveAttribute('data-tone', 'ok');
  const body = JSON.parse(api.generations[0]!.postData ?? 'null') as { instructions: string };
  expect(body.instructions.length).toBe(1000);
});
