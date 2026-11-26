import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBackend, VIDEO_URL, closePage, openPage, streamFullArticle, submitWith } from './support';

// 单独一个文件：页面脚本在 window 上挂的离开确认会跟着 window 走，和别的用例放在一起会互相影响
let backend: FakeBackend;

beforeEach(async () => {
  await openPage();
  backend = new FakeBackend();
});
afterEach(closePage);

describe('离开页面前的确认', () => {
  const leave = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  // 抓：生成中误触刷新，没有任何确认就把几分钟的生成丢了；或者平时离开页面也被拦
  it('生成中离开会让浏览器先确认；没在生成、以及生成结束后不拦', async () => {
    expect(leave()).toBe(false);
    await submitWith(VIDEO_URL);
    expect(leave()).toBe(true);
    await streamFullArticle(backend.stream);
    expect(leave()).toBe(false);
    vi.clearAllTimers();
  });
});
