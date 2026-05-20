import { describe, expect, it } from 'vitest';
import { createRouter, route } from './route.js';
import type {
  RoutingRule,
  TaskDescriptor,
  TaskSensitivity,
  TaskShape,
} from './types.js';

const base: TaskDescriptor = {
  shape: 'build',
  sensitivity: 'low',
  expected_tokens: 1_000,
};

describe('router: default table — shape routing', () => {
  it('routes lookup to haiku', () => {
    const c = route({ ...base, shape: 'lookup' });
    expect(c.model).toBe('claude-haiku-4-5');
    expect(c.rule_id).toBe('shape-lookup');
  });

  it('routes research to opus', () => {
    const c = route({ ...base, shape: 'research' });
    expect(c.model).toBe('claude-opus-4-7');
    expect(c.rule_id).toBe('shape-research');
  });

  it('routes small review to sonnet', () => {
    const c = route({ ...base, shape: 'review', expected_tokens: 5_000 });
    expect(c.model).toBe('claude-sonnet-4-6');
    expect(c.rule_id).toBe('shape-review-small');
  });

  it('routes small build to sonnet', () => {
    const c = route({ ...base, shape: 'build', expected_tokens: 10_000 });
    expect(c.model).toBe('claude-sonnet-4-6');
    expect(c.rule_id).toBe('shape-build-small');
  });

  it('escalates medium-sensitivity large build to opus via fallthrough', () => {
    const c = route({
      shape: 'build',
      sensitivity: 'medium',
      expected_tokens: 100_000,
    });
    expect(c.model).toBe('claude-opus-4-7');
    expect(c.rule_id).toBe('fallthrough');
  });

  it('escalates large review to opus via fallthrough', () => {
    const c = route({ ...base, shape: 'review', expected_tokens: 50_000 });
    expect(c.model).toBe('claude-opus-4-7');
    expect(c.rule_id).toBe('fallthrough');
  });
});

describe('router: high sensitivity beats every shape', () => {
  const shapes: TaskShape[] = ['review', 'build', 'research', 'lookup'];
  for (const shape of shapes) {
    it(`high + ${shape} → opus`, () => {
      const c = route({ ...base, shape, sensitivity: 'high' });
      expect(c.model).toBe('claude-opus-4-7');
      expect(c.rule_id).toBe('sensitivity-high');
    });
  }
});

describe('router: token threshold boundaries', () => {
  it('review at 19_999 tokens → sonnet', () => {
    expect(
      route({ ...base, shape: 'review', expected_tokens: 19_999 }).model,
    ).toBe('claude-sonnet-4-6');
  });

  it('review at exactly 20_000 tokens → fallthrough opus', () => {
    const c = route({ ...base, shape: 'review', expected_tokens: 20_000 });
    expect(c.model).toBe('claude-opus-4-7');
    expect(c.rule_id).toBe('fallthrough');
  });

  it('build at 49_999 tokens → sonnet', () => {
    expect(
      route({ ...base, shape: 'build', expected_tokens: 49_999 }).model,
    ).toBe('claude-sonnet-4-6');
  });

  it('build at exactly 50_000 tokens → fallthrough opus', () => {
    expect(
      route({ ...base, shape: 'build', expected_tokens: 50_000 }).model,
    ).toBe('claude-opus-4-7');
  });
});

describe('router: validation', () => {
  it('rejects negative token estimates', () => {
    expect(() => route({ ...base, expected_tokens: -1 })).toThrow(TypeError);
  });

  it('rejects NaN tokens', () => {
    expect(() => route({ ...base, expected_tokens: Number.NaN })).toThrow(
      TypeError,
    );
  });

  it('rejects Infinity tokens', () => {
    expect(() =>
      route({ ...base, expected_tokens: Number.POSITIVE_INFINITY }),
    ).toThrow(TypeError);
  });

  it('rejects unknown shape values', () => {
    expect(() =>
      route({ ...base, shape: 'bogus' as unknown as TaskShape }),
    ).toThrow(/shape must be one of/);
  });

  it('rejects unknown sensitivity values', () => {
    expect(() =>
      route({
        ...base,
        sensitivity: 'critical' as unknown as TaskSensitivity,
      }),
    ).toThrow(/sensitivity must be one of/);
  });
});

describe('router: custom table', () => {
  it('honours caller-supplied rules with first-match-wins', () => {
    const table: RoutingRule[] = [
      {
        id: 'all-haiku',
        match: () => true,
        model: 'claude-haiku-4-5',
        reason: 'custom: always haiku',
      },
    ];
    const c = createRouter({ table }).route({ ...base, sensitivity: 'high' });
    expect(c.model).toBe('claude-haiku-4-5');
    expect(c.rule_id).toBe('all-haiku');
  });

  it('falls through to opus when no custom rule matches', () => {
    const c = createRouter({ table: [] }).route(base);
    expect(c.model).toBe('claude-opus-4-7');
    expect(c.rule_id).toBe('fallthrough');
  });

  it('treats a throwing rule as non-matching and continues', () => {
    const table: RoutingRule[] = [
      {
        id: 'buggy',
        match: () => {
          throw new Error('predicate blew up');
        },
        model: 'claude-haiku-4-5',
        reason: 'never reached',
      },
      {
        id: 'after-buggy',
        match: () => true,
        model: 'claude-sonnet-4-6',
        reason: 'after-buggy reached',
      },
    ];
    const c = createRouter({ table }).route(base);
    expect(c.model).toBe('claude-sonnet-4-6');
    expect(c.rule_id).toBe('after-buggy');
  });

  it('strips control characters from custom reason strings', () => {
    const table: RoutingRule[] = [
      {
        id: 'malicious',
        match: () => true,
        model: 'claude-haiku-4-5',
        reason: 'line1\nFAKE LOG ENTRY\rmore',
      },
    ];
    const c = createRouter({ table }).route(base);
    expect(c.reason).not.toMatch(/[\n\r]/);
    expect(c.reason).toBe('line1 FAKE LOG ENTRY more');
  });
});

describe('router: ModelChoice shape', () => {
  it('always returns rule_id and reason', () => {
    const c = route(base);
    expect(typeof c.rule_id).toBe('string');
    expect(c.rule_id.length).toBeGreaterThan(0);
    expect(typeof c.reason).toBe('string');
    expect(c.reason.length).toBeGreaterThan(0);
  });
});
