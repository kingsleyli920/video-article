import { articleText } from '../shared/article';
import type { NumberWarning } from '../shared/types';
import type { DamagedNumber } from './youtube';

/** 完整数字：带千分位（1,200 或 1，200）或连续数字 */
const NUMBER = /\d{1,3}(?:[,，]\d{3})+|\d+/g;

const digitsOf = (written: string) => written.replace(/[,，]/g, '');

/**
 * 轻量检查，只用来提示，不改正文。依据整理字幕时保留的残缺数字证据（damagedNumbers，如 "of,200"，前面的数字被吞掉），
 * 看文章有没有把它写成确定的数：文中出现以这三位数结尾、位数更多的数字（如 1200、1,200），
 * 而这个数在交给模型的字幕正文里从没有完整出现过，就记一条。
 * 交给模型的正文里残缺数字已经换成占位，检查仍用保留下来的原始证据，不会因此失去作用。
 *
 * 不识别中文数字（"一千二百"）和"上千""数千"这类说法；也不判断位置，文中别处恰好有同样结尾的数字也会被提示。
 */
export function checkDamagedNumbers(damagedNumbers: DamagedNumber[], transcriptText: string, markdown: string): NumberWarning[] {
  if (damagedNumbers.length === 0) return [];
  const inTranscript = new Set([...transcriptText.matchAll(NUMBER)].map((m) => digitsOf(m[0])));
  const articleNumbers = [...articleText(markdown).matchAll(NUMBER)].map((m) => m[0]);

  const warnings: NumberWarning[] = [];
  for (const damaged of damagedNumbers) {
    const written = [
      ...new Set(
        articleNumbers.filter((n) => {
          const digits = digitsOf(n);
          return digits.length > damaged.digits.length && digits.endsWith(damaged.digits) && !inTranscript.has(digits);
        }),
      ),
    ];
    if (written.length) warnings.push({ time: damaged.time, fragment: damaged.fragment, written });
  }
  return warnings;
}
