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
