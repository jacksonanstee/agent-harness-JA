import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadOracle, validateVerdict } from './oracle.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, '__fixtures__', 'oracles', name);

describe('loadOracle', () => {
  it('loads a module with a named oracle function export', async () => {
    const oracle = await loadOracle(fixture('good.oracle.mjs'));
    expect(typeof oracle).toBe('function');
  });

  it('rejects a module without an oracle export', async () => {
    await expect(loadOracle(fixture('no-export.oracle.mjs'))).rejects.toThrow(
      /named export 'oracle'/,
    );
  });

  it('rejects an oracle export that is not a function', async () => {
    await expect(loadOracle(fixture('not-a-function.oracle.mjs'))).rejects.toThrow(
      /named export 'oracle'/,
    );
  });

  it('surfaces a module that throws at import time', async () => {
    await expect(loadOracle(fixture('throws-on-import.oracle.mjs'))).rejects.toThrow(
      /hostile import/,
    );
  });

  it('surfaces a missing oracle file', async () => {
    await expect(loadOracle(fixture('missing.oracle.mjs'))).rejects.toThrow();
  });
});

describe('validateVerdict', () => {
  it('accepts { pass: true }', () => {
    expect(validateVerdict({ pass: true })).toEqual({ pass: true });
  });

  it('accepts { pass: false, reason }', () => {
    expect(validateVerdict({ pass: false, reason: 'nope' })).toEqual({
      pass: false,
      reason: 'nope',
    });
  });

  it('rejects truthy coercion — a broken oracle must never silently pass', () => {
    expect(() => validateVerdict({ pass: 1 })).toThrow(/strict boolean/);
    expect(() => validateVerdict({ pass: 'true' })).toThrow(/strict boolean/);
  });

  it('rejects a missing pass field, null, and non-objects', () => {
    expect(() => validateVerdict({})).toThrow(/strict boolean/);
    expect(() => validateVerdict(null)).toThrow(/must return an object/);
    expect(() => validateVerdict(undefined)).toThrow(/must return an object/);
    expect(() => validateVerdict('pass')).toThrow(/must return an object/);
  });

  it('rejects a non-string reason', () => {
    expect(() => validateVerdict({ pass: true, reason: 42 })).toThrow(/reason/);
  });
});
