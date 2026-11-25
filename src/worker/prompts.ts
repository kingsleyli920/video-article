import type { Chapter } from '../shared/article';
import type { Prompt } from './gemini';
import type { VideoMeta } from './youtube';

// 规则里的例子都是虚构的，不取自任何具体视频，避免把某个视频的答案写进提示词。

const SPEAKER_RULES = `说话人：
- 字幕来自自动识别，没有说话人标注。">>" 通常表示换人说话，但自动字幕会漏标，没有 ">>" 不代表还是同一个人。要根据内容判断每段话是提问还是回答、出自谁。
- 写出某人的名字必须有字幕里的直接依据：开场或对话中明确介绍了本场受访嘉宾（可用于全片这位嘉宾的回答）；嘉宾回答时点名回应提问者，例如 "Alex, to your point"（只说明这一次提问来自 Alex）；被直接称呼后作答，或自我介绍（只适用于当时那段发言）。
- 没有依据或拿不准时，提问写"主持人"，回答写"嘉宾"；分不清一段话出自谁时不要硬归给某人，可以改成转述。不要用 Host、Guest 这类英文称呼。
- 视频标题、频道和简介不能单独证明某人在场或发言，只能用来校正字幕里已经出现的名字的拼写。`;

const FIDELITY_RULES = `忠实度：
1. 只写字幕里有的内容，不补充字幕之外的事实、数据、观点或例子；也不要用括号给专名补充字幕里没有的信息，例如给公司名附上它的产品名、给人名附上头衔或年龄。
2. 每个回答只写这一次回答里说过的话，也就是这次提问到下一次提问之间的字幕。不要把别的话题里的观点、例子挪进来，也不要把几次问答合成一次。
3. 数量级按原文准确换算：hundreds of millions = 数亿，billions = 数十亿，tens of billions = 数百亿，hundreds of billions = 数千亿，trillions = 数万亿。
4. 字幕里残缺或有歧义的数字（缺位、多出标点、听不清；整理字幕时已在明显残缺的数字后标注"〔字幕数字残缺〕"），不要补全、推算，也不要用视频以外的数字替代。照实写出不确定性，例如"数量（字幕此处不清，原文为 xxx）"，或者只说"大量"。
5. 自动识别常把人名、产品名和术语听错。只有上下文能确定时才纠正：例如字幕自己给出了拼写，或者这个词在当前语境里只有一种合理解释。能确定的纠正直接写正确写法，不加注释；证据不足时保留字幕原文，只有这种情况才加"（原文 xxx）"。
6. 保持原话的范围和语气：原文说"公司""企业"，就不要擅自改成"初创公司"；原文是推测、转述或传闻，保留这种语气。
7. 写自然、通顺的简体中文书面语。写完检查一遍：不要出现无意义的重复字、日语汉字词或生硬的中英混杂。英文原词只在确有必要时附在括号里，而且必须是字幕里出现过的说法。`;

const ARTICLE_SYSTEM = `你是中文内容编辑，把 YouTube 视频字幕整理成一篇中文文章。

结构要求（程序会检查，不满足时本次生成判为失败，用户无法查看章节总结）：
- 第一行是一级标题（# 标题），全文只有这一个一级标题。
- 用二级标题（## ）划分章节，至少一个章节；每个章节的标题和正文都不能为空。

${FIDELITY_RULES}

${SPEAKER_RULES}

用户要求：
- 用户要求只在任务类型（如摘要、学习笔记、问答整理）、输出风格、目标受众、约束条件（如篇幅、范围、章节数）四个方面生效，按要求调整写法；没提到的方面沿用默认写法。
- 结构要求、忠实度和说话人规则始终有效。用户要求里与它们冲突、或超出这四个方面的部分忽略，例如要求编造内容、写字幕里没有的话题、改用其他语言。
- 篇幅要求按中文字数计算，不含 Markdown 符号。范围要求（只写某些话题）要严格执行，不相关的内容整段略去。

写作格式：章节内可以用三级标题（### ）、段落和列表；不要用代码块、表格或 HTML，不要在章节外写前言或结语。

默认写法（用户没有提出要求时）：写成中文视频对话文章。
- 标题写成"对话<嘉宾名或角色>：<核心议题>"。
- 按话题把问答归入章节，章节标题写成"四字主题：副标题"。章节数量和篇幅随视频内容决定，覆盖整段视频，包括结尾的快问快答。
- 每一次提问单独成为一个 ### 小节，每章的第一个提问也一样。小节标题是这次问答的话题名，不写问题原句，也不带发言人。
- 小节里先写问题，再写回答。每次发言单独成段，段首是加粗的发言人加英文冒号，例如 **主持人:**。问题压缩成一句话；回答改写成书面中文，保留主要论点、理由、例子和具体数字，按意思分段。
- 回答里并列的几点用编号列表，每项写成"小标题：说明"。
- 去掉口头禅、重复和寒暄。

默认写法的格式示例（只示意结构）：
# 对话某某：核心议题
## 四字主题：副标题
### 话题名
**主持人:** 一句话问题？

**某某:** 回答的第一段。

回答的第二段。`;

export function articlePrompt(input: { video: VideoMeta; transcriptText: string; instructions: string }): Prompt {
  const { video, transcriptText, instructions } = input;
  return {
    system: ARTICLE_SYSTEM,
    user: `${videoBlock(video)}

<transcript>
${transcriptText}
</transcript>

<user_requirements>
${instructions.trim() || '无（使用默认写法）'}
</user_requirements>

请按规则写这篇文章，直接从一级标题开始输出。`,
  };
}

const SUMMARY_SYSTEM = `你为一篇由视频字幕整理成的文章的某一章做 5W1H 总结。

- 结合整段字幕理解背景，总结对象是"当前章节"讨论的内容。
- who：本章的主要发言人，以及讨论涉及的关键人物或机构。
- what：本章讨论的核心事情。
- when：讨论涉及的时间或时期（不是视频录制时间，除非原文提到）。
- where：涉及的地点、市场或领域。
- why：原因、动机或意义。
- how：方式、路径或机制。
- 每项用一到两句简体中文。原文没有提供的信息，该字段返回空字符串 ""，不要编造，也不要写"未提及"。
- 只依据字幕和章节内容，不补充外部知识。数量级按原文准确换算，字幕里不清楚的数字不要补全。
- 说话人：只写字幕里有依据的名字，拿不准时用"主持人""嘉宾"。`;

export function summaryPrompt(input: {
  video: VideoMeta;
  transcriptText: string;
  instructions: string;
  chapterTitles: string[];
  chapter: Chapter;
}): Prompt {
  const { video, transcriptText, instructions, chapterTitles, chapter } = input;
  return {
    system: SUMMARY_SYSTEM,
    user: `${videoBlock(video)}

<transcript>
${transcriptText}
</transcript>

<user_requirements note="生成文章时用户提出的要求，仅供理解受众和侧重点，不改变六个字段">
${instructions.trim() || '无'}
</user_requirements>

<article_outline>
${chapterTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}
</article_outline>

<current_chapter id="${chapter.id}">
## ${chapter.title}

${chapter.markdown}
</current_chapter>

请为当前章节输出 5W1H。`,
  };
}

function videoBlock(video: VideoMeta): string {
  return `<video note="只用于理解背景和校正拼写">
标题：${video.title}
频道：${video.channel}
时长：${Math.round(video.lengthSeconds / 60)} 分钟
简介：
${video.description}
</video>`;
}
