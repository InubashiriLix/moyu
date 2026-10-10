export type Action = 'down' | 'up' | 'halfDown' | 'halfUp' | 'pageDown' | 'pageUp' | 'start' | 'end' | 'search' | 'next' | 'previous' | 'open' | 'settings' | 'toc' | 'help' | 'escape' | 'command';

/** A resolved key press: the action plus an optional Vim-style count prefix. */
export interface KeyAction { action: Action; count: number }

export class VimKeys {
  private lastG = 0;
  private count = 0;

  private take(): number {
    const count = this.count || 1;
    this.count = 0;
    return count;
  }

  private reset() { this.lastG = 0; this.count = 0; }

  action(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>, editable: boolean, now = Date.now()): KeyAction | null {
    if (event.isComposing) return null;
    if (event.key === 'Escape') { this.reset(); return { action: 'escape', count: 1 }; }
    if (editable || event.metaKey || event.altKey) { this.reset(); return null; }
    if (event.ctrlKey) {
      this.lastG = 0;
      const action = ({ d: 'halfDown', u: 'halfUp', f: 'pageDown', b: 'pageUp' } as Record<string, Action>)[event.key.toLowerCase()];
      if (action) return { action, count: this.take() };
      this.count = 0;
      return null;
    }
    // Counts may not start with 0, but 0 can extend an existing count (10j).
    if (/^[0-9]$/.test(event.key) && (event.key !== '0' || this.count > 0)) {
      this.count = Math.min(9999, this.count * 10 + Number(event.key));
      return null;
    }
    if (event.key === 'g') {
      const count = this.take();
      if (this.lastG && now - this.lastG < 600) { this.lastG = 0; return { action: 'start', count }; }
      this.lastG = now;
      return null;
    }
    this.lastG = 0;
    const action = ({ j: 'down', k: 'up', G: 'end', '/': 'search', n: 'next', N: 'previous', o: 'open', s: 'settings', t: 'toc', '?': 'help', ':': 'command' } as Record<string, Action>)[event.key];
    if (!action) { this.count = 0; return null; }
    return { action, count: this.take() };
  }
}
