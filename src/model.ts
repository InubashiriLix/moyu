import type { Book, Position } from './types';

export interface Block {
  chapter: number;
  offset: number;
  text: string;
  heading: boolean;
  continuation: boolean;
}
export interface Match extends Position { length: number }

/** Blocks use JS UTF-16 offsets, shared by DOM Range and saved positions. */
export function blocksFor(book: Book): Block[] {
  const blocks: Block[] = [];
  book.chapters.forEach((chapter, index) => {
    blocks.push({ chapter: index, offset: -1, text: chapter.title, heading: true, continuation: false });
    const paragraphs = /[^\n]+/g;
    let paragraph: RegExpExecArray | null;
    while ((paragraph = paragraphs.exec(chapter.text))) {
      const text = paragraph[0];
      let offset = 0;
      while (offset < text.length) {
        let end = Math.min(offset + 400, text.length);
        // Do not cut an emoji / supplementary CJK character in half.
        if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
        blocks.push({ chapter: index, offset: paragraph.index + offset, text: text.slice(offset, end), heading: false, continuation: offset > 0 });
        offset = end;
      }
    }
  });
  return blocks;
}

export function findMatches(book: Book, query: string, limit = 10000): Match[] {
  if (!query.trim()) return [];
  const matches: Match[] = [];
  // Literal matching avoids regex injection and keeps UTF-16 offsets exact.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'giu');
  for (let chapter = 0; chapter < book.chapters.length; chapter++) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(book.chapters[chapter].text))) {
      matches.push({ chapter, offset: match.index, length: match[0].length });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

export function comparePosition(a: Position, b: Position): number {
  return a.chapter - b.chapter || a.offset - b.offset;
}

export function blockAt(blocks: Block[], position: Position): number {
  let low = 0, high = blocks.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (comparePosition(blocks[mid], position) <= 0) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Prefix sums allow a million-word book to scroll without a million DOM nodes. */
export class Heights {
  private tree: Float64Array;
  readonly values: Float64Array;
  constructor(values: number[]) {
    this.values = Float64Array.from(values);
    this.tree = new Float64Array(values.length + 1);
    values.forEach((value, index) => this.add(index, value));
  }
  private add(index: number, value: number) {
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i] += value;
  }
  set(index: number, value: number) {
    this.add(index, value - this.values[index]);
    this.values[index] = value;
  }
  prefix(end: number): number {
    let sum = 0;
    for (let i = end; i > 0; i -= i & -i) sum += this.tree[i];
    return sum;
  }
  get total(): number { return this.prefix(this.values.length); }
  at(height: number): number {
    let index = 0, sum = 0;
    let bit = 2 ** Math.floor(Math.log2(Math.max(1, this.values.length)));
    for (; bit > 0; bit = Math.floor(bit / 2)) {
      const next = index + bit;
      if (next < this.tree.length && sum + this.tree[next] <= height) {
        sum += this.tree[next]; index = next;
      }
    }
    return Math.min(index, Math.max(0, this.values.length - 1));
  }
}
