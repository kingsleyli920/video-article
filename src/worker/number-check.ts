import { articleText } from '../shared/article';
import type { NumberWarning } from '../shared/types';
import { DAMAGED_NUMBER_MARK } from './youtube';

const DAMAGED = new RegExp(`([^\\s,\\d]*),(\\d{3})${DAMAGED_NUMBER_MARK}`, 'g');
const TIMESTAMP = /\[((?:\d+:)?\d{2}:\d{2})\]/g;
/** 完整数字：带千分位（1,200 或 1，200）或连续数字 */
const NUMBER = /\d{1,3}(?:[,，]\d{3})+|\d+/g;

const digitsOf = (written: string) => written.replace(/[,，]/g, '');

/**
 * 轻量检查，只用来提示，不改正文。字幕里标了〔字幕数字残缺〕的地方（如 "of,200"，前面的数字被吞掉），
 * 看文章有没有把它写成确定的数：文中出现以这三位数结尾、位数更多的数字（如 1200、1,200），
 * 而这个数在字幕里从没有完整出现过，就记一条。
 *
 * 不识别中文数字（"一千二百"）和"上千""数千"这类说法；也不判断位置，文中别处恰好有同样结尾的数字也会被提示。
 */
export function checkDamagedNumbers(transcriptText: string, markdown: string): NumberWarning[] {
  const damaged = [...transcriptText.matchAll(DAMAGED)];
  if (damaged.length === 0) return [];

  const stamps = [...transcriptText.matchAll(TIMESTAMP)].map((m) => ({ index: m.index, time: m[1]! }));
  const inTranscript = new Set([...transcriptText.matchAll(NUMBER)].map((m) => digitsOf(m[0])));
  const articleNumbers = [...articleText(markdown).matchAll(NUMBER)].map((m) => m[0]);

  const warnings: NumberWarning[] = [];
  for (const match of damaged) {
    const tail = match[2]!;
    const written = [
      ...new Set(
        articleNumbers.filter((n) => {
          const digits = digitsOf(n);
          return digits.length > tail.length && digits.endsWith(tail) && !inTranscript.has(digits);
        }),
      ),
    ];
    if (written.length === 0) continue;
    const time = stamps.filter((s) => s.index < match.index).at(-1)?.time ?? null;
    warnings.push({ time, fragment: `${match[1]},${tail}`, written });
  }
  return warnings;
}
