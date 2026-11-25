import { SUMMARY_FIELDS, type ChapterSummary } from '../shared/types';
import { AppError } from './app-error';

/** 交给 Gemini 的结构化输出约束：六个字符串字段，顺序固定。 */
export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, { type: 'string' }])),
  required: [...SUMMARY_FIELDS],
  propertyOrdering: [...SUMMARY_FIELDS],
} as const;

/** 六个字段都必须存在且是字符串（或 null）；空字符串统一成 null，表示原文未明确提及。 */
export function normalizeSummary(raw: unknown): ChapterSummary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('summary_invalid', '不是对象');
  const record = raw as Record<string, unknown>;
  const summary = {} as ChapterSummary;
  for (const field of SUMMARY_FIELDS) {
    const value = record[field];
    if (value === null) summary[field] = null;
    else if (typeof value === 'string') summary[field] = value.trim() || null;
    else throw new AppError('summary_invalid', `${field} 缺失或类型错误`);
  }
  return summary;
}
