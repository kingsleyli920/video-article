import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ARTICLE_DELTAS,
  FakeBackend,
  RENDER_WAIT_MS,
  SAMPLE_URL,
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

/** 默认 meta（support.ts）对应的面板内容 */
const LIVE_ROWS = [
  ['来源视频', '示例访谈', '示例频道 · 时长 1:00:00'],
  ['字幕', '英语 · 自动生成字幕', '整理后 52,000 字符'],
  ['字幕来源', 'YouTube 实时获取'],
];
const LIVE_PREVIEW = {
  open: false,
  summary: '字幕原文片段（节选 3 段，自动生成字幕可能有识别错误）',
  items: [
    "[00:00] Welcome back to the show. Today we're talking about how the company got started.",
    '[20:00] We spent the first two years just talking to customers before we wrote any code.',
    '[40:00] The growth really came from word of mouth, not from paid ads.',
  ],
};
const HIDDEN = { hidden: true, rows: [], preview: null };

describe('来源面板', () => {
  // 抓：来源信息要等正文出来或全文完成才显示，或者标题、频道、时长、语言、字幕类型、字符数、获取方式任一处写错；面板被放进流式正文容器、正文重绘时被清掉
  it('meta 到达后、第一段正文之前，来源面板就显示视频和字幕信息，正文开始输出后面板不变', async () => {
    await submitWith(VIDEO_URL);
    expect(page.source).toEqual(HIDDEN);
    backend.stream.event('stage', { stage: 'transcript' });
    await settle();
    expect(page.source).toEqual(HIDDEN);

    backend.stream.event('meta', meta());
    backend.stream.event('stage', { stage: 'generating' });
    await settle();
    expect(page.source).toEqual({ hidden: false, rows: LIVE_ROWS, preview: LIVE_PREVIEW });
    expect(page.article.children).toHaveLength(0);
    expect(page.status).toEqual({ hidden: false, tone: 'busy', text: '字幕已获取，等待模型输出 · 已用时 0 秒', detail: '', hasRetry: false });
    // 面板在状态条和文章之间，不在文章容器里
    expect(page.statusBox.nextElementSibling).toBe(page.sourceBox);
    expect(page.sourceBox.nextElementSibling).toBe(page.article);
    expect(page.sourceBox.getAttribute('aria-label')).toBe('来源信息');

    backend.stream.event('delta', { text: ARTICLE_DELTAS[0] });
    await advance(RENDER_WAIT_MS);
    expect(page.article.querySelector('h1')?.textContent).toBe('示例文章标题');
    expect(page.source).toEqual({ hidden: false, rows: LIVE_ROWS, preview: LIVE_PREVIEW });
  });

  // 抓：备份字幕没写实时获取失败的原因、原因缺失时显示 undefined，人工字幕被写成自动生成或也挂上"可能有识别错误"
  it.each([
    ['YouTube 拒绝了字幕请求', '内置备份（实时获取失败：YouTube 拒绝了字幕请求）'],
    [undefined, '内置备份（实时获取失败：未知原因）'],
  ])('字幕来自内置备份（原因：%s）：面板写明实时获取失败的原因，人工字幕不提识别错误', async (liveError, expected) => {
    await submitWith(VIDEO_URL);
    backend.stream.event(
      'meta',
      meta('gen-1', {
        transcript: { source: 'backup', language: 'zh-Hans', kind: 'manual', chars: 1234567, liveError, preview: [{ time: '1:02:03', text: '我们先从公司怎么起步讲起。' }] },
      }),
    );
    await settle();

    expect(page.source).toEqual({
      hidden: false,
      rows: [
        ['来源视频', '示例访谈', '示例频道 · 时长 1:00:00'],
        ['字幕', '简体中文 · 人工字幕', '整理后 1,234,567 字符'],
        ['字幕来源', expected],
      ],
      preview: { open: false, summary: '字幕原文片段（节选 1 段）', items: ['[1:02:03] 我们先从公司怎么起步讲起。'] },
    });
    expect(page.status.detail).toBe('');
  });

  // 抓：字幕片段默认展开占满页面或点不开；片段被改写、合并或多出别的字幕；原文里的尖括号和星号被当成 HTML/Markdown 解析（可被注入）
  it('字幕原文片段默认收起，点开后逐条列出"[时间] 原文"，只有服务端给的这几段，原样显示', async () => {
    await submitWith(VIDEO_URL);
    backend.stream.event(
      'meta',
      meta('gen-1', {
        transcript: {
          source: 'live',
          language: 'en',
          kind: 'asr',
          chars: 52000,
          preview: [
            { time: '00:00', text: 'So <b>this</b> is **not** markdown & <img src=x onerror="window.__xss=1">' },
            { time: '41:07', text: 'And that was the turning point.' },
          ],
        },
      }),
    );
    await settle();

    const details = page.sourceBox.querySelector('details')!;
    expect(details.open).toBe(false);
    details.querySelector('summary')!.click();
    await settle();

    expect(page.source.preview).toEqual({
      open: true,
      summary: '字幕原文片段（节选 2 段，自动生成字幕可能有识别错误）',
      items: ['[00:00] So <b>this</b> is **not** markdown & <img src=x onerror="window.__xss=1">', '[41:07] And that was the turning point.'],
    });
    expect(page.sourceBox.querySelectorAll('b, strong, em, img')).toHaveLength(0);
    // 片段是未翻译的原文，标上原文语言
    expect(details.querySelector('ol')?.lang).toBe('en');

    // 再点一次收起
    details.querySelector('summary')!.click();
    await settle();
    expect(page.source.preview?.open).toBe(false);
  });

  // 抓：旧版服务端或没有可用片段时仍显示一个空的"字幕原文片段"折叠框
  it.each([
    ['没有 preview 字段', undefined],
    ['preview 是空数组', []],
  ])('%s：面板照常显示，不出现字幕原文片段的折叠框', async (_, preview) => {
    await submitWith(VIDEO_URL);
    backend.stream.event('meta', meta('gen-1', { transcript: { source: 'live', language: 'en', kind: 'asr', chars: 52000, preview } }));
    await settle();

    expect(page.source).toEqual({ hidden: false, rows: LIVE_ROWS, preview: null });
    expect(page.sourceBox.querySelector('details, summary, ol')).toBeNull();
  });

  // 抓：开始新的一次生成后上一次的来源信息还挂着，用户以为新文章来自旧视频；新 meta 到达后仍显示旧视频
  it('完成后再生成一次：开始时清空并隐藏旧面板，新的 meta 到达后显示新视频', async () => {
    await submitWith(VIDEO_URL);
    await streamFullArticle(backend.stream, 'gen-1');
    expect(page.status.tone).toBe('ok');
    expect(page.source).toEqual({ hidden: false, rows: LIVE_ROWS, preview: LIVE_PREVIEW });
    page.sourceBox.querySelector('summary')!.click();
    await settle();
    expect(page.source.preview?.open).toBe(true);

    await submitWith(SAMPLE_URL);
    expect(page.status.text).toBe('正在获取字幕 · 已用时 0 秒');
    expect(page.source).toEqual(HIDDEN);
    expect(page.sourceBox.childNodes).toHaveLength(0);

    backend.stream.event(
      'meta',
      meta('gen-2', {
        video: { id: 'xRh2sVcNXQ8', title: '第二个视频', channel: 'a16z', lengthSeconds: 754 },
        transcript: { source: 'live', language: 'en', kind: 'manual', chars: 9800 },
      }),
    );
    await settle();
    expect(page.source).toEqual({
      hidden: false,
      rows: [
        ['来源视频', '第二个视频', 'a16z · 时长 12:34'],
        ['字幕', '英语 · 人工字幕', '整理后 9,800 字符'],
        ['字幕来源', 'YouTube 实时获取'],
      ],
      preview: null,
    });
  });

  // 抓：停止或失败时把已经拿到的来源信息清掉或改写成"已完成""已停止"之类的结论；之后点"重新生成"时旧面板没清掉
  it.each([
    ['点"停止生成"', 'idle', '已停止生成。', () => page.stop.click()],
    ['收到 error 事件', 'error', 'Gemini 模型繁忙，请稍后重试', () => backend.stream.event('error', { code: 'gemini_busy', message: 'Gemini 模型繁忙，请稍后重试', partial: false })],
    ['连接被重置', 'error', '网络连接中断', () => backend.stream.reset()],
    ['45 秒没收到任何数据', 'error', '长时间没有收到服务器的数据，已停止等待', () => {}],
  ])('%s：来源面板原样保留，点"重新生成"时才清空', async (_, tone, text, end) => {
    await submitWith(VIDEO_URL);
    backend.stream.event('meta', meta());
    backend.stream.event('stage', { stage: 'generating' });
    await settle();
    expect(page.source.hidden).toBe(false);

    end();
    await advance(45_000);
    expect(page.status).toEqual({ hidden: false, tone, text, detail: '', hasRetry: true });
    expect(page.source).toEqual({ hidden: false, rows: LIVE_ROWS, preview: LIVE_PREVIEW });
    expect(page.sourceBox.textContent).not.toMatch(/完成|停止|中断/);

    page.retryButton!.click();
    await settle();
    expect(backend.generations).toHaveLength(2);
    expect(page.source).toEqual(HIDDEN);
  });

  // 抓：链接没通过校验（根本没开始生成）时也把上一篇的来源清掉，和留在页面上的上一篇文章对不上
  it('上一篇完成后输入无效链接：不发请求，上一篇的文章和来源面板都保留', async () => {
    await submitWith(VIDEO_URL);
    await streamFullArticle(backend.stream, 'gen-1');

    await submitWith('https://example.com/watch?v=dQw4w9WgXcQ');
    expect(backend.generations).toHaveLength(1);
    expect(page.status.text).toBe('请输入有效的 YouTube 视频链接');
    expect(page.chapterTitles).toEqual(['第一章 起步', '第二章 增长']);
    expect(page.source).toEqual({ hidden: false, rows: LIVE_ROWS, preview: LIVE_PREVIEW });
  });
});
