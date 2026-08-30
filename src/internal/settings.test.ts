import { describe, expect, it } from 'vitest';
import { loadJsonSettings } from './settings.js';

class FakeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeSettingsError';
  }
}

const wrap = FakeSettingsError;
const parseEcho = (doc: unknown): unknown => doc;

const enoent = (): string => {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
};

describe('loadJsonSettings', () => {
  it('returns the empty value when the file is missing', () => {
    expect(loadJsonSettings('/nope.json', parseEcho, 'EMPTY', wrap, enoent)).toBe('EMPTY');
  });

  it('fails loud with a path-prefixed error on invalid JSON', () => {
    expect(() => loadJsonSettings('/x.json', parseEcho, null, wrap, () => '{oops')).toThrowError(
      FakeSettingsError,
    );
    expect(() => loadJsonSettings('/x.json', parseEcho, null, wrap, () => '{oops')).toThrow(
      /\/x\.json/,
    );
  });

  it('rethrows parser errors path-prefixed via wrapError', () => {
    const parse = (): never => {
      throw new FakeSettingsError('bad shape');
    };
    expect(() => loadJsonSettings('/x.json', parse, null, wrap, () => '{}')).toThrow(
      /\/x\.json: bad shape/,
    );
  });

  it('propagates non-ENOENT read errors unwrapped', () => {
    const eacces = (): string => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    expect(() => loadJsonSettings('/x.json', parseEcho, null, wrap, eacces)).toThrow('EACCES');
  });

  it('propagates non-wrapError throwables from the parser unwrapped', () => {
    const parse = (): never => {
      throw new TypeError('programmer bug');
    };
    expect(() => loadJsonSettings('/x.json', parse, null, wrap, () => '{}')).toThrow(TypeError);
  });

  it('parses a valid file through the supplied parser', () => {
    const parse = (doc: unknown): number => (doc as { n: number }).n * 2;
    expect(loadJsonSettings('/x.json', parse, 0, wrap, () => '{"n": 21}')).toBe(42);
  });
});

// ---- ADR-0034: the hostile-file envelope and unknown-key mechanics ----

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { GuardedReadError } from './guarded-read.js';
import { boundEcho, MAX_SETTINGS_BYTES, MESSAGE_ECHO_MAX, readSettingsFile, unknownKeys } from './settings.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'settings-envelope-'));
  tmpDirs.push(dir);
  return dir;
}

describe('loadJsonSettings hostile-file envelope (ADR-0034)', () => {
  it('the invalid-JSON message names the path and nothing from the body', () => {
    // A settings path can point at any file an attacker plants; V8's
    // SyntaxError message quotes a snippet of the input around an unexpected
    // TOKEN (an unexpected END carries no snippet, so the body must start
    // with one), and that message used to reach stderr. The marker must not
    // survive into the error.
    const body = 'BODY_MARKER_9f3c{';
    expect(() => loadJsonSettings('/x.json', parseEcho, null, wrap, () => body)).toThrow(
      /\/x\.json/,
    );
    let message = '';
    try {
      loadJsonSettings('/x.json', parseEcho, null, wrap, () => body);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('BODY_MARKER');
  });

  it("a GuardedReadError from the reader becomes the caller's error class, path-prefixed", () => {
    const refuse = (): string => {
      throw new GuardedReadError('symlink', '/x.json', 'file /x.json is a symlink');
    };
    expect(() => loadJsonSettings('/x.json', parseEcho, null, wrap, refuse)).toThrowError(
      FakeSettingsError,
    );
    expect(() => loadJsonSettings('/x.json', parseEcho, null, wrap, refuse)).toThrow(
      /\/x\.json.*symlink/,
    );
  });
});

describe('readSettingsFile (the production reader)', () => {
  it('round-trips a regular file', () => {
    const path = join(freshDir(), 'settings.json');
    writeFileSync(path, '{"permissions":{"rules":[]}}');
    expect(readSettingsFile(path)).toBe('{"permissions":{"rules":[]}}');
  });

  it('refuses a symlinked settings file', () => {
    const dir = freshDir();
    const real = join(dir, 'real.json');
    writeFileSync(real, '{}');
    const link = join(dir, 'settings.json');
    symlinkSync(real, link);
    expect(() => readSettingsFile(link)).toThrowError(GuardedReadError);
    expect(() => readSettingsFile(link)).toThrow(/symlink/);
  });

  it('refuses a file over MAX_SETTINGS_BYTES', () => {
    const path = join(freshDir(), 'settings.json');
    writeFileSync(path, 'x'.repeat(MAX_SETTINGS_BYTES + 1));
    expect(() => readSettingsFile(path)).toThrow(/exceeds/);
  });

  it('propagates ENOENT with its code so a missing file is still an empty layer', () => {
    expect(loadJsonSettings(join(freshDir(), 'nope.json'), parseEcho, 'EMPTY', wrap)).toBe('EMPTY');
  });
});

describe('loadJsonSettings default reader (ADR-0034 decision 5)', () => {
  it('reads through the guarded reader when no readFile is given: a symlinked file is refused', () => {
    // The default lives HERE, not at the composition root, so the public
    // module loaders and any library caller get the envelope without
    // choosing it (architecture review of the first cut).
    const dir = freshDir();
    const real = join(dir, 'real.json');
    writeFileSync(real, '{}');
    const link = join(dir, 'settings.json');
    symlinkSync(real, link);
    expect(() => loadJsonSettings(link, parseEcho, null, wrap)).toThrowError(FakeSettingsError);
    expect(() => loadJsonSettings(link, parseEcho, null, wrap)).toThrow(/refusing settings: .*symlink/);
  });

  it('reads a regular file when no readFile is given', () => {
    const path = join(freshDir(), 'settings.json');
    writeFileSync(path, '{"ok":1}');
    expect(loadJsonSettings(path, parseEcho, null, wrap)).toEqual({ ok: 1 });
  });
});

describe('boundEcho', () => {
  it('bounds to MESSAGE_ECHO_MAX and neutralises newline, bidi and invisible characters before the cut', () => {
    // A newline would forge a second stderr line; the CLI's terminal
    // sanitiser keeps newlines by contract, so the echo must not carry one.
    const hostile = 'x\nwarning: settings OK\u202e\u200b' + 'k'.repeat(100);
    const out = boundEcho(hostile);
    expect(out).not.toMatch(/[\n\u202e\u200b]/);
    expect(out.length).toBeLessThanOrEqual(MESSAGE_ECHO_MAX + 1);
    expect(out.endsWith('…')).toBe(true);
    expect(boundEcho('rules')).toBe('rules');
  });
});

describe('unknownKeys', () => {
  it('returns the keys outside the known set, in document order', () => {
    const doc = JSON.parse('{"rules":[],"zeta":1,"alpha":2}') as Record<string, unknown>;
    expect(unknownKeys(doc, ['defaultDecision', 'rules'])).toEqual(['zeta', 'alpha']);
  });

  it('returns [] for a record with only known keys, or no keys', () => {
    expect(unknownKeys({ rules: [] }, ['defaultDecision', 'rules'])).toEqual([]);
    expect(unknownKeys({}, ['rules'])).toEqual([]);
  });

  it('reports an own __proto__ key from JSON.parse as unknown rather than swallowing it', () => {
    const doc = JSON.parse('{"__proto__":{"rules":[]}}') as Record<string, unknown>;
    expect(unknownKeys(doc, ['rules'])).toEqual(['__proto__']);
  });
});
