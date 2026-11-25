import { describe, expect, it } from 'vitest';
import { parseVideoId } from '../../src/shared/video-id';

describe('parseVideoId', () => {
  // 抓：常见分享格式解析不出 ID，用户粘贴后直接报"链接无效"
  it.each([
    ['https://www.youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/watch?v=xRh2sVcNXQ8&t=120s', 'xRh2sVcNXQ8'],
    ['https://youtu.be/xRh2sVcNXQ8?si=abc', 'xRh2sVcNXQ8'],
    ['https://m.youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/shorts/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/embed/xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
    ['https://www.youtube.com/live/xRh2sVcNXQ8?feature=share', 'xRh2sVcNXQ8'],
    ['www.youtube.com/watch?v=xRh2sVcNXQ8', 'xRh2sVcNXQ8'],
  ])('%s → %s', (input, id) => {
    expect(parseVideoId(input)).toBe(id);
  });

  // 抓：把非 YouTube 域名或长度不对的 ID 放行到后端
  it.each([
    'https://example.com/watch?v=xRh2sVcNXQ8',
    'https://www.youtube.com.evil.com/watch?v=xRh2sVcNXQ8',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/channel/UC123',
    '不是链接',
    '',
  ])('%s → null', (input) => {
    expect(parseVideoId(input)).toBeNull();
  });
});
