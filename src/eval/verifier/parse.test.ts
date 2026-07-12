import { describe, expect, it } from 'vitest';
import { parseAdversaryResponse } from './parse.js';

describe('parseAdversaryResponse', () => {
  it('accepts a bare agree', () => {
    expect(parseAdversaryResponse('{"verdict":"agree"}')).toEqual({ ok: true, verdict: 'agree' });
  });

  it('accepts challenge with each closed category', () => {
    for (const c of ['incomplete', 'incorrect', 'unsupported-claim', 'unsafe', 'other']) {
      expect(parseAdversaryResponse(`{"verdict":"challenge","category":"${c}"}`)).toEqual({
        ok: true, verdict: 'challenge', category: c,
      });
    }
  });

  it('trims surrounding whitespace only', () => {
    expect(parseAdversaryResponse('  {"verdict":"agree"}\n')).toEqual({ ok: true, verdict: 'agree' });
  });

  it('rejects fenced JSON as unparseable (strict means strict)', () => {
    expect(parseAdversaryResponse('```json\n{"verdict":"agree"}\n```')).toEqual({ ok: false, errorKind: 'unparseable' });
  });

  it('rejects challenge-without-category and agree-with-category (wrong oneOf branch)', () => {
    expect(parseAdversaryResponse('{"verdict":"challenge"}')).toEqual({ ok: false, errorKind: 'unparseable' });
    expect(parseAdversaryResponse('{"verdict":"agree","category":"other"}')).toEqual({ ok: false, errorKind: 'unparseable' });
  });

  it('rejects extra fields (exact allowlist)', () => {
    expect(parseAdversaryResponse('{"verdict":"agree","note":"hi"}')).toEqual({ ok: false, errorKind: 'unparseable' });
  });

  it('rejects __proto__ as an extra field, never a prototype write', () => {
    expect(parseAdversaryResponse('{"verdict":"agree","__proto__":{"x":1}}')).toEqual({ ok: false, errorKind: 'unparseable' });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('out-of-enum category is unknown-enum, distinct from unparseable', () => {
    expect(parseAdversaryResponse('{"verdict":"challenge","category":"vibes"}')).toEqual({ ok: false, errorKind: 'unknown-enum' });
  });

  it('caps size before parsing: >128 KiB is unparseable', () => {
    const big = `{"verdict":"agree","pad":"${'a'.repeat(140_000)}"}`;
    expect(parseAdversaryResponse(big)).toEqual({ ok: false, errorKind: 'unparseable' });
  });

  it('non-JSON and non-object are unparseable', () => {
    expect(parseAdversaryResponse('I agree with the output.')).toEqual({ ok: false, errorKind: 'unparseable' });
    expect(parseAdversaryResponse('"agree"')).toEqual({ ok: false, errorKind: 'unparseable' });
  });
});
