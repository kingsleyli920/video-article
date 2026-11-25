import { describe, expect, it } from 'vitest';
import { buildSource, formatDuration, languageName } from '../../src/client/source-panel';

describe('formatDuration', () => {
  // 抓：不到一小时写成 0:12:34、超过一小时分钟或秒不补零，或者未知时长（0、负数、NaN）显示成 00:00
  it.each([
    [0, ''],
    [-5, ''],
    [Number.NaN, ''],
    [59, '00:59'],
    [754, '12:34'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [4878, '1:21:18'],
    [36005, '10:00:05'],
  ])('%s 秒 → "%s"', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe('languageName', () => {
  // 抓：语言代码没换成中文名，或者认不出的、空的代码让渲染抛异常
  it.each([
    ['en', '英语'],
    ['zh-Hans', '简体中文'],
    ['ja', '日语'],
    ['a.en', 'a.en'],
    ['', ''],
  ])('"%s" → "%s"', (code, expected) => {
    expect(languageName(code)).toBe(expected);
  });
});

describe('buildSource', () => {
  // 抓：频道或时长缺失时多出空行、多余的"·"或"时长 "；标题为空时整行空白
  it('标题为空、频道为空、时长未知：来源视频一行只写视频 id，不留空的内容', () => {
    const root = document.createElement('section');
    root.append(
      ...buildSource({
        video: { id: 'dQw4w9WgXcQ', title: '', channel: '', lengthSeconds: 0 },
        transcript: { source: 'live', language: 'en', kind: 'manual', chars: 0 },
      }),
    );
    const rows = [...root.querySelectorAll('.source-row')].map((row) => [...row.children].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['来源视频', 'dQw4w9WgXcQ'],
      ['字幕', '英语 · 人工字幕', '整理后 0 字符'],
      ['字幕来源', 'YouTube 实时获取'],
    ]);
    expect(root.querySelector('details')).toBeNull();
  });
});
