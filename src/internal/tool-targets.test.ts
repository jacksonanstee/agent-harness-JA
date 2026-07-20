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

  it('folds Unicode NFC/NFD forms to one string so a rule can not be dodged by form', () => {
    // A path with an accented char has two byte-distinct encodings: NFC
    // (single codepoint) and NFD (base letter + combining mark). They are the
    // same file but different strings; without normalization a deny rule
    // written in one form is bypassed by a tool call in the other, the same
    // "same file, different string" bug case-folding exists to close. Built
    // from \u escapes so the precondition holds regardless of how this source
    // file's own bytes are normalized on save.
    const nfc = '/Caf\u00e9/secret.txt'; // e-acute as one codepoint (NFC)
    const nfd = '/Cafe\u0301/secret.txt'; // e + combining acute (NFD)
    expect(nfc).not.toBe(nfd); // precondition: genuinely distinct strings
    expect(canonicalizePath(nfc, false)).toBe(canonicalizePath(nfd, false));
    expect(canonicalizePath(nfc, true)).toBe(canonicalizePath(nfd, true));
  });

  // Note: canonicalizePath normalizes AFTER resolve() specifically so a
  // relative input's cwd component is folded too (V10/V11 review HIGH). That
  // path can only be exercised by changing process.cwd() to a non-NFC
  // directory, which vitest's worker pool disallows (process.chdir throws), so
  // it is verified by the reviewer's live repro rather than a unit test here.
});

