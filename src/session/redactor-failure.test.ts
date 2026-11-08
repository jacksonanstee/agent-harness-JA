import { describe, expect, it, vi } from 'vitest';

// #113 review fold: the class names are written in the module, never read from
// the constructor. The module must be imported AFTER the tampering, because a
// name read at import time would otherwise be read before the test changes it.
describe('redactorFailure', () => {
  it('does not take a standard class name from a redefined constructor, even one redefined before import', async () => {
    const saved = Object.getOwnPropertyDescriptor(Error, 'name');
    Object.defineProperty(Error, 'name', { value: 'AKIAIOSFODNN7EXAMPLE', configurable: true });
    try {
      vi.resetModules();
      const { redactorFailure } = await import('./redactor-failure.js');
      expect(redactorFailure(new Error('x'))).toBe(
        'the redactor threw Error; its message is withheld because it can carry the input (#113)',
      );
    } finally {
      if (saved !== undefined) Object.defineProperty(Error, 'name', saved);
      vi.resetModules();
    }
  });

  it('scannerFailure says the same, naming the scanner and #234', async () => {
    const { scannerFailure } = await import('./redactor-failure.js');
    expect(scannerFailure(new TypeError('secret'))).toBe(
      'the scanner threw TypeError; its message is withheld because it can carry the input (#234)',
    );
  });

  it('names each standard class, and anything else as non-standard, never throwing', async () => {
    const { redactorFailure } = await import('./redactor-failure.js');
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const cases: [unknown, string][] = [
      [new TypeError('x'), 'TypeError'],
      [new RangeError('x'), 'RangeError'],
      [new SyntaxError('x'), 'SyntaxError'],
      [new ReferenceError('x'), 'ReferenceError'],
      [new URIError('x'), 'a non-standard error'],
      ['a string', 'a non-standard error'],
      [null, 'a non-standard error'],
      [Object.create(null) as object, 'a non-standard error'],
      [proxy, 'a non-standard error'],
    ];
    for (const [error, kind] of cases) expect(redactorFailure(error)).toContain(`threw ${kind};`);
  });
});
