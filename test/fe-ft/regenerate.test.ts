import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARTICLE_DELTAS,
  FakeBackend,
  RENDER_WAIT_MS,
  SAMPLE_URL,
  SUMMARY,
  VIDEO_URL,
  advance,
  closePage,
  meta,
  openPage,
  page,
  settle,
  streamFullArticle,
  submitWith,
} from './support';

let backend: FakeBackend;

beforeEach(async () => {
  await openPage();
  backend = new FakeBackend();
});
afterEach(closePage);

describe('重新生成', () => {
  // 抓：重新生成没用原来的输入，或者开始时没清掉旧文章、"内容不完整"和旧的错误状态
  it('失败后点"重新生成"：用同样的输入重发，开始时清掉旧文章和旧状态，之后能正常完成', async () => {
    await submitWith(`  ${VIDEO_URL} `, ' 只保留商业相关的内容 ');
    backend.stream.event('meta', meta());
    backend.stream.event('delta', { text: ARTICLE_DELTAS[0] });
    backend.stream.event('delta', { text: ARTICLE_DELTAS[1] });
    await advance(RENDER_WAIT_MS);
    backend.stream.event('error', { code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试', partial: true });
    await settle();
    expect(page.incompleteNote).toBe('内容不完整：Gemini 模型繁忙，请稍后重试');

    page.retryButton!.click();
    await settle();

    expect(backend.generations).toHaveLength(2);
    expect(JSON.parse(String(backend.generations[1]!.request.body))).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      instructions: '只保留商业相关的内容',
    });
    expect(page.article.children).toHaveLength(0);
    expect(page.article.dataset.state).toBeUndefined();
    expect(page.incompleteNote).toBeNull();
    expect(page.status).toEqual({ hidden: false, tone: 'busy', text: '正在获取字幕 · 已用时 0 秒', detail: '', hasRetry: false });
    expect(page.controlsDisabled).toEqual([true, true, true, true]);
    expect(page.stop.hidden).toBe(false);

    await streamFullArticle(backend.stream, 'gen-2');
    expect(page.status.tone).toBe('ok');
    expect(page.status.text).toBe('已完成，共 2 章、36 字，用时 0 秒。点击章节标题旁的 5W1H 查看总结。');
    expect(page.chapterTitles).toEqual(['第一章 起步', '第二章 增长']);
    expect(page.incompleteNote).toBeNull();
  });

  // 抓：第二次生成时旧文章、旧数字提示、旧 5W1H 面板、旧来源说明残留；新文章的 5W1H 用旧 generationId，或旧的点击处理没解绑、点新文章时顺带发出旧请求
  it('成功并展开过 5W1H 后再生成一次：旧内容全部消失，新文章的 5W1H 只用新的 generationId', async () => {
    await submitWith(VIDEO_URL);
    await streamFullArticle(backend.stream, 'gen-1', {
      numberWarnings: [{ time: '12:05', fragment: 'of,200', written: ['1200'] }],
      model: 'gemini-fallback',
    });
    page.chapter('1').toggle.click();
    await settle();
    backend.summaries[0]!.json(200, { chapterId: '1', cached: false, summary: SUMMARY });
    await settle();
    expect(page.notices).toHaveLength(1);
    expect(page.chapter('1').panel.querySelectorAll('tr')).toHaveLength(6);
    expect(page.status.detail).toBe('主模型繁忙，本次由 gemini-fallback 生成');

    // 用户换一个视频再生成
    await submitWith(SAMPLE_URL);
    expect(backend.generations).toHaveLength(2);
    expect(page.article.children).toHaveLength(0);
    expect(page.notices).toEqual([]);
    expect(document.querySelectorAll('.summary-panel, .summary-table, .summary-toggle')).toHaveLength(0);
    expect(page.status).toEqual({ hidden: false, tone: 'busy', text: '正在获取字幕 · 已用时 0 秒', detail: '', hasRetry: false });

    await streamFullArticle(backend.stream, 'gen-2');
    expect(page.status).toEqual({
      hidden: false,
      tone: 'ok',
      text: '已完成，共 2 章、36 字，用时 0 秒。点击章节标题旁的 5W1H 查看总结。',
      detail: '',
      hasRetry: false,
    });
    expect(page.notices).toEqual([]);
    expect(page.toggles.map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    expect([page.chapter('1').panel.hidden, page.chapter('2').panel.hidden]).toEqual([true, true]);
    expect(page.article.querySelectorAll('.summary-table')).toHaveLength(0);

    // 旧文章没打开过第二章：旧的点击处理若还在，这里会多发一个 gen-1 的请求
    page.chapter('2').toggle.click();
    await settle();
    page.chapter('1').toggle.click();
    await settle();
    expect(backend.summaries.map((call) => call.request.url)).toEqual([
      '/api/generations/gen-1/chapters/1/summary',
      '/api/generations/gen-2/chapters/2/summary',
      '/api/generations/gen-2/chapters/1/summary',
    ]);
    expect(page.chapter('1').panel.hidden).toBe(false);
    expect(page.chapter('1').panel.textContent).toBe('正在生成 5W1H 总结…');
  });

  // 抓：开始新的生成后，旧文章还在加载的 5W1H 请求继续挂着占用服务端，或者晚到的结果被写进新文章的面板
  it('开始新的生成时中止旧文章还在进行的 5W1H 请求，旧结果不会写进新文章', async () => {
    await submitWith(VIDEO_URL);
    await streamFullArticle(backend.stream, 'gen-1');
    page.chapter('1').toggle.click();
    await settle();
    expect(backend.summaries).toHaveLength(1);

    const oldSummary = backend.summaries[0]!.request.signal;
    expect(oldSummary.aborted).toBe(false);

    await submitWith(VIDEO_URL);
    expect(oldSummary.aborted).toBe(true);
    await streamFullArticle(backend.stream, 'gen-2');
    await settle();

    const chapter = page.chapter('1');
    expect(chapter.panel.hidden).toBe(true);
    expect(chapter.panel.childNodes).toHaveLength(0);
    expect(chapter.toggle.getAttribute('aria-expanded')).toBe('false');
    expect(page.article.querySelectorAll('.summary-table')).toHaveLength(0);

    // 新文章第一章第一次点击照常请求新的 generationId
    chapter.toggle.click();
    await settle();
    expect(backend.summaries.at(-1)!.request.url).toBe('/api/generations/gen-2/chapters/1/summary');
    expect(chapter.panel.textContent).toBe('正在生成 5W1H 总结…');
  });

  // 抓：生成进行中再次提交（回车、脚本调用 requestSubmit）又发一次请求，两条流交替写同一篇文章
  it('生成进行中再次提交不会发第二个请求，当前生成照常完成', async () => {
    await submitWith(VIDEO_URL, '第一次的要求');
    backend.stream.event('meta', meta());
    backend.stream.event('delta', { text: ARTICLE_DELTAS[0] });
    await advance(RENDER_WAIT_MS);

    page.submit.click(); // 已禁用，点击无效
    page.form.requestSubmit(); // 绕过按钮直接提交
    await settle();

    expect(backend.fetch).toHaveBeenCalledTimes(1);
    expect(page.article.querySelector('h1')?.textContent).toBe('示例文章标题');
    expect(page.status.tone).toBe('busy');
    expect(page.status.text).toBe('正在生成文章 · 已用时 0 秒');

    backend.stream.event('delta', { text: ARTICLE_DELTAS[1] });
    backend.stream.event('delta', { text: ARTICLE_DELTAS[2] });
    backend.stream.event('done', {
      chapters: [
        { id: '1', title: '第一章 起步' },
        { id: '2', title: '第二章 增长' },
      ],
      chars: 36,
      timing: { transcriptMs: 1, firstTokenMs: 2, modelDoneMs: 3, savedMs: 4 },
      numberWarnings: [],
      model: 'gemini-main',
    });
    await settle();
    expect(page.status.tone).toBe('ok');
    expect(page.chapterTitles).toEqual(['第一章 起步', '第二章 增长']);
    expect(backend.fetch).toHaveBeenCalledTimes(1);
  });
});
