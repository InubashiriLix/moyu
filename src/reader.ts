import { blockAt, blocksFor, Heights, type Block, type Match } from './model';
import type { Book, Position, Preferences } from './types';

export class Reader {
  private book: Book | null = null;
  private blocks: Block[] = [];
  private heights = new Heights([]);
  private content: HTMLDivElement;
  private mounted = new Map<number, HTMLElement>();
  private prefs: Preferences;
  private frame = 0;
  private settling = false;
  private match: Match | null = null;
  private width = 0;
  private resizeFrame = 0;
  private anchor: Position = { chapter: 0, offset: 0 };
  onPosition: (position: Position) => void = () => {};

  constructor(readonly viewport: HTMLElement, prefs: Preferences) {
    this.prefs = prefs;
    this.content = document.createElement('div');
    this.content.className = 'reader-content';
    viewport.append(this.content);
    viewport.addEventListener('scroll', () => {
      if (!this.frame) this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
        if (!this.settling) { this.anchor = this.position(); this.onPosition(this.anchor); }
      });
    }, { passive: true });
    new ResizeObserver(() => {
      const width = viewport.clientWidth;
      if (width !== this.width) {
        this.width = width;
        // Keep the last pre-resize text anchor, not a pixel scroll offset.
        cancelAnimationFrame(this.resizeFrame);
        this.resizeFrame = requestAnimationFrame(() => this.reflow(this.anchor));
      } else this.render();
    }).observe(viewport);
  }

  load(book: Book, position: Position) {
    this.book = book;
    this.blocks = blocksFor(book);
    this.match = null;
    this.anchor = this.clamp(position);
    this.reflow(this.anchor);
  }

  private clamp(position: Position): Position {
    if (!this.book) return { chapter: 0, offset: 0 };
    const chapter = Math.max(0, Math.min(position.chapter, this.book.chapters.length - 1));
    return { chapter, offset: Math.max(0, Math.min(position.offset, this.book.chapters[chapter].text.length)) };
  }

  appearance(prefs: Preferences) {
    const anchor = this.anchor;
    const reflow = prefs.fontSize !== this.prefs.fontSize || prefs.lineHeight !== this.prefs.lineHeight || prefs.fontFamily !== this.prefs.fontFamily || prefs.hideToolbar !== this.prefs.hideToolbar;
    this.prefs = { ...prefs };
    if (reflow) this.reflow(anchor);
  }

  private estimate(block: Block): number {
    const width = Math.max(80, this.viewport.clientWidth - 40);
    const size = this.prefs.fontSize;
    let units = 0;
    for (const char of block.text) units += char.charCodeAt(0) > 255 ? 1 : 0.55;
    const lines = Math.max(1, Math.ceil(units * size / width));
    return block.heading ? lines * size * 1.55 + 28 : lines * size * this.prefs.lineHeight + (block.continuation ? 0 : size * 0.8);
  }

  private reflow(position: Position) {
    if (!this.blocks.length) return;
    this.heights = new Heights(this.blocks.map(b => this.estimate(b)));
    this.mounted.clear();
    this.content.replaceChildren();
    this.go(position);
  }

  private paragraph(index: number): HTMLElement {
    const block = this.blocks[index];
    const element = document.createElement(block.heading ? 'h2' : 'p');
    element.className = `text-block${block.heading ? ' chapter-heading' : ''}${block.continuation ? ' continuation' : ''}`;
    element.dataset.block = String(index);
    const match = this.match;
    if (match && !block.heading && block.chapter === match.chapter && match.offset < block.offset + block.text.length && match.offset + match.length > block.offset) {
      const start = Math.max(0, match.offset - block.offset), end = Math.min(block.text.length, match.offset + match.length - block.offset);
      const mark = document.createElement('mark'); mark.textContent = block.text.slice(start, end);
      element.append(document.createTextNode(block.text.slice(0, start)), mark, document.createTextNode(block.text.slice(end)));
    } else element.textContent = block.text;
    return element;
  }

  private render() {
    if (!this.blocks.length) return;
    const top = this.viewport.scrollTop;
    const buffer = Math.max(500, this.viewport.clientHeight * 2);
    const start = this.heights.at(Math.max(0, top - buffer));
    const end = Math.min(this.blocks.length, this.heights.at(top + this.viewport.clientHeight + buffer) + 1);
    for (const [index, element] of this.mounted) {
      if (index < start || index >= end) { element.remove(); this.mounted.delete(index); }
    }
    for (let i = start; i < end; i++) {
      let element = this.mounted.get(i);
      if (!element) { element = this.paragraph(i); this.mounted.set(i, element); this.content.append(element); }
      element.style.top = `${this.heights.prefix(i)}px`;
    }
    // Measure only visible / overscan blocks. CSS disables browser scroll anchoring;
    // compensate explicitly when estimates above the viewport become exact.
    const firstVisible = this.heights.at(top);
    let adjustment = 0;
    for (let i = start; i < end; i++) {
      const measured = this.mounted.get(i)!.getBoundingClientRect().height;
      const delta = measured - this.heights.values[i];
      if (Math.abs(delta) > 0.5) {
        this.heights.set(i, measured);
        if (i < firstVisible) adjustment += delta;
      }
    }
    this.content.style.height = `${this.heights.total + 24}px`;
    for (const [index, element] of this.mounted) element.style.top = `${this.heights.prefix(index)}px`;
    if (adjustment) this.viewport.scrollTop += adjustment;
  }

  /** Locate a character across text nodes, including the highlighted search span. */
  private rangeAt(element: HTMLElement, offset: number): Range | null {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let remaining = offset, node: Node | null;
    let last: Node | null = null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (!length) continue;
      last = node;
      if (remaining < length) {
        const range = document.createRange();
        const at = Math.min(remaining, Math.max(0, length - 1));
        range.setStart(node, at); range.setEnd(node, Math.min(length, at + 1));
        return range;
      }
      remaining -= length;
    }
    if (last) {
      const range = document.createRange();
      const length = last.textContent!.length;
      range.setStart(last, length - 1); range.setEnd(last, length);
      return range;
    }
    return null;
  }

  position(): Position {
    if (!this.blocks.length) return { chapter: 0, offset: 0 };
    const index = this.heights.at(this.viewport.scrollTop);
    const block = this.blocks[index];
    const element = this.mounted.get(index);
    if (block.heading || !element) return { chapter: block.chapter, offset: Math.max(0, block.offset) };
    const y = this.viewport.getBoundingClientRect().top + 1;
    let low = 0, high = block.text.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const rect = this.rangeAt(element, mid)?.getBoundingClientRect();
      if (rect && rect.bottom <= y) low = mid + 1;
      else high = mid;
    }
    return { chapter: block.chapter, offset: block.offset + low };
  }

  go(position: Position) {
    if (!this.blocks.length) return;
    position = this.clamp(position);
    this.anchor = position;
    const index = blockAt(this.blocks, position);
    this.settling = true;
    this.content.style.height = `${this.heights.total + 24}px`;
    this.viewport.scrollTop = this.heights.prefix(index);
    this.render();
    const element = this.mounted.get(index);
    const block = this.blocks[index];
    if (element) {
      const range = !block.heading ? this.rangeAt(element, Math.max(0, position.offset - block.offset)) : null;
      const textTop = range?.getBoundingClientRect().top ?? element.getBoundingClientRect().top;
      this.viewport.scrollTop += textTop - this.viewport.getBoundingClientRect().top;
      this.render();
    }
    requestAnimationFrame(() => {
      this.settling = false;
      this.anchor = this.position();
      this.onPosition(this.anchor);
    });
  }

  chapter(index: number) { this.go({ chapter: index, offset: 0 }); }
  /** Jump to a percentage of the whole book's text. */
  percent(value: number) {
    if (!this.book) return;
    const total = this.book.chapters.reduce((sum, chapter) => sum + chapter.text.length, 0);
    let target = Math.max(0, Math.min(100, value)) / 100 * total;
    for (let index = 0; index < this.book.chapters.length; index++) {
      const length = this.book.chapters[index].text.length;
      if (target <= length) { this.go({ chapter: index, offset: Math.floor(target) }); return; }
      target -= length;
    }
    this.end();
  }
  refresh() { this.reflow(this.anchor); }
  scroll(pixels: number) { this.viewport.scrollBy({ top: pixels, behavior: 'instant' }); }
  start() { this.go({ chapter: 0, offset: 0 }); }
  end() { this.viewport.scrollTop = this.heights.total; this.render(); this.anchor = this.position(); this.onPosition(this.anchor); }
  highlight(match: Match | null) {
    this.match = match;
    for (const element of this.mounted.values()) element.remove();
    this.mounted.clear();
    if (match) this.go(match); else this.render();
  }
  get blockCount() { return this.blocks.length; }
}
