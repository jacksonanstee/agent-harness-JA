import { describe, expect, it } from 'vitest';
import {
  collapseBlanks,
  firstShellWord,
  trimBlanks,
  trimWordSeparators,
} from './shell-words.js';

// Escapes, not literal characters, so an editor cannot normalise a row into a
// plain space or drop it (a dropped row would pass vacuously).
const NON_BLANK_SPACES = [
  ['NBSP', '\u00a0'],
  ['NEL', '\u0085'],
  ['LINE SEPARATOR', '\u2028'],
  ['PARAGRAPH SEPARATOR', '\u2029'],
  ['VT', '\v'],
  ['FF', '\f'],
  ['IDEOGRAPHIC SPACE', '\u3000'],
  ['BOM', '\ufeff'],
] as const;

describe('shell word separators (issue #161, shared by sandbox and permissions)', () => {
  it('the table holds what its names say (guards the escapes)', () => {
    expect(NON_BLANK_SPACES.map(([, ch]) => ch.codePointAt(0))).toEqual([
      0xa0, 0x85, 0x2028, 0x2029, 0x0b, 0x0c, 0x3000, 0xfeff,
    ]);
    for (const [name, ch] of NON_BLANK_SPACES) {
      expect(ch.length, name).toBe(1);
    }
  });

  describe('firstShellWord', () => {
    it('skips leading blanks and newlines, stops at the next one', () => {
      expect(firstShellWord('git status')).toBe('git');
      expect(firstShellWord(' \t\n git\tstatus')).toBe('git');
      expect(firstShellWord('git\nstatus')).toBe('git');
      expect(firstShellWord('git')).toBe('git');
    });

    it('returns empty for empty or separator-only input', () => {
      expect(firstShellWord('')).toBe('');
      expect(firstShellWord(' \t\n ')).toBe('');
    });

    it.each(NON_BLANK_SPACES)('keeps %s inside the word', (_name, ch) => {
      expect(firstShellWord(`git${ch}x status`)).toBe(`git${ch}x`);
      expect(firstShellWord(`${ch}git status`)).toBe(`${ch}git`);
      expect(firstShellWord(ch)).toBe(ch);
    });
  });

  describe('trimBlanks', () => {
    it('trims spaces and tabs only', () => {
      expect(trimBlanks(' \t git status \t')).toBe('git status');
      expect(trimBlanks('\ngit status\n')).toBe('\ngit status\n');
    });

    it.each(NON_BLANK_SPACES)('leaves %s at either end', (_name, ch) => {
      expect(trimBlanks(`${ch}git${ch}`)).toBe(`${ch}git${ch}`);
    });
  });

  describe('trimWordSeparators', () => {
    it('trims spaces, tabs and newlines at both ends', () => {
      expect(trimWordSeparators(' \t\n git status \n\t')).toBe('git status');
      expect(trimWordSeparators('git\nstatus')).toBe('git\nstatus');
    });

    it.each(NON_BLANK_SPACES)('leaves %s at either end', (_name, ch) => {
      expect(trimWordSeparators(`${ch}git${ch}`)).toBe(`${ch}git${ch}`);
    });
  });

  describe('collapseBlanks', () => {
    it('turns runs of spaces and tabs into one space', () => {
      expect(collapseBlanks('git \t  status\t\tx')).toBe('git status x');
    });

    it('does not touch newlines (a newline ends a command, it does not separate words)', () => {
      expect(collapseBlanks('git\nstatus')).toBe('git\nstatus');
      expect(collapseBlanks('git \n status')).toBe('git \n status');
    });

    it.each(NON_BLANK_SPACES)('does not touch %s', (_name, ch) => {
      expect(collapseBlanks(`git${ch}${ch} status`)).toBe(`git${ch}${ch} status`);
    });
  });
});
