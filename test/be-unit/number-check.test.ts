import { describe, expect, it } from 'vitest';
import { checkDamagedNumbers } from '../../src/worker/number-check';
import { markDamagedNumbers } from '../../src/worker/youtube';

// 字幕按 formatTranscript 的格式写：段首时间戳，残缺数字经过 markDamagedNumbers 标注
const TRANSCRIPT = [
  "[15:11] there's just hundreds of billions or at this point trillions of dollars",
  markDamagedNumbers("[34:25] we're tracking on the order of,200 bills across the 50 states."),
  '[40:02] $200 or $300 per month tiers',
].join('\n\n');

describe('checkDamagedNumbers', () => {
  // 抓：模型把 "of,200" 补成 1200 或 1,200，页面却没有任何提示
  it('残缺数字被写成更长的确定数（1200、1,200）时报出，并带上时间和原文片段', () => {
    const markdown = '# 标题\n\n## 监管\n\n目前全美大约有1200项〔字幕数字残缺〕相关法案。\n\n另一处写成 1,200 项。';
    expect(checkDamagedNumbers(TRANSCRIPT, markdown)).toEqual([{ time: '34:25', fragment: 'of,200', written: ['1200', '1,200'] }]);
  });

  // 抓：照抄原文或保留不确定写法也被误报；文中正常的 $200 被误报
  it('照抄原文片段、保留不确定写法、出现同样三位数的其他金额时不报', () => {
    const markdown =
      '# 标题\n\n## 监管\n\n各州正在审议大量法案（字幕此处数字不清，原文为"of,200"）。\n\n## 定价\n\n每月 200 或 300 美元的订阅层级。';
    expect(checkDamagedNumbers(TRANSCRIPT, markdown)).toEqual([]);
  });

  // 抓：字幕别处明确说过的数字被当成补出来的数
  it('文中的数在字幕别处完整出现过时不报', () => {
    const transcript = `${TRANSCRIPT}\n\n[50:00] about 1,200 people were there`;
    expect(checkDamagedNumbers(transcript, '# 标题\n\n## 活动\n\n现场有 1200 人。')).toEqual([]);
  });

  // 抓：没有残缺标记的字幕也做检查，误报正常数字
  it('字幕没有残缺标记时不检查', () => {
    expect(checkDamagedNumbers('[00:10] about 1,200 bills', '# 标题\n\n## 一\n\n有 3200 项。')).toEqual([]);
  });
});
