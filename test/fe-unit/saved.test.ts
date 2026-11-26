// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearArticle, clearPending, loadArticle, markPending, saveArticle, SAVED_TTL_MS, takePending } from '../../src/client/saved';

const ARTICLE = {
  input: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', instructions: '写短一点' },
  generationId: 'gen-1',
  markdown: '# 标题\n\n## 第一章\n\n正文。',
  meta: null,
  done: { chapters: [{ id: '1', title: '第一章' }], chars: 9, timing: { transcriptMs: 1, firstTokenMs: 2, modelDoneMs: 3, savedMs: 4 }, numberWarnings: [], model: 'm', review: { sections: 1, revisions: 0, rewritten: null, checks: [] } },
  revisions: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('保存和读取上次完成的文章', () => {
  // 抓：保存后读不回来，或者读回来的内容和保存的不一样
  it('保存后原样读回，带保存时间', () => {
    saveArticle(ARTICLE, 1_000);
    expect(loadArticle(2_000)).toEqual({ version: 1, savedAt: 1_000, ...ARTICLE });
  });

  // 抓：服务端的上下文 7 天后已经删除，页面却还恢复出一篇点不了 5W1H 的旧文章
  it('满 7 天后不再恢复，并清掉存储；差 1 毫秒时仍能恢复', () => {
    saveArticle(ARTICLE, 0);
    expect(loadArticle(SAVED_TTL_MS - 1)).not.toBeNull();
    expect(loadArticle(SAVED_TTL_MS)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  // 抓：存储里的内容被改坏或来自旧版本时，页面拿残缺的数据去渲染而报错
  it.each([
    ['不是 JSON', '{oops'],
    ['版本不对', JSON.stringify({ version: 2, savedAt: 1, ...ARTICLE })],
    ['正文为空', JSON.stringify({ version: 1, savedAt: 1, ...ARTICLE, markdown: '' })],
    ['没有生成编号', JSON.stringify({ version: 1, savedAt: 1, ...ARTICLE, generationId: '' })],
    ['done 缺章节', JSON.stringify({ version: 1, savedAt: 1, ...ARTICLE, done: { chars: 9 } })],
    ['输入缺字段', JSON.stringify({ version: 1, savedAt: 1, ...ARTICLE, input: { url: 'x' } })],
  ])('存储内容无效（%s）：返回 null', (_label, raw) => {
    localStorage.setItem('video-article:last-article', raw);
    expect(loadArticle(2)).toBeNull();
  });

  it('清除后读不到', () => {
    saveArticle(ARTICLE, 1);
    clearArticle();
    expect(loadArticle(2)).toBeNull();
  });
});

describe('被打断的生成', () => {
  // 抓：取一次之后标记还在，每次刷新都提示"上次被中断"
  it('记下输入后能取出一次，再取就没有了', () => {
    markPending({ url: 'u', instructions: 'i' });
    expect(takePending()).toEqual({ url: 'u', instructions: 'i' });
    expect(takePending()).toBeNull();
  });

  it('清掉之后取不到', () => {
    markPending({ url: 'u', instructions: 'i' });
    clearPending();
    expect(takePending()).toBeNull();
  });
});

describe('本地存储不可用', () => {
  // 抓：隐私模式或存储被禁用时读写抛错，整个页面脚本因此中断
  it('读写都抛错时不报错，当作没有保存', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => saveArticle(ARTICLE)).not.toThrow();
    expect(() => markPending({ url: 'u', instructions: 'i' })).not.toThrow();
    expect(loadArticle()).toBeNull();
    expect(takePending()).toBeNull();
    expect(() => clearArticle()).not.toThrow();
  });
});
