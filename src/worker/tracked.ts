/**
 * 带位置记录的文本。几路核对针对同一份初稿各自提出修订，判断"两条建议是不是改的同一处""这一处是不是已经改好了"
 * 必须按位置，不能按文字：另一段里出现一模一样的文字，不代表这一处已经改过。
 * 这里把每次替换记成"初稿的 [start, end) 现在是什么文字"，任何时候都能回答：
 * - 当前文本里的某一段，对应初稿的哪一段；
 * - 初稿的某一段有没有被改过，现在是什么样子。
 */
export interface Span {
  start: number;
  end: number;
}

interface Edit extends Span {
  /** 初稿的 [start, end) 现在的文字 */
  text: string;
}

/** 当前文本按顺序切成的片段：没改过的原文，或一次替换后的文字 */
interface Piece {
  curStart: number;
  curEnd: number;
  origStart: number;
  origEnd: number;
  edited: boolean;
}

export class TrackedText {
  /** 互不重叠，按 start 升序 */
  private edits: Edit[] = [];

  constructor(readonly original: string) {}

  get current(): string {
    let out = '';
    let at = 0;
    for (const e of this.edits) {
      out += this.original.slice(at, e.start) + e.text;
      at = e.end;
    }
    return out + this.original.slice(at);
  }

  get editCount(): number {
    return this.edits.length;
  }

  private pieces(): Piece[] {
    const pieces: Piece[] = [];
    let orig = 0;
    let cur = 0;
    const plain = (until: number) => {
      if (until > orig) pieces.push({ curStart: cur, curEnd: cur + (until - orig), origStart: orig, origEnd: until, edited: false });
      cur += until - orig;
      orig = until;
    };
    for (const e of this.edits) {
      plain(e.start);
      pieces.push({ curStart: cur, curEnd: cur + e.text.length, origStart: e.start, origEnd: e.end, edited: true });
      cur += e.text.length;
      orig = e.end;
    }
    plain(this.original.length);
    return pieces;
  }

  /** 当前坐标的一段 → 初稿坐标。碰到替换过的文字时，把整次替换都包进来（范围只会变大，不会切开一次替换） */
  toOriginal(span: Span): Span {
    const pieces = this.pieces().filter((p) => p.curEnd > p.curStart);
    const at = (pos: number) => pieces.find((p) => pos >= p.curStart && pos < p.curEnd);
    const first = at(span.start);
    const last = span.end > span.start ? at(span.end - 1) : first;
    const start = !first ? this.original.length : first.edited ? first.origStart : first.origStart + (span.start - first.curStart);
    const end = !last ? this.original.length : last.edited ? last.origEnd : span.end > span.start ? last.origStart + (span.end - last.curStart) : start;
    return { start, end: Math.max(start, end) };
  }

  /** 初稿坐标的一段 → 当前坐标。落在某次替换内部时，同样把整次替换都包进来 */
  toCurrent(span: Span): Span {
    const pieces = this.pieces();
    const total = pieces.at(-1)?.curEnd ?? 0;
    const at = (pos: number) => pieces.find((p) => p.origEnd > p.origStart && pos >= p.origStart && pos < p.origEnd);
    const first = at(span.start);
    const last = span.end > span.start ? at(span.end - 1) : first;
    const start = !first ? total : first.edited ? first.curStart : first.curStart + (span.start - first.origStart);
    const end = !last ? total : last.edited ? last.curEnd : span.end > span.start ? last.curStart + (span.end - last.origStart) : start;
    return { start, end: Math.max(start, end) };
  }

  /** 当前坐标的这一段有没有碰到替换过的文字（紧挨着不算；删除类替换夹在这一段中间也算） */
  touchesEdit(current: Span): boolean {
    return this.pieces().some((p) => p.edited && (p.curEnd > p.curStart ? current.start < p.curEnd && p.curStart < current.end : p.curStart > current.start && p.curStart < current.end));
  }

  /** 初稿的这一段有没有被改过 */
  touched(original: Span): boolean {
    return this.edits.some((e) => e.start < original.end && original.start < e.end);
  }

  /**
   * 初稿的这一段连同与它重叠的所有替换，合起来在初稿和当前文本里各是什么。
   * 用来判断"这一处现在是不是已经是建议想要的样子"。
   */
  region(original: Span): { original: string; current: string } {
    let { start, end } = original;
    for (const e of this.edits) {
      if (e.start < original.end && original.start < e.end) {
        start = Math.min(start, e.start);
        end = Math.max(end, e.end);
      }
    }
    const cur = this.toCurrent({ start, end });
    return { original: this.original.slice(start, end), current: this.current.slice(cur.start, cur.end) };
  }

  /** 把当前坐标的一段换成 text，记成对初稿的一次替换；碰到已有的替换时并成一次 */
  replace(current: Span, text: string): void {
    const now = this.current;
    const orig = this.toOriginal(current);
    const widened = this.toCurrent(orig);
    const merged = now.slice(widened.start, current.start) + text + now.slice(current.end, widened.end);
    const kept = this.edits.filter((e) => e.end <= orig.start || e.start >= orig.end);
    this.edits = [...kept, { start: orig.start, end: orig.end, text: merged }].sort((a, b) => a.start - b.start || a.end - b.end);
  }
}
