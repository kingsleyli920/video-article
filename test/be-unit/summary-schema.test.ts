import { describe, expect, it } from 'vitest';
import { normalizeSummary, SUMMARY_SCHEMA } from '../../src/worker/summary-schema';

const FULL = { who: 'Mark', what: '收入增长', when: '未来十年', where: '企业 AI 市场', why: '效率提升', how: '按 token 计费' };

describe('normalizeSummary', () => {
  it('六个字段齐全时原样返回（去掉首尾空白）', () => {
    expect(normalizeSummary({ ...FULL, who: '  Mark  ' })).toEqual(FULL);
  });

  // 抓：原文未提及的字段被当成有效内容展示成空白，或空串导致前端显示一行空格
  it('空字符串和 null 统一成 null，表示原文未明确提及', () => {
    expect(normalizeSummary({ ...FULL, when: '', where: '   ', why: null })).toEqual({ ...FULL, when: null, where: null, why: null });
  });

  // 抓：模型漏字段或返回数字/数组时仍然保存并渲染
  it.each([
    [{ ...FULL, how: undefined }, 'how 缺失或类型错误'],
    [{ ...FULL, who: 42 }, 'who 缺失或类型错误'],
    [{ ...FULL, what: ['a'] }, 'what 缺失或类型错误'],
  ])('字段缺失或类型错误时报 summary_invalid：%o', (raw, detail) => {
    expect(() => normalizeSummary(raw)).toThrow(`模型返回的总结格式无效，请重试（${detail}）`);
  });

  it.each([null, 'text', [FULL]])('不是对象时报 summary_invalid：%o', (raw) => {
    expect(() => normalizeSummary(raw)).toThrow('模型返回的总结格式无效，请重试（不是对象）');
  });
});

describe('SUMMARY_SCHEMA', () => {
  it('要求六个字符串字段，顺序固定', () => {
    expect(SUMMARY_SCHEMA.required).toEqual(['who', 'what', 'when', 'where', 'why', 'how']);
    expect(SUMMARY_SCHEMA.properties).toEqual({
      who: { type: 'string' },
      what: { type: 'string' },
      when: { type: 'string' },
      where: { type: 'string' },
      why: { type: 'string' },
      how: { type: 'string' },
    });
  });
});
