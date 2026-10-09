export type Action = 'down' | 'up' | 'halfDown' | 'halfUp' | 'pageDown' | 'pageUp' | 'start' | 'end' | 'search' | 'next' | 'previous' | 'open' | 'settings' | 'toc' | 'help' | 'escape';

export class VimKeys {
  private lastG = 0;
  action(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>, editable: boolean, now = Date.now()): Action | null {
    if (event.isComposing) return null;
    if (event.key === 'Escape') { this.lastG = 0; return 'escape'; }
    if (editable || event.metaKey || event.altKey) { this.lastG = 0; return null; }
    if (event.ctrlKey) {
      this.lastG = 0;
      return ({ d: 'halfDown', u: 'halfUp', f: 'pageDown', b: 'pageUp' } as Record<string, Action>)[event.key.toLowerCase()] ?? null;
    }
    if (event.key === 'g') {
      if (this.lastG && now - this.lastG < 600) { this.lastG = 0; return 'start'; }
      this.lastG = now; return null;
    }
    this.lastG = 0;
    return ({ j: 'down', k: 'up', G: 'end', '/': 'search', n: 'next', N: 'previous', o: 'open', s: 'settings', t: 'toc', '?': 'help' } as Record<string, Action>)[event.key] ?? null;
  }
}
