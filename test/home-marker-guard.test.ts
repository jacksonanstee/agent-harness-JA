import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { markerStamp, REAL_HOME } from './home-marker-guard.setup.js';

// Issue #264: the tripwire's own comparison, on a temporary file. The tripwire itself watches the real home directory.
describe('markerStamp (#264): the state the real-marker tripwire compares', () => {
  it('differs when the file appears, changes and goes, and is stable while it is left alone', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'marker-guard-')), 'settings-changed.json');
    const absent = markerStamp(path);
    expect(absent).toBe('absent');
    writeFileSync(path, '{}');
    const written = markerStamp(path);
    expect(written).not.toBe(absent);
    expect(markerStamp(path)).toBe(written);
    writeFileSync(path, '{"version":1}');
    expect(markerStamp(path)).not.toBe(written);
    rmSync(path);
    expect(markerStamp(path)).toBe(absent);
  });
});

describe('the worker home (#264): the code under test never sees the real home directory', () => {
  it("os.homedir() is the worker's temporary directory, and the tripwire still reads the real one", () => {
    expect(homedir()).not.toBe(userInfo().homedir);
    expect(homedir()).toBe(process.env.HOME);
    expect(homedir()).toContain('harness-test-home-');
    expect(REAL_HOME).toBe(userInfo().homedir);
  });
});
