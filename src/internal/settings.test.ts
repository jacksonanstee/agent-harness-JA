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

// ---- Issue #108: a duplicated JSON key fails loud instead of last-wins ----

const loadRaw = (body: string): unknown => loadJsonSettings('/x.json', parseEcho, null, wrap, () => body);
const messageFrom = (body: string): string => {
  try {
    loadRaw(body);
  } catch (error: unknown) {
    return error instanceof FakeSettingsError ? error.message : `WRONG TYPE: ${String(error)}`;
  }
  return 'NO THROW';
};

describe('loadJsonSettings duplicate keys (issue #108)', () => {
  it('refuses a duplicated dimension key, naming the object path and the key', () => {
    const message = messageFrom(
      '{"permissions":{"defaultDecision":"deny","defaultDecision":"allow","rules":[]}}',
    );
    expect(message).toMatch(/^\/x\.json: /);
    expect(message).toContain("duplicate key 'defaultDecision'");
    expect(message).toContain('permissions');
    expect(message).not.toContain('allow');
  });

  it('refuses a duplicated key inside a rule, naming the array index', () => {
    const message = messageFrom(
      '{"permissions":{"rules":[{"tool":"Bash","match":"a","decision":"deny","decision":"allow"}]}}',
    );
    expect(message).toContain("duplicate key 'decision'");
    expect(message).toContain('permissions.rules[0]');
  });

  it('refuses a duplicated allowlist and sandbox key', () => {
    expect(messageFrom('{"sandbox":{"paths":{"allow":["/a"],"allow":["/"]}}}')).toMatch(
      /duplicate key 'allow'.*sandbox\.paths/,
    );
    expect(messageFrom('{"sandbox":{"paths":{},"paths":{}}}')).toMatch(/duplicate key 'paths'.*sandbox/);
  });

  it('refuses a duplicated key in the judge block', () => {
    expect(messageFrom('{"judge":{"model":"a","model":"b"}}')).toMatch(/duplicate key 'model'.*judge/);
  });

  it('refuses a duplicate at the top level', () => {
    expect(messageFrom('{"a":1,"a":2}')).toMatch(/duplicate key 'a'.*top-level/);
  });

  it('compares keys by their decoded value: an escaped spelling is the same key', () => {
    const escaped = '{"permissions":{"defaultDecision":"deny","\\u0064efaultDecision":"allow"}}';
    expect(messageFrom(escaped)).toMatch(/duplicate key 'defaultDecision'/);
    expect(messageFrom('{"a\\"b":1,"a\\u0022b":2}')).toMatch(/duplicate key/);
  });

  it('allows the same key at different levels and in sibling objects', () => {
    expect(loadRaw('{"a":{"a":{"a":1}},"b":{"a":1},"c":[{"a":1},{"a":2}]}')).toEqual({
      a: { a: { a: 1 } },
      b: { a: 1 },
      c: [{ a: 1 }, { a: 2 }],
    });
  });

  it('is not confused by quotes, braces, colons and commas inside string values or keys', () => {
    const body =
      '{"a":"x\\"y\\\\","b":"{\\"a\\":1,\\"a\\":2}","c\\"{":1,"d":["}",",","\\\\"],"e":1}';
    expect(loadRaw(body)).toEqual(JSON.parse(body));
  });

  it('a value equal to an earlier key is not a key', () => {
    expect(loadRaw('{"a":"a","b":"a","c":["a","a"]}')).toEqual({ a: 'a', b: 'a', c: ['a', 'a'] });
  });

  it('echoes a hostile key bounded and single-line, and never a value', () => {
    const key = 'k\\n' + 'z'.repeat(200);
    const message = messageFrom(`{"${key}":"SECRET_VALUE","${key}":2}`);
    expect(message).toContain('duplicate key');
    expect(message).not.toContain('\n');
    expect(message).not.toContain('SECRET_VALUE');
    expect(message.length).toBeLessThan(250);
  });

  it('leaves invalid JSON to the existing not-valid-JSON path', () => {
    expect(messageFrom('{"a":1,"a":')).toBe('/x.json is not valid JSON');
  });

  it('bounds the message by nesting depth, keeping the key and the last path segments', () => {
    const depth = 20000;
    const body = '{"k":'.repeat(depth) + '{"a":1,"a":2}' + '}'.repeat(depth);
    const message = messageFrom(body);
    expect(message).toContain("duplicate key 'a'");
    expect(message).toContain('…');
    expect(message).toMatch(/\.k\.k\.k \(/);
    expect(message.length).toBeLessThan(600);
  });

  it('names a duplicate inside a nested array by index path', () => {
    expect(messageFrom('{"x":[[{"a":1},{"b":1,"b":2}]]}')).toMatch(/duplicate key 'b' in x\[0\]\[1\]/);
  });

  it('treats a surrogate-pair key spelled raw and escaped as the same key', () => {
    expect(messageFrom('{"\u{1F600}":1,"\\ud83d\\ude00":2}')).toMatch(/duplicate key/);
  });

  it('stays linear on a large document', () => {
    const body = JSON.stringify({ list: Array.from({ length: 20000 }, (_, i) => ({ k: i, v: 'x' })) });
    const start = Date.now();
    loadRaw(body);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
