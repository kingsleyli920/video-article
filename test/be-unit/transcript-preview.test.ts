import { describe, expect, it } from 'vitest';
import { transcriptPreview } from '../../src/worker/transcript-preview';

describe('transcriptPreview', () => {
  // 抓：预览把整篇字幕传给页面，或者丢了原始时间戳
  it('在开头、约三分之一、约三分之二处各取一段，每段不超过上限，带原始时间戳', () => {
    const cues = Array.from({ length: 9 }, (_, i) => ({ start: i * 60_000, text: `第${i}条字幕` }));
    expect(transcriptPreview(cues, { maxChars: 12 })).toEqual([
      { time: '00:00', text: '第0条字幕 第1条字幕' },
      { time: '03:00', text: '第3条字幕 第4条字幕' },
      { time: '06:00', text: '第6条字幕 第7条字幕' },
    ]);
  });

  // 抓：单条字幕本身超过上限时预览为空，或者没有截断
  it('单条字幕超过上限时截断并加省略号；超过一小时用 h:mm:ss；没有字幕时返回空', () => {
    expect(transcriptPreview([{ start: 3_725_000, text: 'abcdefghij' }], { snippets: 1, maxChars: 5 })).toEqual([{ time: '1:02:05', text: 'abcd…' }]);
    expect(transcriptPreview([])).toEqual([]);
  });

  // 抓：字幕很短时三段互相重叠，同一句在预览里出现两三次
  it('字幕只有三条时三段各取一条，不重复', () => {
    const cues = [
      { start: 0, text: 'welcome to the show' },
      { start: 5_000, text: 'first question' },
      { start: 2_065_000, text: 'on the order of,200 bills' },
    ];
    expect(transcriptPreview(cues)).toEqual([
      { time: '00:00', text: 'welcome to the show' },
      { time: '00:05', text: 'first question' },
      { time: '34:25', text: 'on the order of,200 bills' },
    ]);
  });
});
