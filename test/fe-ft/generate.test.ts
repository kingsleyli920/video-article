import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARTICLE_DELTAS,
  FakeBackend,
  RENDER_WAIT_MS,
  VIDEO_URL,
  advance,
  closePage,
  doneEvent,
  meta,
  openPage,
  page,
  settle,
  streamFullArticle,
  submitWith,
  type,
} from './support';

let backend: FakeBackend;

beforeEach(async () => {
  await openPage();
  backend = new FakeBackend();
});
afterEach(closePage);

const LIVE_SOURCE = '示例访谈 · 自动生成字幕（en）· 来源：YouTube 实时获取';

describe('读屏播报', () => {
  // 抓：生成中状态条每秒整体重写一次，读屏软件每秒播报一遍；或者结果出来后反而不播报
  it('生成中状态条不播报（aria-live off），完成后恢复播报（polite）', async () => {
    await submitWith(VIDEO_URL);
    expect(page.statusBox.getAttribute('aria-live')).toBe('off');
    await advance(3_000);
    expect(page.statusBox.getAttribute('aria-live')).toBe('off');

    await streamFullArticle(backend.stream);
    expect(page.status.tone).toBe('ok');
    expect(page.statusBox.getAttribute('aria-live')).toBe('polite');
  });
});

describe('提交并生成', () => {
  // 抓：请求体没带生成要求、没去首尾空白，或者发到了错误的接口、用了错误的方法
  it('请求体带着去掉首尾空白的链接和生成要求', async () => {
    await submitWith(`  ${VIDEO_URL}  `, '  写给投资人，语言简洁。 \n');

    expect(backend.fetch).toHaveBeenCalledTimes(1);
    const { request } = backend.generations[0]!;
    expect(request.url).toBe('/api/generations');
    expect(request.method).toBe('POST');
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(request.body))).toEqual({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', instructions: '写给投资人，语言简洁。' });
  });

  // 抓：生成中控件没锁、按钮文字不变、停止按钮不出现；状态条不显示阶段、用时不走或阶段不随事件切换
  it('生成中锁定表单、显示"停止生成"，状态条显示当前阶段和已用时并随时间更新', async () => {
    await submitWith(VIDEO_URL, '写给投资人');

    expect(page.controlsDisabled).toEqual([true, true, true, true]);
    expect(page.submit.textContent).toBe('生成中…');
    expect(page.stop.hidden).toBe(false);
    expect(page.status).toEqual({ hidden: false, tone: 'busy', text: '正在获取字幕 · 已用时 0 秒', detail: '', hasRetry: false });

    backend.stream.event('stage', { stage: 'transcript' });
    await advance(2_000);
    expect(page.status.text).toBe('正在获取字幕 · 已用时 2 秒');

    backend.stream.event('meta', meta());
    backend.stream.event('stage', { stage: 'generating' });
    await settle();
    expect(page.status).toEqual({ hidden: false, tone: 'busy', text: '字幕已获取，等待模型输出 · 已用时 2 秒', detail: LIVE_SOURCE, hasRetry: false });

    await advance(3_000);
    expect(page.status.text).toBe('字幕已获取，等待模型输出 · 已用时 5 秒');

    backend.stream.event('delta', { text: ARTICLE_DELTAS[0] });
    await settle();
    expect(page.status.text).toBe('正在生成文章 · 已用时 5 秒');

    await advance(7_000);
    expect(page.status.text).toBe('正在生成文章 · 已用时 12 秒');
    // 整个过程表单一直锁着
    expect(page.controlsDisabled).toEqual([true, true, true, true]);
    expect(page.stop.hidden).toBe(false);
  });

  // 抓：正文要等全部生成完才出现，或者后一个 delta 覆盖掉前面的内容；生成中 5W1H 就能点
  it('正文随 delta 逐步出现，生成中 5W1H 按钮不可点', async () => {
    await submitWith(VIDEO_URL);
    backend.stream.event('meta', meta());

    backend.stream.event('delta', { text: ARTICLE_DELTAS[0] });
    await advance(RENDER_WAIT_MS);
    expect(page.article.dataset.state).toBe('streaming');
    expect(page.article.querySelector('h1')?.textContent).toBe('示例文章标题');
    expect(page.article.querySelector('.article-intro')?.textContent?.trim()).toBe('这是导语。');
    expect(page.chapterTitles).toEqual([]);
    expect(page.article.querySelectorAll('.caret')).toHaveLength(1);

    backend.stream.event('delta', { text: ARTICLE_DELTAS[1] });
    await advance(RENDER_WAIT_MS);
    expect(page.article.querySelector('h1')?.textContent).toBe('示例文章标题');
    expect(page.chapterTitles).toEqual(['第一章 起步']);
    expect(page.chapter('1').toggle.disabled).toBe(true);
    expect(page.chapter('1').toggle.title).toBe('全文生成并保存后可用');

    backend.stream.event('delta', { text: ARTICLE_DELTAS[2] });
    await advance(RENDER_WAIT_MS);
    expect(page.chapterTitles).toEqual(['第一章 起步', '第二章 增长']);
    expect(page.chapter('2').section.querySelector('.chapter-body')?.textContent?.trim()).toBe('第二章的正文。');
    expect(page.toggles.map((b) => b.disabled)).toEqual([true, true]);
  });

  // 抓：完成后状态条不更新、5W1H 不开放、表单一直锁着，或计时器没停、把完成状态又刷回"生成中"
  it('收到 done：状态条显示章数、字数和用时，5W1H 可点，表单恢复', async () => {
    await submitWith(VIDEO_URL);
    backend.stream.event('stage', { stage: 'transcript' });
    backend.stream.event('meta', meta());
    await advance(4_000);
    for (const text of ARTICLE_DELTAS) backend.stream.event('delta', { text });
    backend.stream.event('done', doneEvent());
    await settle();

    expect(page.status).toEqual({
      hidden: false,
      tone: 'ok',
      text: '已完成，共 2 章、36 字，用时 4 秒。点击章节标题旁的 5W1H 查看总结。',
      detail: LIVE_SOURCE,
      hasRetry: false,
    });
    expect(page.article.dataset.state).toBe('done');
    expect(page.chapterTitles).toEqual(['第一章 起步', '第二章 增长']);
    expect(page.article.querySelector('.caret')).toBeNull();
    expect(page.incompleteNote).toBeNull();
    expect(page.notices).toEqual([]);
    expect(page.toggles.map((b) => [b.disabled, b.title])).toEqual([
      [false, '查看本章的 5W1H 总结'],
      [false, '查看本章的 5W1H 总结'],
    ]);
    expect(page.controlsDisabled).toEqual([false, false, false, false]);
    expect(page.submit.textContent).toBe('生成文章');
    expect(page.stop.hidden).toBe(true);
    // 服务端连接还开着，页面收到 done 就主动断开
    expect(backend.generations[0]!.request.signal.aborted).toBe(true);

    await advance(5_000);
    expect(page.status.tone).toBe('ok');
    expect(page.status.text).toBe('已完成，共 2 章、36 字，用时 4 秒。点击章节标题旁的 5W1H 查看总结。');
  });
});

describe('完成时的提示', () => {
  // 抓：服务端报了数字问题但页面不提示，提示没放在标题下方，或者状态条不提
  it('done 带 numberWarnings：标题下方逐条提示，状态条提一句', async () => {
    await submitWith(VIDEO_URL);
    await streamFullArticle(backend.stream, 'gen-1', {
      numberWarnings: [
        { time: '34:25', fragment: 'of,200', written: ['1200'] },
        { time: null, fragment: '3.', written: ['3.5', '35'] },
      ],
    });

    expect(page.notices).toEqual([
      '字幕 34:25 附近有一处数字残缺（原文"of,200"），文中写成了确定的数"1200"。这个数没有字幕依据，请以原视频为准。',
      '字幕里有一处数字残缺（原文"3."），文中写成了确定的数"3.5"、"35"。这个数没有字幕依据，请以原视频为准。',
    ]);
    const notice = page.article.querySelector('.article-notice');
    expect(notice?.previousElementSibling?.tagName).toBe('H1');
    expect(notice?.getAttribute('role')).toBe('note');
    expect(page.status.tone).toBe('ok');
    expect(page.status.text).toBe('已完成，共 2 章、36 字，用时 0 秒。文中有 2 处数字没有字幕依据，见标题下方的提示。点击章节标题旁的 5W1H 查看总结。');
  });

  // 抓：备用模型写的文章没有注明，用户以为是主模型的结果
  it('done.model 和 meta.model 不同：状态条注明"主模型繁忙，本次由 xxx 生成"', async () => {
    await submitWith(VIDEO_URL);
    await streamFullArticle(backend.stream, 'gen-1', { model: 'gemini-fallback' });

    expect(page.status.tone).toBe('ok');
    expect(page.status.detail).toBe('示例访谈 · 自动生成字幕（en）· 来源：YouTube 实时获取 · 主模型繁忙，本次由 gemini-fallback 生成');
  });

  // 抓：旧版服务端的 done 不带 numberWarnings 和 model 时页面崩溃，或者误报"由 undefined 生成"
  it('done 缺少 numberWarnings 和 model 字段时照常完成，不误报', async () => {
    await submitWith(VIDEO_URL);
    backend.stream.event('meta', meta());
    for (const text of ARTICLE_DELTAS) backend.stream.event('delta', { text });
    backend.stream.event('done', { chapters: [{ id: '1', title: '第一章 起步' }, { id: '2', title: '第二章 增长' }], chars: 36, timing: { transcriptMs: 1, firstTokenMs: 2, modelDoneMs: 3, savedMs: 4 } });
    await settle();

    expect(page.status).toEqual({ hidden: false, tone: 'ok', text: '已完成，共 2 章、36 字，用时 0 秒。点击章节标题旁的 5W1H 查看总结。', detail: LIVE_SOURCE, hasRetry: false });
    expect(page.notices).toEqual([]);
    expect(page.toggles.map((b) => b.disabled)).toEqual([false, false]);
  });

  // 抓：字幕来源写错（备份当成实时、人工字幕当成自动字幕），或备份原因缺失时显示 undefined
  it.each([
    ['YouTube 拒绝了字幕请求', '示例访谈 · 人工字幕（zh-Hans）· 来源：内置备份（实时获取失败：YouTube 拒绝了字幕请求）'],
    [undefined, '示例访谈 · 人工字幕（zh-Hans）· 来源：内置备份（实时获取失败：未知原因）'],
  ])('字幕来自内置备份（原因：%s）：状态条说明来源和实时获取失败的原因', async (liveError, expected) => {
    await submitWith(VIDEO_URL);
    backend.stream.event('meta', meta('gen-1', { transcript: { source: 'backup', language: 'zh-Hans', kind: 'manual', chars: 52000, liveError } }));
    await settle();
    expect(page.status.detail).toBe(expected);
  });
});

describe('输入校验', () => {
  // 抓：无效链接也发请求、不提示，或者提示后焦点不回到链接框
  it.each(['https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short', '   '])(
    '链接无效（"%s"）时不发请求，状态条提示并把焦点放回链接框',
    async (url) => {
      await submitWith(url, '写给投资人');

      expect(backend.fetch).not.toHaveBeenCalled();
      expect(page.status).toEqual({ hidden: false, tone: 'error', text: '请输入有效的 YouTube 视频链接', detail: '', hasRetry: false });
      expect(document.activeElement).toBe(page.url);
      expect(page.controlsDisabled).toEqual([false, false, false, false]);
      expect(page.stop.hidden).toBe(true);
    },
  );

  // 抓：校验失败后表单进入错误状态，改对链接再提交也发不出请求
  it('链接无效被拦下后改成有效链接，再提交能正常发请求', async () => {
    await submitWith('youtube.com/watch?v=abc');
    expect(page.status.text).toBe('请输入有效的 YouTube 视频链接');

    await submitWith(VIDEO_URL);
    expect(backend.fetch).toHaveBeenCalledTimes(1);
    expect(page.status.tone).toBe('busy');
    expect(page.status.text).toBe('正在获取字幕 · 已用时 0 秒');
  });

  // 抓：超长的生成要求也发请求（textarea 的 maxlength 挡不住程序赋值和部分输入法）
  it('生成要求超过 1000 字时不发请求并提示', async () => {
    type(page.url, VIDEO_URL);
    page.instructions.value = '字'.repeat(1001);
    page.submit.click();
    await settle();

    expect(backend.fetch).not.toHaveBeenCalled();
    expect(page.status).toEqual({ hidden: false, tone: 'error', text: '生成要求不能超过 1000 字', detail: '', hasRetry: false });
    expect(page.controlsDisabled).toEqual([false, false, false, false]);
  });

  // 抓：边界算错（正好 1000 字被拒），或者先算长度再去空白、把首尾空白也算进去
  it('生成要求正好 1000 字（前后带空白）时照常发请求', async () => {
    type(page.url, VIDEO_URL);
    page.instructions.value = `  ${'字'.repeat(1000)}\n `;
    page.submit.click();
    await settle();

    expect(backend.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(backend.generations[0]!.request.body)) as { instructions: string };
    expect(body.instructions).toHaveLength(1000);
    expect(page.status.tone).toBe('busy');
  });

  // 抓："填入示例视频"顺手发了请求、改了生成要求，或者填的不是示例链接
  it('"填入示例视频"只填链接、不发请求，之后点生成用的就是示例链接', async () => {
    type(page.instructions, '只保留商业相关的内容');
    page.sample.click();
    await settle();

    expect(page.url.value).toBe('https://www.youtube.com/watch?v=xRh2sVcNXQ8');
    expect(page.instructions.value).toBe('只保留商业相关的内容');
    expect(document.activeElement).toBe(page.url);
    expect(backend.fetch).not.toHaveBeenCalled();
    expect(page.status.hidden).toBe(true);

    page.submit.click();
    await settle();
    expect(JSON.parse(String(backend.generations[0]!.request.body))).toEqual({ url: 'https://www.youtube.com/watch?v=xRh2sVcNXQ8', instructions: '只保留商业相关的内容' });
  });
});
