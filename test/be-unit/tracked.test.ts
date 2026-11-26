import { describe, expect, it } from 'vitest';
import { TrackedText } from '../../src/worker/tracked';

describe('TrackedText', () => {
  // 抓：位置换算写错，替换后的文本和直接做字符串替换的结果不一致
  it('随机做 2000 轮替换：current 始终等于直接替换的结果，坐标换算自洽', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 2000; round++) {
      const original = Array.from({ length: 30 + rand(30) }, () => 'abcdefghij'[rand(10)]).join('');
      const tracked = new TrackedText(original);
      let naive = original;
      for (let step = 0; step < 6; step++) {
        const start = rand(naive.length);
        const end = Math.min(naive.length, start + 1 + rand(5));
        const text = ['', 'X', 'YY', 'ZZZZ'][rand(4)]!;
        tracked.replace({ start, end }, text);
        naive = naive.slice(0, start) + text + naive.slice(end);
        expect(tracked.current).toBe(naive);
        // 任取当前文本的一段：换到初稿坐标再换回来，范围只会变大，并且把原来那一段包在里面
        if (naive.length > 0) {
          const s = rand(naive.length);
          const e = Math.min(naive.length, s + 1 + rand(4));
          const back = tracked.toCurrent(tracked.toOriginal({ start: s, end: e }));
          expect(back.start).toBeLessThanOrEqual(s);
          expect(back.end).toBeGreaterThanOrEqual(e);
        }
      }
    }
  });

  // 抓：按文字而不是按位置判断"这一处改过没有"
  it('两处文字相同，只改第二处：第一处没被碰过，第二处的 region 给出改前改后的文字', () => {
    const t = new TrackedText('主持人说成本200美元。嘉宾说成本200美元。');
    const second = t.original.lastIndexOf('成本200美元');
    t.replace({ start: second, end: second + 7 }, '成本20美元');
    expect(t.current).toBe('主持人说成本200美元。嘉宾说成本20美元。');
    expect(t.touched({ start: 4, end: 11 })).toBe(false);
    expect(t.touched({ start: second, end: second + 7 })).toBe(true);
    expect(t.region({ start: second + 2, end: second + 5 })).toEqual({ original: '成本200美元', current: '成本20美元' });
    expect(t.region({ start: 4, end: 11 })).toEqual({ original: '成本200美元', current: '成本200美元' });
  });

  // 抓：紧挨着替换处的文字被误判成"碰到了替换"；替换内部的一段没被判成碰到
  it('touchesEdit：重叠算，紧挨着不算；toOriginal 碰到替换时包住整次替换', () => {
    const t = new TrackedText('甲乙丙丁戊己');
    t.replace({ start: 2, end: 4 }, '似乎丙丁');
    expect(t.current).toBe('甲乙似乎丙丁戊己');
    expect(t.touchesEdit({ start: 0, end: 2 })).toBe(false);
    expect(t.touchesEdit({ start: 6, end: 8 })).toBe(false);
    expect(t.touchesEdit({ start: 4, end: 6 })).toBe(true);
    expect(t.touchesEdit({ start: 1, end: 3 })).toBe(true);
    expect(t.toOriginal({ start: 4, end: 6 })).toEqual({ start: 2, end: 4 });
    expect(t.toOriginal({ start: 5, end: 7 })).toEqual({ start: 2, end: 5 });
    expect(t.toOriginal({ start: 6, end: 8 })).toEqual({ start: 4, end: 6 });
  });

  // 抓：删除类替换（换成空串）之后位置错位
  it('删除一段之后再改后面的文字：位置不串', () => {
    const t = new TrackedText('一二三四五六七八');
    t.replace({ start: 2, end: 4 }, '');
    expect(t.current).toBe('一二五六七八');
    t.replace({ start: 4, end: 5 }, '柒');
    expect(t.current).toBe('一二五六柒八');
    expect(t.touchesEdit({ start: 1, end: 3 })).toBe(true);
    expect(t.touchesEdit({ start: 2, end: 4 })).toBe(false);
    expect(t.region({ start: 6, end: 7 })).toEqual({ original: '七', current: '柒' });
  });
});
