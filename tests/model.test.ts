import { describe, expect, it } from 'vitest';
import { blockAt, blocksFor, findMatches, Heights } from '../src/model';
import { VimKeys } from '../src/keys';
import type { Book } from '../src/types';

const book: Book = { id: 'test', path: '/test', title: '测试', encoding: 'UTF-8', chapters: [
  { id: 'a', title: '第一章', text: '你好世界。\n\nhello HELLO [.*] 🌲\n' + '文'.repeat(399) + '😀' + '字'.repeat(1000) },
  { id: 'b', title: '第二章', text: '世界，你好。' },
] };

describe('book indexing', () => {
  it('splits long paragraphs with exact offsets and intact surrogate pairs', () => {
    const blocks = blocksFor(book);
    for (const block of blocks.filter(b => !b.heading)) {
      expect(book.chapters[block.chapter].text.slice(block.offset, block.offset + block.text.length)).toBe(block.text);
      expect(block.text.length).toBeLessThanOrEqual(400);
      expect(block.text.charCodeAt(block.text.length - 1) >= 0xd800 && block.text.charCodeAt(block.text.length - 1) <= 0xdbff).toBe(false);
    }
    const index = blockAt(blocks, { chapter: 1, offset: 3 });
    expect(blocks[index].chapter).toBe(1);
    expect(blocks[index].offset).toBe(0);
  });
  it('searches all chapters literally and case-insensitively', () => {
    expect(findMatches(book, '世界').map(m => m.chapter)).toEqual([0, 1]);
    expect(findMatches(book, 'hello')).toHaveLength(2);
    expect(findMatches(book, '[.*]')).toHaveLength(1);
    expect(findMatches(book, '')).toEqual([]);
    expect(findMatches(book, '字', 10)).toHaveLength(10);
  });
});

describe('virtual heights', () => {
  it('maps positions after measuring blocks of different heights', () => {
    const heights = new Heights([20, 40, 10, 60]);
    expect(heights.total).toBe(130);
    expect(heights.at(20)).toBe(1);
    expect(heights.at(69)).toBe(2);
    heights.set(1, 80);
    expect(heights.prefix(2)).toBe(100);
    expect(heights.at(99)).toBe(1);
    expect(heights.at(100)).toBe(2);
    expect(heights.at(999)).toBe(3);
  });
});

describe('vim reading keys', () => {
  const event = (key: string, extra = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, ...extra });
  it('keeps text entry and IME safe', () => {
    const keys = new VimKeys();
    expect(keys.action(event('j'), true)).toBeNull();
    expect(keys.action(event('s', { isComposing: true }), false)).toBeNull();
    expect(keys.action(event('k', { metaKey: true }), false)).toBeNull();
    expect(keys.action(event('Escape'), true)).toEqual({ action: 'escape', count: 1 });
  });
  it('supports gg but resets the chord after other keys or a timeout', () => {
    const keys = new VimKeys();
    expect(keys.action(event('g'), false, 1000)).toBeNull();
    expect(keys.action(event('g'), false, 1100)).toEqual({ action: 'start', count: 1 });
    keys.action(event('g'), false, 2000);
    keys.action(event('j'), false, 2100);
    expect(keys.action(event('g'), false, 2200)).toBeNull();
    expect(keys.action(event('g'), false, 3000)).toBeNull();
    expect(keys.action(event('d', { ctrlKey: true }), false)).toEqual({ action: 'halfDown', count: 1 });
    expect(keys.action(event('N'), false)).toEqual({ action: 'previous', count: 1 });
  });
  it('carries Vim count prefixes and the command key', () => {
    const keys = new VimKeys();
    expect(keys.action(event('5'), false)).toBeNull();
    expect(keys.action(event('j'), false)).toEqual({ action: 'down', count: 5 });
    expect(keys.action(event('1'), false)).toBeNull();
    expect(keys.action(event('0'), false)).toBeNull();
    expect(keys.action(event('k'), false)).toEqual({ action: 'up', count: 10 });
    expect(keys.action(event(':'), false)).toEqual({ action: 'command', count: 1 });
  });
});
