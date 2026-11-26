import { describe, expect, it } from 'vitest';
import { bodyGrowth, worthKeeping, type Sample } from '../e2e/live/body-growth';

describe('bodyGrowth', () => {
  // 抓：长文章正常流式被误判（规则写得太死，比如要求某个固定的增长次数或时长）
  it('长文章正常流式：等了一分钟才开始出字，之后一路增长到完成，判通过', () => {
    const samples: Sample[] = [
      [400, 0],
      [1900, 0],
      [31900, 0],
      [61900, 0],
      [63400, 210],
      [64900, 655],
      [66400, 1130],
      [90000, 7420],
      [110000, 9980],
      [111500, 10300],
      [113000, 10300],
    ];
    expect(bodyGrowth(samples, 112200)).toEqual({ ok: true, reason: '', baseLength: 0, draftLength: 10300, intermediateSamples: 5, distinctLengths: 5 });
  });

  // 抓：机械要求很长的流式阶段或很多个不同的采样值，短文章（正文半秒内发完）的真流式被判不通过
  it('短文章正常流式：正文不到半秒发完，完成前只抓到两次中间长度，判通过', () => {
    const samples: Sample[] = [
      [900, 0],
      [2400, 0],
      [29900, 0],
      [30000, 0],
      [30100, 96],
      [30200, 207],
      [30300, 334],
      [30400, 334],
      [30500, 334],
    ];
    expect(bodyGrowth(samples, 30450)).toEqual({ ok: true, reason: '', baseLength: 0, draftLength: 334, intermediateSamples: 2, distinctLengths: 2 });
  });

  // 抓：把"至少一次中间长度"写成了"至少两次/三次"
  it('完成前只看到一次中间长度也算', () => {
    expect(bodyGrowth([[900, 0], [30100, 120], [30500, 334]], 30450)).toMatchObject({ ok: true, intermediateSamples: 1 });
  });

  // 抓：正文等全部生成完才一次贴到页面上，用例却照样通过
  it('一次性贴出：完成前一直是 0 字，完成时一步到位，判不通过', () => {
    const samples: Sample[] = [
      [900, 0],
      [2400, 0],
      [29900, 0],
      [30400, 0],
      [30500, 334],
    ];
    expect(bodyGrowth(samples, 30450)).toEqual({
      ok: false,
      reason: '初稿写完前没有看到中间长度：正文从 0 字一步变成 334 字',
      baseLength: 0,
      draftLength: 334,
      intermediateSamples: 0,
      distinctLengths: 0,
    });
  });

  // 抓：只要完成前页面上有字就算流式——服务端攒到模型结束才一次发出时，全文会比完成早一点点出现在页面上
  it('一次性贴出发生在完成前一点点（全文先出现、随后才完成）：没有中间长度，判不通过', () => {
    const samples: Sample[] = [
      [900, 0],
      [29900, 0],
      [30300, 334],
      [30400, 334],
      [30500, 334],
    ];
    expect(bodyGrowth(samples, 30450)).toMatchObject({ ok: false, reason: '初稿写完前没有看到中间长度：正文从 0 字一步变成 334 字' });
  });

  // 抓：页面上留着上一篇文章，新的正文没有画出来，只看"长度大于 0"会当成已经在显示
  it('先显示旧内容再不变：长度从头到尾没有增长，判不通过', () => {
    const samples: Sample[] = [
      [400, 5000],
      [1900, 5000],
      [31900, 5000],
      [60000, 5000],
      [60500, 5000],
    ];
    expect(bodyGrowth(samples, 60200)).toEqual({ ok: false, reason: '正文没有增长：开始时 5000 字，初稿写完时 5000 字', baseLength: 5000, draftLength: 5000, intermediateSamples: 0, distinctLengths: 0 });
  });

  // 抓：旧内容的长度正好落在 0 和新长度之间，被当成"中间长度"
  it('旧内容一直不变，完成时一步换成新文章：旧长度不算中间长度，判不通过', () => {
    const samples: Sample[] = [
      [400, 5000],
      [31900, 5000],
      [60000, 5000],
      [60500, 8000],
    ];
    expect(bodyGrowth(samples, 60200)).toMatchObject({ ok: false, reason: '初稿写完前没有看到中间长度：正文从 5000 字一步变成 8000 字' });
  });

  // 抓：初稿写完之后才采到的中间长度（比如进入核对后页面还在补画）被算成"初稿阶段在增长"
  it('中间长度只出现在初稿写完之后：不算', () => {
    expect(bodyGrowth([[900, 0], [30400, 0], [30500, 120], [30600, 334]], 30450)).toMatchObject({ ok: false, intermediateSamples: 0 });
  });

  // 抓：采样为空或者没采到初稿写完后的状态时，拿不完整的数据得出"通过"
  it('没有采样、或者最后一条采样早于初稿写完：判不通过并说明原因', () => {
    expect(bodyGrowth([], 30450)).toMatchObject({ ok: false, reason: '没有采样' });
    expect(bodyGrowth([[900, 0], [30100, 120], [30200, 334]], 30450)).toMatchObject({ ok: false, reason: '没有初稿写完之后的采样：最后一次采样在 30200 ms，初稿写完在 30450 ms' });
  });

  // 审查方反例。抓：判定看的是"完成"而不是"初稿写完"：整篇初稿一次显示（没有流式），核对后页面因核对记录或最终稿变长，
  // 初稿的长度就落在"开始"和"完成"之间，被当成中间长度判通过
  it('整篇初稿一次显示、随后因核对记录或最终稿变长：初稿阶段没有中间长度，判不通过', () => {
    const samples: Sample[] = [
      [900, 0],
      [59900, 0],
      [60000, 5000],
      [120000, 5000],
      [180100, 5800],
    ];
    expect(bodyGrowth(samples, 60000)).toEqual({
      ok: false,
      reason: '初稿写完前没有看到中间长度：正文从 0 字一步变成 5000 字',
      baseLength: 0,
      draftLength: 5000,
      intermediateSamples: 0,
      distinctLengths: 0,
    });
  });

  // 抓：draftLength 取了最后一条采样（核对后的最终稿），核对后正文变短时初稿阶段的长度不再"小于最终长度"被漏算，
  // 核对后变长时又把初稿写完时的完整长度也算成中间长度
  it.each([
    ['变短', 350],
    ['变长', 900],
  ])('初稿阶段正常增长、核对后正文%s：判通过，draftLength 是进入核对时的长度', (_label, finalLength) => {
    const samples: Sample[] = [
      [900, 0],
      [30100, 120],
      [30150, 120],
      [30200, 250],
      [30300, 400],
      [30500, 400],
      [60000, finalLength],
    ];
    expect(bodyGrowth(samples, 30400)).toEqual({ ok: true, reason: '', baseLength: 0, draftLength: 400, intermediateSamples: 3, distinctLengths: 2 });
  });

  // 回归：线上示例视频最终验收那次（evidence/final/online-sample/run1）的真实采样，抄了开头、开始出字前后和结尾三段。
  // 每 1.5 秒一次，正文 68.9 秒开始到达、约 48 秒发完。证据里没有记 done 到达浏览器的时刻，这里按
  // 服务端保存完成 117891 ms + 浏览器比服务端晚的 91 ms（首个正文分块 68904 − 服务端首个 token 68813）估为 117982 ms。
  // 抓：规则改动后，已经验收通过的真实长文章流式被判不通过
  it('回归：线上示例视频的真实采样（10276 字，流式约 48 秒）判通过', () => {
    const samples: Sample[] = [
      [404, 0],
      [1907, 0],
      [3411, 0],
      [66568, 0],
      [68071, 0],
      [69576, 136],
      [71079, 487],
      [72584, 840],
      [74089, 1156],
      [113219, 9841],
      [114726, 10174],
      [116232, 10517],
      [117738, 10821],
      [119255, 10821],
    ];
    expect(bodyGrowth(samples, 117982)).toEqual({ ok: true, reason: '', baseLength: 0, draftLength: 10821, intermediateSamples: 7, distinctLengths: 7 });
  });

  // 回归：补充验收 V01（268 字的短文）的真实采样结尾。正文 29971 ms 开始到达，服务端 30402 ms 模型结束，前后约 470 毫秒；
  // 当时每 1.5 秒采一次，只看到 0 字和完整的 334 字，中间长度一次都没抓到。done 到达浏览器的时刻按
  // 服务端保存完成 30406 ms + 38 ms（29971 − 29933）估为 30444 ms。
  // 抓：以为 1.5 秒的采样间隔对短文也够用。这次真流式在这个间隔下和"一次性贴出"分不开，所以用例里把采样调密到 100 毫秒
  it('回归：268 字短文按 1.5 秒采样的真实数据看不到中间长度，判不通过（这是把采样调密的原因）', () => {
    const samples: Sample[] = [
      [926, 0],
      [2429, 0],
      [26486, 0],
      [27988, 0],
      [29491, 0],
      [30994, 334],
    ];
    expect(bodyGrowth(samples, 30444)).toMatchObject({ ok: false, reason: '初稿写完前没有看到中间长度：正文从 0 字一步变成 334 字' });
  });
});

describe('worthKeeping', () => {
  // 抓：调密采样后把每 100 毫秒一条全留下（证据文件膨胀十几倍），或者反过来把长度变化的采样丢了
  it('第一条、长度变了的、距上一条满 1.5 秒的留下；长度没变又不到 1.5 秒的不留', () => {
    expect(worthKeeping(undefined, [400, 0])).toBe(true);
    expect(worthKeeping([400, 0], [500, 0])).toBe(false);
    expect(worthKeeping([400, 0], [1899, 0])).toBe(false);
    expect(worthKeeping([400, 0], [1900, 0])).toBe(true);
    expect(worthKeeping([30000, 0], [30100, 96])).toBe(true);
    expect(worthKeeping([30100, 96], [30200, 96])).toBe(false);
  });
});
