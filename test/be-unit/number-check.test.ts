import { describe, expect, it } from 'vitest';
import { checkDamagedNumbers } from '../../src/worker/number-check';
import type { DamagedNumber } from '../../src/worker/youtube';

// 交给模型的正文里残缺数字已经换成占位；检查依据的是整理字幕时保留下来的原始证据
const TRANSCRIPT = [
  "[15:11] there's just hundreds of billions or at this point trillions of dollars",
  "[34:25] >> we're tracking on the order of〔字幕此处数字不清，无法确定具体数量〕 bills across the 50 states.",
  '[40:02] $200 or $300 per month tiers',
].join('\n\n');
const DAMAGED: DamagedNumber[] = [{ time: '34:25', fragment: 'of,200', digits: '200', cue: "we're tracking on the order of,200 bills across the 50 states." }];

describe('checkDamagedNumbers', () => {
  // 抓：模型把 "of,200" 补成 1200 或 1,200，页面却没有任何提示；或者输入被遮蔽之后检查失去依据
  it('残缺数字被写成更长的确定数（1200、1,200）时报出，时间和原文片段来自保留的证据', () => {
    const markdown = '# 标题\n\n## 监管\n\n目前全美大约有1200项相关法案。\n\n另一处写成 1,200 项。';
    expect(checkDamagedNumbers(DAMAGED, TRANSCRIPT, markdown)).toEqual([{ time: '34:25', fragment: 'of,200', written: ['1200', '1,200'] }]);
  });

  // 抓：保留不确定写法、出现同样三位数的其他金额时被误报
  it('保留不确定写法、出现同样三位数的其他金额时不报', () => {
    const markdown = '# 标题\n\n## 监管\n\n各州正在审议大量法案（字幕此处数字不清）。\n\n## 定价\n\n每月 200 或 300 美元的订阅层级。';
    expect(checkDamagedNumbers(DAMAGED, TRANSCRIPT, markdown)).toEqual([]);
  });

  // 抓：字幕别处明确说过的数字被当成补出来的数
  it('文中的数在字幕正文里完整出现过时不报', () => {
    const transcript = `${TRANSCRIPT}\n\n[50:00] about 1,200 people were there`;
    expect(checkDamagedNumbers(DAMAGED, transcript, '# 标题\n\n## 活动\n\n现场有 1200 人。')).toEqual([]);
  });

  // 抓：没有残缺证据时也去检查，误报正常数字
  it('没有残缺证据时不检查', () => {
    expect(checkDamagedNumbers([], '[00:10] about 1,200 bills', '# 标题\n\n## 一\n\n有 3200 项。')).toEqual([]);
  });
});
