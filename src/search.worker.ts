import { findMatches } from './model';
import type { Book } from './types';

let book: Book | null = null;
self.onmessage = (event: MessageEvent<{ book?: Book; query?: string; version: number }>) => {
  if (event.data.book) book = event.data.book;
  if (event.data.query !== undefined) {
    const matches = book ? findMatches(book, event.data.query) : [];
    self.postMessage({ version: event.data.version, matches });
  }
};
