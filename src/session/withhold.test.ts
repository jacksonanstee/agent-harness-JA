import { describe, expect, it } from 'vitest';

import { scan } from '../security/index.js';
import { MIN_SPAN_LINE, WITHHELD_MARKER, WITHHOLD_SPAN_LINES_MAX, withholdNotice, withholdPlaceholder, withholdSpanLine } from './withhold.js';

// Issue #145 B2a (spec D1, D4): the pure pieces of a withhold. The walk, the
// pending entry and the rows are session.ts's (session-withhold.test.ts).

describe('the placeholder and the notice (spec D1; W9)', () => {
  it('pins the fixed values', () => {
    expect([WITHHELD_MARKER, WITHHOLD_SPAN_LINES_MAX, MIN_SPAN_LINE]).toEqual(['[WITHHELD:judge-block]', 32, 8]);
  });

  it('the placeholder is the spec sentence, starts with the marker, and scans pass on the shipped heuristic', () => {
    const p = withholdPlaceholder('Read');
    expect(p).toBe(
      '[WITHHELD:judge-block] The harness withheld this Read result: its prompt-injection judge classified the content as an attack. ' +
        'Continue the task without it; repeating the call will not return it.',
    );
    expect(p.startsWith(WITHHELD_MARKER)).toBe(true);
    expect(scan(p)).toMatchObject({ verdict: 'pass', rule_ids: [], suspicious: false });
  });

  it('the notice is the spec sentence with the bounded rule ids, and scans pass on the shipped heuristic', () => {
    const n = withholdNotice('Read', 'judge-block');
    expect(n).toBe(
      'The harness withheld this Read result (judge-block): its prompt-injection judge classified it as an attack. ' +
        'The placeholder in the result replaced its content.',
    );
    expect(scan(n)).toMatchObject({ verdict: 'pass', rule_ids: [], suspicious: false });
  });

  it('neither string carries a verdict word as a bare token the model could read as an instruction to itself: no "ignore", "disregard", "instructions"', () => {
    for (const s of [withholdPlaceholder('Bash'), withholdNotice('Bash', 'judge-block')]) {
      expect(s).not.toMatch(/\b(ignore|disregard|instructions?)\b/i);
    }
  });
});

describe('the content span oracle (spec D4, S5; W9b unit)', () => {
  const P = withholdPlaceholder('Read');

  it('takes the first NON-EMPTY line of at least MIN_SPAN_LINE chars: a blank first line, --- and a short line are skipped', () => {
    expect(withholdSpanLine('\n\n---\n#!/sh\nthe real first line of content here\nmore', P)).toBe('the real first line of content here');
  });

  it('records the line verbatim (leading whitespace kept) when its trimmed length qualifies', () => {
    expect(withholdSpanLine('   indented content line here\n', P)).toBe('   indented content line here');
  });

  it('a line the placeholder contains is never a span (an applied withhold must not read both-present)', () => {
    expect(withholdSpanLine('The harness withheld this\nsecond line long enough to key on', P)).toBe('second line long enough to key on');
    expect(withholdSpanLine(WITHHELD_MARKER, P)).toBeNull();
  });

  it('returns null when no line qualifies (an attacker can still force unobserved; a blank first line cannot)', () => {
    expect(withholdSpanLine('', P)).toBeNull();
    expect(withholdSpanLine('short\n\n  \nalso\n', P)).toBeNull();
    expect(withholdSpanLine('x'.repeat(MIN_SPAN_LINE - 1), P)).toBeNull();
    expect(withholdSpanLine('x'.repeat(MIN_SPAN_LINE), P)).toBe('x'.repeat(MIN_SPAN_LINE));
  });
});
