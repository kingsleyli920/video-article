/**
 * 默认场景（test/harness/mock-upstream.ts 的 defaultScenario）下的期望值，全部手写字面量，
 * 不从被测代码或模拟上游导入，免得两边一起错时测试照样通过。
 */

export const MOCK_URL = 'https://www.youtube.com/watch?v=mockvideo01';
export const SAMPLE_URL = 'https://youtu.be/xRh2sVcNXQ8';

/**
 * 默认字幕整理后的正文：每段以 [时间] 开头；">>" 另起一段；
 * "&amp;gt;&amp;gt; we&amp;#39;re" 两层转义解开；残缺数字 "of,200" 后标注〔字幕数字残缺〕。共 135 个字符。
 */
export const TRANSCRIPT_TEXT =
  "[00:00] welcome to the show Alex here let us start with the first question\n\n[34:25] >> we're tracking on the order of,200〔字幕数字残缺〕 bills";
export const TRANSCRIPT_CHARS = 135;

/** 主模型默认输出的整篇文章（三段拼接） */
export const ARTICLE_MARKDOWN =
  '# 对话测试嘉宾：受控上游\n\n## 第一章：开场\n\n**主持人:** 我们从哪里开始？\n\n**嘉宾:** 从第一个问题开始。\n\n## 第二章：数字\n\n**主持人:** 有多少项？\n\n**嘉宾:** 大约有1200项。';
/** 标题和正文的非空白字符数，不含 Markdown 标记 */
export const ARTICLE_CHARS = 68;
export const ARTICLE_CHAPTERS = [
  { id: '1', title: '第一章：开场' },
  { id: '2', title: '第二章：数字' },
];

/** 默认 5W1H 经服务端规整后（空字符串变成 null） */
export const MOCK_SUMMARY_NORMALIZED = { who: '主持人与嘉宾', what: '开场讨论', when: null, where: null, why: '说明背景', how: '问答' };

/** 生成之后换掉的视频数据：5W1H 若重新抓取字幕或元数据，提示词里就会出现 CHANGED 字样 */
export const CHANGED_VIDEO = {
  kind: 'ok' as const,
  title: '生成之后上游改过的标题',
  channel: '改过的频道',
  description: '改过的简介 CHANGED-DESCRIPTION',
  cues: [[0, 'CHANGED-CAPTIONS after the article was generated']] as [number, string][],
};
