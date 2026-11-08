import { describe, expect, it } from 'vitest';
import { DEFAULT_INJECTION_RULES, JUDGE_RULE_IDS, JUDGE_OVERSIZED_RULE_ID, JUDGE_REDACTED_RULE_ID, JUDGE_REFUSED_RULE_ID } from '../security/index.js';
import { NON_CONFORMING_RULE_ID, RULE_ID, RULE_ID_MAX, withIdentifierRuleIds } from './scan-rule-ids.js';

describe('withIdentifierRuleIds (#234 review)', () => {
  it('every shipped rule id is an identifier, so none is ever replaced', () => {
    const judgeIds = Array.isArray(JUDGE_RULE_IDS) ? JUDGE_RULE_IDS : Object.values(JUDGE_RULE_IDS as Record<string, string>);
    const shipped = [...DEFAULT_INJECTION_RULES.map((r) => r.id), ...judgeIds, JUDGE_OVERSIZED_RULE_ID, JUDGE_REDACTED_RULE_ID, JUDGE_REFUSED_RULE_ID];
    expect(shipped.length).toBeGreaterThan(10);
    for (const id of shipped) expect(RULE_ID.test(id) && id.length <= RULE_ID_MAX, id).toBe(true);
  });

  it('replaces anything else, keeps order, and deduplicates the placeholder', () => {
    const out = withIdentifierRuleIds({
      verdict: 'block',
      rule_ids: ['ignore-previous', `saw ${'AKIA' + 'IOSFODNN7EXAMPLE'}`, 'x'.repeat(RULE_ID_MAX + 1), 7 as unknown as string, 'Upper', 'another bad'],
      excerpts: [],
      suspicious: false,
    });
    expect(out.rule_ids).toEqual(['ignore-previous', NON_CONFORMING_RULE_ID]);
  });

  it('a sparse array yields only strings (a hole is not an identifier)', () => {
    // eslint-disable-next-line no-sparse-arrays -- the hostile input under test
    const sparse = [, 'ok-id'] as unknown as string[];
    const out = withIdentifierRuleIds({ verdict: 'block', rule_ids: sparse, excerpts: [], suspicious: false });
    expect(out.rule_ids).toEqual([NON_CONFORMING_RULE_ID, 'ok-id']);
    expect(out.rule_ids.every((id) => typeof id === 'string')).toBe(true);
  });

  it('returns a new object and leaves a malformed result to the caller', () => {
    const input = { verdict: 'pass' as const, rule_ids: ['a'], excerpts: [], suspicious: false };
    expect(withIdentifierRuleIds(input)).not.toBe(input);
    const malformed = { verdict: 'pass', rule_ids: 'nope' } as unknown as Parameters<typeof withIdentifierRuleIds>[0];
    expect(withIdentifierRuleIds(malformed)).toBe(malformed);
  });
});
