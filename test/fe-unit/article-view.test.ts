import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildArticle, createArticleView, numberWarningText } from '../../src/client/article-view';

const MARKDOWN = '# 对话安德森：万亿美金之问\n\n## 技术革命：八十年一遇\n\n### 当前阶段\n\n**Jen:** 第几局？\n\n**Mark:** 第三年。\n\n## 智能经济：收入爆发\n\n1. 消费端：光速普及\n2. 企业端：按 token 计费';

function render(markdown: string, state: 'streaming' | 'done' | 'failed') {
  const root = document.createElement('div');
  root.append(buildArticle(markdown, state));
  return root;
}

describe('buildArticle', () => {
  // 抓：章节 id 与服务端不一致，或标题旁没有 5W1H 按钮
  it('每个二级标题渲染为一个章节，标题旁有 5W1H 按钮，章节 id 与服务端规则一致', () => {
    const root = render(MARKDOWN, 'done');
    expect(root.querySelector('h1')?.textContent).toBe('对话安德森：万亿美金之问');
    const sections = [...root.querySelectorAll<HTMLElement>('section.chapter')];
    expect(sections.map((s) => [s.dataset.chapterId, s.querySelector('h2')?.textContent])).toEqual([
      ['1', '技术革命：八十年一遇'],
      ['2', '智能经济：收入爆发'],
    ]);
    expect(sections.map((s) => s.querySelector('.chapter-heading button')?.textContent)).toEqual(['5W1H', '5W1H']);
    expect(root.querySelector('section.chapter strong')?.textContent).toBe('Jen:');
    expect(root.querySelectorAll('section.chapter ol li')).toHaveLength(2);
  });

  // 抓：生成中或失败时 5W1H 按钮可点，点开后请求一个还没保存的上下文
  it.each([
    ['streaming', true, '全文生成并保存后可用'],
    ['failed', true, '生成未完成，章节总结不可用'],
    ['done', false, '查看本章的 5W1H 总结'],
  ] as const)('%s 状态下按钮 disabled=%s', (state, disabled, title) => {
    const buttons = [...render(MARKDOWN, state).querySelectorAll<HTMLButtonElement>('.summary-toggle')];
    expect(buttons.map((b) => [b.disabled, b.title])).toEqual([
      [disabled, title],
      [disabled, title],
    ]);
  });

  // 抓：字幕里的恶意内容经模型输出后变成可执行脚本
  it('模型输出里的脚本和事件处理属性被清除', () => {
    const root = render('## 章节\n\n<img src="x" onerror="alert(1)"><script>alert(2)</script>[链接](javascript:alert(3))', 'done');
    const body = root.querySelector('.chapter-body')!;
    expect(body.querySelector('script')).toBeNull();
    expect(body.querySelector('img')?.getAttribute('onerror')).toBeNull();
    expect(body.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript:');
  });

  it('章节标题作为纯文本插入，不解析成 HTML', () => {
    const root = render('## <b>加粗</b>标题\n\n正文', 'done');
    expect(root.querySelector('h2')?.textContent).toBe('<b>加粗</b>标题');
    expect(root.querySelector('h2 b')).toBeNull();
  });

  it('只有生成中才显示光标，且挂在最后一段末尾', () => {
    expect(render(MARKDOWN, 'streaming').querySelector('li:last-child .caret')).not.toBeNull();
    expect(render(MARKDOWN, 'done').querySelector('.caret')).toBeNull();
  });
});

describe('createArticleView', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // 抓：每个 delta 都整篇重绘导致卡顿，或节流后最后一段没画出来
  it('80ms 内的多次更新合并成一次重绘，内容取最新', () => {
    const root = document.createElement('div');
    const view = createArticleView(root);
    view.update('## 第一章\n\n第');
    view.update('## 第一章\n\n第一段');
    expect(root.childNodes).toHaveLength(0);
    vi.advanceTimersByTime(80);
    expect(root.querySelector('.chapter-body p')?.textContent).toBe('第一段');
    expect(root.dataset.state).toBe('streaming');
  });

  it('fail 保留已生成内容并追加"内容不完整"提示', () => {
    const root = document.createElement('div');
    const view = createArticleView(root);
    view.update('## 第一章\n\n写到一半');
    view.fail('## 第一章\n\n写到一半', '生成中断，文章不完整');
    expect(root.querySelector('.chapter-body p')?.textContent).toBe('写到一半');
    expect(root.querySelector('.incomplete-note')?.textContent).toBe('内容不完整：生成中断，文章不完整');
    vi.advanceTimersByTime(200);
    expect(root.dataset.state).toBe('failed');
  });

  // 抓：数字提示没显示、显示在正文末尾读者看不到，或者被当作 HTML 解析
  it('finish 带提示时在标题下方逐条显示，正文不变；没有提示时不加提示框', () => {
    const root = document.createElement('div');
    const view = createArticleView(root);
    const warning = numberWarningText({ time: '34:25', fragment: 'of,200', written: ['1200', '1,200'] });
    expect(warning).toBe('字幕 34:25 附近有一处数字残缺（原文"of,200"），文中写成了"1200"、"1,200"，疑似补全了残缺数字，请核对原字幕或原视频。');
    view.finish('# 标题\n\n## 第一章\n\n大约有1200项法案。', [warning, '<b>第二条</b>']);
    const notice = root.querySelector('h1 + .article-notice');
    expect([...notice!.querySelectorAll('p')].map((p) => p.textContent)).toEqual([warning, '<b>第二条</b>']);
    expect(notice!.querySelector('b')).toBeNull();
    expect(root.querySelector('.chapter-body p')?.textContent).toBe('大约有1200项法案。');

    view.finish('# 标题\n\n## 第一章\n\n正文');
    expect(root.querySelector('.article-notice')).toBeNull();
  });

  it('reset 清空文章和状态，取消待执行的重绘', () => {
    const root = document.createElement('div');
    const view = createArticleView(root);
    view.update('## 第一章\n\n正文');
    view.reset();
    vi.advanceTimersByTime(200);
    expect(root.childNodes).toHaveLength(0);
    expect(root.dataset.state).toBeUndefined();
  });
});
