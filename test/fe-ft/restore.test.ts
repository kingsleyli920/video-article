import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARTICLE_DELTAS, FakeBackend, RENDER_WAIT_MS, SUMMARY, VIDEO_URL, advance, closePage, meta, openPage, page, reloadPage, settle, streamFullArticle, submitWith } from './support';
import { SAVED_TTL_MS } from '../../src/client/saved';

let backend: FakeBackend;

beforeEach(async () => {
  await openPage();
  backend = new FakeBackend();
});
afterEach(closePage);

describe('生成完成后刷新页面', () => {
  // 抓：刷新后文章消失；或者恢复出来的文章点不了 5W1H、5W1H 用了别的生成编号、偷偷重新发了生成请求
  it('文章、来源面板、输入都恢复；5W1H 用原来的生成编号，不重新生成', async () => {
    await submitWith(VIDEO_URL, '只保留商业相关的内容');
    await streamFullArticle(backend.stream, 'gen-7');
    await reloadPage();
    await settle();

    expect(page.url.value).toBe(VIDEO_URL);
    expect(page.instructions.value).toBe('只保留商业相关的内容');
    expect(page.chapterTitles).toEqual(['第一章 起步', '第二章 增长']);
    expect(page.article.querySelector('h1')!.textContent).toBe('示例文章标题');
    expect(page.source.hidden).toBe(false);
    expect(page.source.rows[0]![1]).toBe('示例访谈');
    expect(page.status.tone).toBe('ok');
    expect(page.status.text).toMatch(/^已恢复上次生成的文章（.+ 完成），共 2 章、36 字。已对照字幕核对。点击章节标题旁的 5W1H 查看总结。$/);
    expect(page.controlsDisabled).toEqual([false, false, false, false]);
    expect(page.toggles.map((t) => t.disabled)).toEqual([false, false]);

    page.chapter('2').toggle.click();
    await settle();
    expect(backend.generations).toHaveLength(1);
    expect(backend.summaries.map((c) => c.request.url)).toEqual(['/api/generations/gen-7/chapters/2/summary']);
    backend.summaries[0]!.json(200, { chapterId: '2', summary: SUMMARY, cached: false });
    await settle();
    expect(page.chapter('2').panel.querySelectorAll('tr')).toHaveLength(6);
  });

  // 抓：恢复时丢了核对记录，读者看不到这篇文章改过哪里
  it('带修订的文章：恢复后核对记录还在', async () => {
    const revision = { type: 'time', before: '第一章的正文。', after: '第一章改过的正文。', reason: '时间写错了', evidence: 'the first chapter text' };
    const final = ARTICLE_DELTAS.join('').replace('第一章的正文。', '第一章改过的正文。');
    await submitWith(VIDEO_URL);
    const stream = backend.stream;
    stream.event('meta', meta('gen-8'));
    for (const text of ARTICLE_DELTAS) stream.event('delta', { text });
    stream.event('stage', { stage: 'reviewing' });
    stream.event('revised', { markdown: final, revisions: [revision] });
    stream.event('done', { chapters: [{ id: '1', title: '第一章 起步' }, { id: '2', title: '第二章 增长' }], chars: 38, timing: { transcriptMs: 1, firstTokenMs: 2, modelDoneMs: 3, reviewedMs: 4, savedMs: 5 }, numberWarnings: [], model: 'gemini-main', review: { sections: 2, revisions: 1, rewritten: null, checks: [] } });
    await settle();
    await reloadPage();
    await settle();

    expect(page.chapter('1').section.textContent).toContain('第一章改过的正文。');
    expect(page.article.querySelector('.article-review summary')!.textContent).toContain('修订了 1 处');
    expect(page.status.text).toContain('已对照字幕核对，修订 1 处。');
  });

  // 抓：服务端 7 天后已经删掉上下文，页面还恢复出旧文章
  it('保存超过 7 天：不恢复，页面是初始状态', async () => {
    await submitWith(VIDEO_URL);
    await streamFullArticle(backend.stream);
    await advance(SAVED_TTL_MS);
    await reloadPage();
    await settle();

    expect(page.article.textContent).toBe('');
    expect(page.status.hidden).toBe(true);
    expect(page.url.value).toBe('');
  });

  // 抓：开始新的一次生成后，本地还留着上一篇；新的这次失败再刷新，页面恢复出已经被替换掉的旧文章
  it('完成一篇后又生成一次并失败，再刷新：不恢复旧文章，也没有"被中断"的提示', async () => {
    await submitWith(VIDEO_URL);
    await streamFullArticle(backend.stream, 'gen-1');
    page.submit.click();
    await settle();
    backend.stream.event('error', { code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试', partial: false });
    await settle();
    await reloadPage();
    await settle();

    expect(page.article.textContent).toBe('');
    expect(page.status.hidden).toBe(true);
  });
});

describe('生成中刷新页面', () => {
  // 抓：刷新后页面一片空白，用户不知道刚才那次没了，还得重新填链接和要求
  it('链接和要求填回去，说明上次被中断、没有保存；点"重新生成"用原来的输入', async () => {
    await submitWith(VIDEO_URL, '写短一点');
    backend.stream.event('meta', meta('gen-9'));
    backend.stream.event('delta', { text: ARTICLE_DELTAS[0] });
    await advance(RENDER_WAIT_MS);
    await reloadPage();
    await settle();

    expect(page.url.value).toBe(VIDEO_URL);
    expect(page.instructions.value).toBe('写短一点');
    expect(page.article.textContent).toBe('');
    expect(page.status).toMatchObject({ tone: 'idle', text: '上次生成因为页面刷新或关闭而中断，没有保存。链接和要求已经填回。', hasRetry: true });
    expect(page.controlsDisabled).toEqual([false, false, false, false]);

    page.retryButton!.click();
    await settle();
    expect(backend.generations).toHaveLength(2);
    expect(JSON.parse(String(backend.generations[1]!.request.body))).toEqual({ url: VIDEO_URL, instructions: '写短一点' });
  });

  // 抓：提示一直留着，再刷新一次还说"上次被中断"
  it('提示只出现一次：再刷新就是初始状态', async () => {
    await submitWith(VIDEO_URL);
    await reloadPage();
    await settle();
    expect(page.status.text).toContain('上次生成因为页面刷新或关闭而中断');
    await reloadPage();
    await settle();
    expect(page.status.hidden).toBe(true);
    expect(page.url.value).toBe('');
  });

  // 抓：完成一篇后又开始生成新的，这时刷新——页面恢复出旧文章，用户以为新的那次完成了
  it('完成一篇后正在生成下一篇时刷新：提示被中断，不恢复旧文章', async () => {
    await submitWith(VIDEO_URL);
    await streamFullArticle(backend.stream, 'gen-1');
    page.submit.click();
    await settle();
    await reloadPage();
    await settle();

    expect(page.status.text).toContain('上次生成因为页面刷新或关闭而中断');
    expect(page.article.textContent).toBe('');
  });

  // 抓：生成失败或用户点了停止之后刷新，页面还说"因为刷新而中断"
  it.each([
    ['失败', () => backend.stream.event('error', { code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试', partial: false })],
    ['点了停止', () => page.stop.click()],
  ])('生成已经结束（%s）再刷新：没有"被中断"的提示', async (_label, end) => {
    await submitWith(VIDEO_URL);
    end();
    await settle();
    await reloadPage();
    await settle();
    expect(page.status.hidden).toBe(true);
  });
});
