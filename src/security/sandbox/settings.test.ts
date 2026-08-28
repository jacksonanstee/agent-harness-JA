import { describe, expect, it } from 'vitest';
import {
  loadSandboxSettingsFile,
  MAX_ALLOW_ENTRIES,
  parseSandboxSettings,
  SandboxSettingsError,
} from './settings.js';

describe('parseSandboxSettings', () => {
  it('parses a valid sandbox document', () => {
    const parsed = parseSandboxSettings({
      sandbox: {
        paths: { allow: ['/safe', '/tmp'] },
        commands: { allow: ['git'] },
      },
    });
    expect(parsed.paths?.allow).toEqual(['/safe', '/tmp']);
    expect(parsed.commands?.allow).toEqual(['git']);
  });

  it('absent sandbox key → empty config (sandbox off)', () => {
    expect(parseSandboxSettings({})).toEqual({});
    expect(parseSandboxSettings({ permissions: { rules: [] } })).toEqual({});
  });

  it('a single dimension may be configured alone', () => {
    const parsed = parseSandboxSettings({ sandbox: { commands: { allow: ['npm'] } } });
    expect(parsed.paths).toBeUndefined();
    expect(parsed.commands?.allow).toEqual(['npm']);
  });

  it.each([
    ['non-object root', 'nope'],
    ['non-object sandbox', { sandbox: [] }],
    ['non-object paths', { sandbox: { paths: 'x' } }],
    ['non-array allow', { sandbox: { paths: { allow: 'x' } } }],
    ['non-string entry', { sandbox: { paths: { allow: [7] } } }],
    ['empty-string entry', { sandbox: { commands: { allow: [''] } } }],
  ])('throws SandboxSettingsError on %s', (_name, doc) => {
    expect(() => parseSandboxSettings(doc)).toThrowError(SandboxSettingsError);
  });

  it.each([
    ['unknown key inside sandbox (a typo of paths turns the dimension off)', { sandbox: { path: { allow: ['/safe'] } } }, /sandbox.*unknown key 'path'/, /paths, commands/],
    ['unknown key beside allow', { sandbox: { paths: { allow: ['/safe'], alow: ['/etc'] } } }, /sandbox\.paths.*unknown key 'alow'/, /allow/],
  ])('rejects an %s, naming the key and the known set (ADR-0034)', (_name, doc, keyPattern, knownPattern) => {
    expect(() => parseSandboxSettings(doc)).toThrowError(SandboxSettingsError);
    expect(() => parseSandboxSettings(doc)).toThrow(keyPattern);
    expect(() => parseSandboxSettings(doc)).toThrow(knownPattern);
  });

  it.each(['/bin/s?', '/bin/*', '/usr/local/bin/*', '[s]h', 's?'])(
    'refuses the glob-shaped command entry %s: the shell would expand it to a different program',
    (entry) => {
      const doc = { sandbox: { commands: { allow: [entry] } } };
      expect(() => parseSandboxSettings(doc)).toThrowError(SandboxSettingsError);
      let message = '';
      try {
        parseSandboxSettings(doc);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/sandbox\.commands\.allow\[0\]/);
      expect(message).toMatch(/glob/);
      expect(message).toContain(entry);
    },
  );

  it('still accepts the same strings as PATH entries (prefix semantics; a glob there is inert, not open)', () => {
    // Pins the scope of ADR-0034 decision 2 so a later warning or rejection on
    // the path dimension is a visible change, not a drift.
    const parsed = parseSandboxSettings({
      sandbox: { paths: { allow: ['/usr/local/bin/*', '/bin/s?'] } },
    });
    expect(parsed.paths?.allow).toEqual(['/usr/local/bin/*', '/bin/s?']);
  });

  it('enforces the entry cap', () => {
    const allow = Array.from({ length: MAX_ALLOW_ENTRIES + 1 }, (_, i) => `/p${i}`);
    expect(() => parseSandboxSettings({ sandbox: { paths: { allow } } })).toThrowError(
      SandboxSettingsError,
    );
    expect(() =>
      parseSandboxSettings({ sandbox: { paths: { allow: allow.slice(0, MAX_ALLOW_ENTRIES) } } }),
    ).not.toThrow();
  });
});

describe('loadSandboxSettingsFile', () => {
  it('missing file → empty config', () => {
    const enoent = (): string => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    expect(loadSandboxSettingsFile('/nope.json', enoent)).toEqual({});
  });

  it('malformed file fails loud with the path in the message', () => {
    expect(() => loadSandboxSettingsFile('/x.json', () => '{oops')).toThrow(/\/x\.json/);
    expect(() =>
      loadSandboxSettingsFile('/x.json', () => JSON.stringify({ sandbox: { paths: 'x' } })),
    ).toThrowError(SandboxSettingsError);
  });
});
