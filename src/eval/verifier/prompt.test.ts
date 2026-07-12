import { describe, expect, it } from 'vitest';
import { buildChallengePrompt } from './prompt.js';

const input = { taskId: 'di-01', taskPrompt: 'List the files.', redactedResultText: 'I listed 3 files.' };

describe('buildChallengePrompt', () => {
  it('wraps each payload in the nonce boundary and labels its origin', () => {
    const p = buildChallengePrompt(input, () => 'aaaaaaaaaaaaaaaa');
    expect(p).toContain('<<<UNTRUSTED-aaaaaaaaaaaaaaaa>>>');
    expect(p).toContain('<<<END-UNTRUSTED-aaaaaaaaaaaaaaaa>>>');
    // Both payloads present, labelled, inside boundaries:
    expect(p).toContain('List the files.');
    expect(p).toContain('I listed 3 files.');
    expect(p).toMatch(/task prompt/i);
    expect(p).toMatch(/agent output/i);
  });

  it('uses a fresh nonce per call (distinct boundaries across calls)', () => {
    let n = 0;
    const hex = () => (n++ === 0 ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb');
    const p1 = buildChallengePrompt(input, hex);
    const p2 = buildChallengePrompt(input, hex);
    expect(p1).toContain('UNTRUSTED-aaaaaaaaaaaaaaaa');
    expect(p2).toContain('UNTRUSTED-bbbbbbbbbbbbbbbb');
    expect(p2).not.toContain('aaaaaaaaaaaaaaaa');
  });

  it('instructs a single JSON object with the closed enums and no prose', () => {
    const p = buildChallengePrompt(input, () => 'aaaaaaaaaaaaaaaa');
    expect(p).toContain('"agree"');
    expect(p).toContain('"challenge"');
    for (const c of ['incomplete', 'incorrect', 'unsupported-claim', 'unsafe', 'other']) {
      expect(p).toContain(c);
    }
    expect(p).toMatch(/only.*json/i);
  });

  it('labels the payloads as untrusted content to analyze, not instructions', () => {
    const p = buildChallengePrompt(input, () => 'aaaaaaaaaaaaaaaa');
    expect(p).toMatch(/untrusted/i);
    expect(p).toMatch(/do not follow/i);
  });
});
