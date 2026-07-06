import { describe, expect, it } from 'vitest';
import { loadJsonSettings } from './settings.js';

class FakeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeSettingsError';
  }
}

const wrap = (message: string): Error => new FakeSettingsError(message);
const parseEcho = (doc: unknown): unknown => doc;

const enoent = (): string => {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
};

describe('loadJsonSettings', () => {
  it('returns the empty value when the file is missing', () => {
    expect(loadJsonSettings('/nope.json', enoent, parseEcho, 'EMPTY', wrap)).toBe('EMPTY');
  });

  it('fails loud with a path-prefixed error on invalid JSON', () => {
    expect(() => loadJsonSettings('/x.json', () => '{oops', parseEcho, null, wrap)).toThrowError(
      FakeSettingsError,
    );
    expect(() => loadJsonSettings('/x.json', () => '{oops', parseEcho, null, wrap)).toThrow(
      /\/x\.json/,
    );
  });

  it('rethrows parser errors path-prefixed via wrapError', () => {
    const parse = (): never => {
      throw new FakeSettingsError('bad shape');
    };
    expect(() => loadJsonSettings('/x.json', () => '{}', parse, null, wrap)).toThrow(
      /\/x\.json: bad shape/,
    );
  });

  it('propagates non-ENOENT read errors unwrapped', () => {
    const eacces = (): string => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    };
    expect(() => loadJsonSettings('/x.json', eacces, parseEcho, null, wrap)).toThrow('EACCES');
  });

  it('propagates non-wrapError throwables from the parser unwrapped', () => {
    const parse = (): never => {
      throw new TypeError('programmer bug');
    };
    expect(() => loadJsonSettings('/x.json', () => '{}', parse, null, wrap)).toThrow(TypeError);
  });

  it('parses a valid file through the supplied parser', () => {
    const parse = (doc: unknown): number => (doc as { n: number }).n * 2;
    expect(loadJsonSettings('/x.json', () => '{"n": 21}', parse, 0, wrap)).toBe(42);
  });
});
