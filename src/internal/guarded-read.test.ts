import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GuardedReadError,
  readFileGuarded,
  refuseAncestorSymlinks,
  refuseSymlink,
} from './guarded-read.js';

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guarded-read-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `fn`, returns the GuardedReadError it threw, and fails on anything else. */
function refusalOf(fn: () => unknown): GuardedReadError {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof GuardedReadError) return error;
    throw error;
  }
  throw new Error('expected a GuardedReadError, nothing was thrown');
}

const CAP = 64;

describe('readFileGuarded', () => {
  it('returns the body of a regular file', () => {
    const path = join(freshDir(), 'f.json');
    writeFileSync(path, '{"ok":true}');
    expect(readFileGuarded(path, CAP)).toBe('{"ok":true}');
  });

  it('returns a body exactly at the cap and refuses one byte over, naming both numbers', () => {
    const dir = freshDir();
    const atCap = join(dir, 'at.json');
    const over = join(dir, 'over.json');
    writeFileSync(atCap, 'x'.repeat(CAP));
    writeFileSync(over, 'x'.repeat(CAP + 1));
    expect(readFileGuarded(atCap, CAP)).toHaveLength(CAP);
    const refusal = refusalOf(() => readFileGuarded(over, CAP));
    expect(refusal.refusal).toBe('oversize');
    expect(refusal.message).toMatch(/exceeds 64 bytes \(65\)/);
    expect(refusal.path).toBe(over);
  });

  it('refuses a leaf symlink, even one pointing at a readable regular file', () => {
    const dir = freshDir();
    const real = join(dir, 'real.json');
    writeFileSync(real, '{}');
    const link = join(dir, 'link.json');
    symlinkSync(real, link);
    const refusal = refusalOf(() => readFileGuarded(link, CAP));
    expect(refusal.refusal).toBe('symlink');
    expect(refusal.message).toMatch(/symlink/);
    expect(refusal.path).toBe(link);
  });

  it('refuses when the parent directory of an absolute path is a symlink', () => {
    const dir = freshDir();
    const realDir = join(dir, 'real-dir');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'f.json'), '{}');
    const linkedDir = join(dir, 'linked-dir');
    symlinkSync(realDir, linkedDir);
    const refusal = refusalOf(() => readFileGuarded(join(linkedDir, 'f.json'), CAP));
    expect(refusal.refusal).toBe('ancestor-symlink');
    expect(refusal.message).toMatch(/symlink/);
  });

  it('refuses a directory', () => {
    const dir = freshDir();
    const refusal = refusalOf(() => readFileGuarded(dir, CAP));
    expect(refusal.refusal).toBe('directory');
    expect(refusal.message).toMatch(/directory/);
  });

  it('rethrows ENOENT with its code (not a GuardedReadError) so ENOENT-is-empty consumers keep working', () => {
    const missing = join(freshDir(), 'nope.json');
    let caught: unknown;
    try {
      readFileGuarded(missing, CAP);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(GuardedReadError);
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('reports a stat failure other than ENOENT as unreadable, carrying the code', () => {
    // A path THROUGH a regular file: lstat fails with ENOTDIR.
    const file = join(freshDir(), 'f.json');
    writeFileSync(file, '{}');
    const refusal = refusalOf(() => readFileGuarded(join(file, 'child.json'), CAP));
    expect(refusal.refusal).toBe('unreadable');
    expect(refusal.code).toBe('ENOTDIR');
  });
});

describe('refuseSymlink', () => {
  it('is silent on a missing path and on a regular file', () => {
    const dir = freshDir();
    const file = join(dir, 'f');
    writeFileSync(file, '');
    expect(() => refuseSymlink(join(dir, 'missing'), 'file')).not.toThrow();
    expect(() => refuseSymlink(file, 'file')).not.toThrow();
  });

  it('throws a symlink refusal whose message carries the label and the path', () => {
    const dir = freshDir();
    const link = join(dir, 'link');
    symlinkSync(dir, link);
    const refusal = refusalOf(() => refuseSymlink(link, 'directory'));
    expect(refusal.refusal).toBe('symlink');
    expect(refusal.message).toContain('directory');
    expect(refusal.message).toContain(link);
  });
});

describe('refuseAncestorSymlinks', () => {
  it('ABSOLUTE path: checks the parent only; a symlinked grandparent is allowed (operator territory)', () => {
    const dir = freshDir();
    const realGrand = join(dir, 'real-grand');
    mkdirSync(join(realGrand, 'parent'), { recursive: true });
    const linkedGrand = join(dir, 'linked-grand');
    symlinkSync(realGrand, linkedGrand);
    expect(() => refuseAncestorSymlinks(join(linkedGrand, 'parent', 'f.json'))).not.toThrow();
    const linkedParent = join(dir, 'linked-parent');
    symlinkSync(join(realGrand, 'parent'), linkedParent);
    expect(refusalOf(() => refuseAncestorSymlinks(join(linkedParent, 'f.json'))).refusal).toBe(
      'ancestor-symlink',
    );
  });

  it('RELATIVE path: every accumulating raw component is checked, including a `..` after the link', () => {
    // Repo-relative layout under gitignored .harness/ because vitest's threads
    // pool forbids chdir (same construction as the baseline tests this hoist
    // replaces). Built by raw concatenation, not join(): join would cancel
    // `symlinkdir/..` lexically, which is exactly what the walk must not do.
    mkdirSync('.harness', { recursive: true });
    const base = mkdtempSync('.harness/guarded-read-rel-');
    dirs.push(base);
    mkdirSync(join(base, 'eval', 'real'), { recursive: true });
    symlinkSync('real', join(base, 'eval', 'symlinkdir'));
    const viaGrandparentLink = join(base, 'eval', 'symlinkdir', 'sub', 'f.json');
    expect(refusalOf(() => refuseAncestorSymlinks(viaGrandparentLink)).refusal).toBe(
      'ancestor-symlink',
    );
    const viaDotDot =
      join(base, 'eval', 'symlinkdir') + sep + '..' + sep + 'real' + sep + 'f.json';
    expect(refusalOf(() => refuseAncestorSymlinks(viaDotDot)).refusal).toBe('ancestor-symlink');
    expect(() => refuseAncestorSymlinks(join(base, 'eval', 'real', 'f.json'))).not.toThrow();
  });
});
