import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands';

describe('command parsing', () => {
  it('maps navigation and quit commands', () => {
    expect(parseCommand('index')).toEqual({ type: 'panel', panel: 'toc' });
    expect(parseCommand('toc')).toEqual({ type: 'panel', panel: 'toc' });
    expect(parseCommand('set')).toEqual({ type: 'panel', panel: 'settings' });
    expect(parseCommand('q')).toEqual({ type: 'quit', force: false });
    expect(parseCommand('qa!')).toEqual({ type: 'quit', force: true });
    expect(parseCommand('wq')).toEqual({ type: 'quit', force: true });
    expect(parseCommand('marks')).toEqual({ type: 'panel', panel: 'marks' });
    expect(parseCommand(':help')).toEqual({ type: 'panel', panel: 'help' });
    expect(parseCommand('   ')).toBeNull();
  });

  it('parses font commands', () => {
    expect(parseCommand('font increase')).toEqual({ type: 'font', mode: 'increase', value: 1 });
    expect(parseCommand('font decrease')).toEqual({ type: 'font', mode: 'decrease', value: 1 });
    expect(parseCommand('font +2')).toEqual({ type: 'font', mode: 'increase', value: 2 });
    expect(parseCommand('font -3')).toEqual({ type: 'font', mode: 'decrease', value: 3 });
    expect(parseCommand('font 20')).toEqual({ type: 'font', mode: 'set', value: 20 });
    expect(parseCommand('fontsize 18')).toEqual({ type: 'font', mode: 'set', value: 18 });
  });

  it('parses set assignments with aliases and clamping', () => {
    expect(parseCommand('set fontsize=20')).toEqual({ type: 'set', values: { fontSize: 20 }, invalid: [] });
    expect(parseCommand('set fontsize=99')).toEqual({ type: 'set', values: { fontSize: 32 }, invalid: [] });
    expect(parseCommand('set theme=dark ontop=off')).toEqual({ type: 'set', values: { theme: 'dark', alwaysOnTop: false }, invalid: [] });
    expect(parseCommand('set fontfamily=serif bgopacity=0.5')).toEqual({ type: 'set', values: { fontFamily: 'serif', backgroundOpacity: 0.5 }, invalid: [] });
    expect(parseCommand('set ontop=maybe')).toEqual({ type: 'error', message: '无法识别：ontop=maybe' });
    expect(parseCommand('set nope=1')).toEqual({ type: 'error', message: '无法识别：nope=1' });
  });

  it('parses bookmark deletion', () => {
    expect(parseCommand('delmark a')).toEqual({ type: 'delmark', letters: ['a'], all: false });
    expect(parseCommand('delm a b')).toEqual({ type: 'delmark', letters: ['a', 'b'], all: false });
    expect(parseCommand('delmarks aXa')).toEqual({ type: 'delmark', letters: ['a', 'x'], all: false });
    expect(parseCommand('delmarks')).toEqual({ type: 'delmark', letters: [], all: true });
  });

  it('parses jumps, theme, search and unknown input', () => {
    expect(parseCommand('chapter 3')).toEqual({ type: 'chapter', index: 2 });
    expect(parseCommand('42')).toEqual({ type: 'percent', value: 42 });
    expect(parseCommand('150')).toEqual({ type: 'percent', value: 100 });
    expect(parseCommand('theme light')).toEqual({ type: 'theme', theme: 'light' });
    expect(parseCommand('theme blue')).toEqual({ type: 'error', message: '用法：:theme dark | light' });
    expect(parseCommand('search 你好')).toEqual({ type: 'search', query: '你好' });
    expect(parseCommand('search')).toEqual({ type: 'panel', panel: 'search' });
    expect(parseCommand('bogus')).toEqual({ type: 'error', message: '未知命令：bogus' });
  });
});
