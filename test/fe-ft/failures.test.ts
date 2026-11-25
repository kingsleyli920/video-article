import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARTICLE_DELTAS, FakeBackend, RENDER_WAIT_MS, VIDEO_URL, advance, closePage, meta, openPage, page, settle, submitWith } from './support';

let backend: FakeBackend;

beforeEach(async () => {
  await openPage();
  backend = new FakeBackend();
});
afterEach(closePage);

const LIVE_SOURCE = '示例访谈 · 自动生成字幕（en）· 来源：YouTube 实时获取';

/** 推 meta 和前两段正文（标题、导语、第一章），等页面画出来 */
async function streamHalfArticle(): Promise<void> {
  backend.stream.event('stage', { stage: 'transcript' });
  backend.stream.event('meta', meta());
  backend.stream.event('stage', { stage: 'generating' });
  backend.stream.event('delta', { text: ARTICLE_DELTAS[0] });
  backend.stream.event('delta', { text: ARTICLE_DELTAS[1] });
  await advance(RENDER_WAIT_MS);
  expect(page.chapterTitles).toEqual(['第一章 起步']);
}

/** 失败或停止之后表单应当回到可用状态 */
function expectFormIdle(): void {
  expect(page.controlsDisabled).toEqual([false, false, false, false]);
  expect(page.submit.textContent).toBe('生成文章');
  expect(page.stop.hidden).toBe(true);
}

describe('生成失败', () => {
  // 抓：error 事件后已生成的内容被清空、没标"内容不完整"、5W1H 还能点，或者没有重新生成的入口
  it('收到 error（partial: true）：状态条显示错误和"重新生成"，保留已生成内容并标"内容不完整"，5W1H 不可点', async () => {
    await submitWith(VIDEO_URL);
    await streamHalfArticle();
    backend.stream.event('error', { code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试', partial: true });
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'error', text: 'Gemini 模型繁忙，请稍后重试', detail: LIVE_SOURCE, hasRetry: true });
    expect(page.article.dataset.state).toBe('failed');
    expect(page.article.querySelector('h1')?.textContent).toBe('示例文章标题');
    expect(page.chapterTitles).toEqual(['第一章 起步']);
    expect(page.chapter('1').section.querySelector('.chapter-body')?.textContent?.trim()).toBe('第一章的正文。');
    expect(page.incompleteNote).toBe('内容不完整：Gemini 模型繁忙，请稍后重试');
    expect(page.toggles.map((b) => [b.disabled, b.title])).toEqual([[true, '生成未完成，章节总结不可用']]);
    expect(page.article.querySelector('.caret')).toBeNull();
    expectFormIdle();
  });

  // 抓：还没有任何正文时也挂一条"内容不完整"，或者把服务端给的错误文案换掉
  it('收到 error（partial: false）：只显示服务端的错误文案和"重新生成"，文章区为空', async () => {
    await submitWith(VIDEO_URL);
    backend.stream.event('stage', { stage: 'transcript' });
    backend.stream.event('error', { code: 'no_captions', message: '这个视频没有可用的字幕', partial: false });
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'error', text: '这个视频没有可用的字幕', detail: '', hasRetry: true });
    expect(page.article.children).toHaveLength(0);
    expect(page.incompleteNote).toBeNull();
    expectFormIdle();
  });

  // 抓：fetch 直接失败时页面卡在"生成中"，或者显示英文异常原文
  it('fetch 直接失败（网络错误）：状态条"网络连接中断"和"重新生成"，表单恢复', async () => {
    backend.autoStream = false;
    await submitWith(VIDEO_URL);
    expect(page.status.tone).toBe('busy');

    backend.generations[0]!.networkError();
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'error', text: '网络连接中断', detail: '', hasRetry: true });
    expect(page.article.children).toHaveLength(0);
    expectFormIdle();
  });

  // 抓：HTTP 错误响应没读服务端 JSON 里的文案，统一显示成笼统的错误
  it.each([
    [400, { error: { code: 'invalid_request', message: '请求格式不正确（缺少 url 字段）' } }, '请求格式不正确（缺少 url 字段）'],
    [429, { error: { code: 'gemini_quota', message: 'Gemini 免费额度已用完或请求过于频繁，请稍后再试' } }, 'Gemini 免费额度已用完或请求过于频繁，请稍后再试'],
  ])('HTTP %i 的 JSON 错误：状态条显示服务端给的文案', async (status, body, expected) => {
    backend.autoStream = false;
    await submitWith(VIDEO_URL);
    backend.generations[0]!.json(status, body);
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'error', text: expected, detail: '', hasRetry: true });
    expectFormIdle();
  });

  // 抓：网关返回 HTML 错误页时 JSON 解析异常冒出去、页面卡住，或者显示乱码
  it('HTTP 502 且响应不是 JSON：显示"请求失败（HTTP 502）"', async () => {
    backend.autoStream = false;
    await submitWith(VIDEO_URL);
    backend.generations[0]!.respond(new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'error', text: '请求失败（HTTP 502）', detail: '', hasRetry: true });
    expectFormIdle();
  });

  // 抓：200 但没有响应体时页面一直等
  it('HTTP 200 但没有响应体：按网络错误处理', async () => {
    backend.autoStream = false;
    await submitWith(VIDEO_URL);
    backend.generations[0]!.respond(new Response(null, { status: 200 }));
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'error', text: '网络连接中断', detail: '', hasRetry: true });
    expectFormIdle();
  });
});

describe('中断', () => {
  // 抓：流没收到 done 就结束时被当成成功（开放 5W1H），或者页面一直停在"生成中"
  it('流在没有 done/error 时结束：判为中断，保留部分内容，可以重新生成', async () => {
    await submitWith(VIDEO_URL, '写给投资人');
    await streamHalfArticle();
    backend.stream.end();
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'error', text: '生成中断，文章不完整', detail: LIVE_SOURCE, hasRetry: true });
    expect(page.article.dataset.state).toBe('failed');
    expect(page.chapterTitles).toEqual(['第一章 起步']);
    expect(page.incompleteNote).toBe('内容不完整：生成中断，文章不完整');
    expect(page.toggles.map((b) => b.disabled)).toEqual([true]);
    expectFormIdle();

    page.retryButton!.click();
    await settle();
    expect(backend.generations).toHaveLength(2);
    expect(JSON.parse(String(backend.generations[1]!.request.body))).toEqual({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', instructions: '写给投资人' });
    expect(page.status.tone).toBe('busy');
  });

  // 抓：连接中途被重置时页面卡在"生成中"或丢掉已生成的内容
  it('连接中途被重置：显示"网络连接中断"，保留部分内容', async () => {
    await submitWith(VIDEO_URL);
    await streamHalfArticle();
    backend.stream.reset();
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'error', text: '网络连接中断', detail: LIVE_SOURCE, hasRetry: true });
    expect(page.chapterTitles).toEqual(['第一章 起步']);
    expect(page.incompleteNote).toBe('内容不完整：网络连接中断');
    expectFormIdle();
  });
});

describe('停止生成', () => {
  // 抓：点停止后请求没有真正中止（服务端继续消耗额度），或者内容丢失、按钮没恢复、计时器还在刷状态条
  it('生成中点"停止生成"：中止请求，状态条"已停止生成……"，保留已生成内容，表单恢复', async () => {
    await submitWith(VIDEO_URL);
    await streamHalfArticle();
    const { signal } = backend.generations[0]!.request;
    expect(signal.aborted).toBe(false);

    page.stop.click();
    await settle();

    expect(signal.aborted).toBe(true);
    expect(page.status).toEqual({ hidden: false, tone: 'idle', text: '已停止生成，已生成的内容保留在下方。', detail: LIVE_SOURCE, hasRetry: true });
    expect(page.chapterTitles).toEqual(['第一章 起步']);
    expect(page.incompleteNote).toBe('内容不完整：已停止生成');
    expect(page.toggles.map((b) => b.disabled)).toEqual([true]);
    expectFormIdle();

    // 之后不再有任何变化：没有超时报错覆盖"已停止"，也没有新请求；再点一次（已隐藏的）停止按钮也无事发生
    await advance(60_000);
    page.stop.click();
    await settle();
    expect(page.status.tone).toBe('idle');
    expect(page.status.text).toBe('已停止生成，已生成的内容保留在下方。');
    expect(backend.fetch).toHaveBeenCalledTimes(1);
  });

  // 抓：还在等响应头时点停止，页面报"网络连接中断"而不是"已停止"；或者明明没有内容还说"已生成的内容保留在下方"
  it('还在等响应头时点"停止生成"：请求被中止，显示"已停止生成。"，不提保留内容', async () => {
    backend.autoStream = false;
    await submitWith(VIDEO_URL);
    const { signal } = backend.generations[0]!.request;

    page.stop.click();
    await settle();

    expect(signal.aborted).toBe(true);
    expect(page.status).toEqual({ hidden: false, tone: 'idle', text: '已停止生成。', detail: '', hasRetry: true });
    expect(page.incompleteNote).toBeNull();
    expectFormIdle();
  });

  // 抓：停止按钮隐藏后焦点留在隐藏的按钮上，键盘用户不知道自己在页面的哪里
  it('用键盘点"停止生成"后，焦点移到"生成文章"按钮', async () => {
    await submitWith(VIDEO_URL);
    await streamHalfArticle();
    page.stop.focus();
    expect(document.activeElement).toBe(page.stop);

    page.stop.click();
    await settle();

    expect(page.stop.hidden).toBe(true);
    expect(document.activeElement).toBe(page.submit);
  });
});

describe('超时', () => {
  // 抓：连接卡住、连心跳都没有时页面无限等待，或者超时后没中止请求
  it('45 秒收不到任何字节：显示 client_timeout 文案并中止请求', async () => {
    await submitWith(VIDEO_URL);
    backend.stream.event('meta', meta());
    await settle();
    const { signal } = backend.generations[0]!.request;

    await advance(44_999);
    expect(page.status.tone).toBe('busy');
    expect(signal.aborted).toBe(false);

    await advance(1);
    expect(page.status).toEqual({ hidden: false, tone: 'error', text: '长时间没有收到服务器的数据，已停止等待', detail: LIVE_SOURCE, hasRetry: true });
    expect(signal.aborted).toBe(true);
    expectFormIdle();
  });

  // 抓：心跳不刷新空闲计时，模型思考久一点就被误判超时；或者空闲计时根本没在跑
  it('心跳注释刷新空闲计时：只有心跳也不误判，心跳停止 45 秒后才超时', async () => {
    await submitWith(VIDEO_URL);
    backend.stream.event('meta', meta());
    backend.stream.event('stage', { stage: 'generating' });
    await settle();

    for (let i = 0; i < 3; i++) {
      await advance(30_000);
      backend.stream.heartbeat();
      await settle();
    }
    // 第 90 秒收到最后一次心跳；第 134 秒（距开始已远超 45 秒）仍在正常等待
    await advance(44_000);
    expect(page.status).toEqual({ hidden: false, tone: 'busy', text: '字幕已获取，等待模型输出 · 已用时 134 秒', detail: LIVE_SOURCE, hasRetry: false });

    await advance(999);
    expect(page.status.tone).toBe('busy');
    await advance(1);
    expect(page.status.tone).toBe('error');
    expect(page.status.text).toBe('长时间没有收到服务器的数据，已停止等待');
  });

  // 抓：服务端只发心跳不出内容时页面永远等下去
  it('整次生成超过 10 分钟：即使一直有心跳也判为超时', async () => {
    await submitWith(VIDEO_URL);
    backend.stream.event('meta', meta());
    backend.stream.event('stage', { stage: 'generating' });
    await settle();

    for (let i = 0; i < 19; i++) {
      await advance(30_000);
      backend.stream.heartbeat();
      await settle();
    }
    await advance(29_999);
    expect(page.status.tone).toBe('busy');
    expect(page.status.text).toBe('字幕已获取，等待模型输出 · 已用时 599 秒');

    await advance(1);
    expect(page.status).toEqual({ hidden: false, tone: 'error', text: '长时间没有收到服务器的数据，已停止等待', detail: LIVE_SOURCE, hasRetry: true });
    expect(backend.generations[0]!.request.signal.aborted).toBe(true);
  });
});
