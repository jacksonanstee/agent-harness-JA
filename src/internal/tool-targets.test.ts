import { describe, expect, it } from 'vitest';
import { canonicalizePath, TOOL_TARGET_FIELDS } from './tool-targets.js';

describe('TOOL_TARGET_FIELDS', () => {
  it('covers every path/command-taking SDK tool the gates must not silently pass', () => {
    // Review finding: Glob/Grep/NotebookEdit/MultiEdit bypassed both gates
    // when the two modules kept private four-tool tables. This test pins the
    // shared table's coverage so removing an entry is a visible act.
    expect(Object.keys(TOOL_TARGET_FIELDS).sort()).toEqual([
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'MultiEdit',
      'NotebookEdit',
      'Read',
      'Write',
    ]);
  });

  it('marks Glob/Grep as missing-means-cwd per the SDK contract', () => {
    expect(TOOL_TARGET_FIELDS['Glob']?.missingMeansCwd).toBe(true);
    expect(TOOL_TARGET_FIELDS['Grep']?.missingMeansCwd).toBe(true);
    expect(TOOL_TARGET_FIELDS['Write']?.missingMeansCwd).toBeUndefined();
  });
});

describe('canonicalizePath', () => {
  it('resolves traversal and relative paths', () => {
    expect(canonicalizePath('/a/b/../c', false)).toBe('/a/c');
    expect(canonicalizePath('rel/x', false)).toBe(`${process.cwd()}/rel/x`);
  });

  it('folds case only in case-insensitive mode', () => {
    // /SAFE/x and /safe/x are the same file on default APFS/NTFS — lexical
    // comparison without folding let deny rules be dodged by case variation.
    expect(canonicalizePath('/SAFE/X.txt', true)).toBe('/safe/x.txt');
    expect(canonicalizePath('/SAFE/X.txt', false)).toBe('/SAFE/X.txt');
  });

  it('defaults to the platform behaviour', () => {
    const expected = process.platform === 'darwin' || process.platform === 'win32';
    expect(canonicalizePath('/A', undefined) === '/a').toBe(expected);
  });
});
