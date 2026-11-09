import { afterEach, describe, expect, it } from 'vitest';

import { redact } from '../security/index.js';
import type { RedactResult } from '../security/index.js';
import { build, closeDbs, drivenQuery, start } from '../../test/session-harness.js';
import type { Built } from '../../test/session-harness.js';
import type { SdkMessage } from './types.js';

// Issue #207 (ADR-0035 D4): a redaction entry that recorded NO secret span has
// nothing to watch for in the model's copy, and `[REDACTED:<id>]` markers are
// public strings. So a marker in that copy is not evidence the rewrite landed:
// the entry is `unobserved` / `no-content-span`, never `applied`. #145 B2a
// closed the same hole for withhold entries only.

afterEach(() => closeDbs());

const userResult = (toolUseId: string, content: unknown): SdkMessage =>
  ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }] }, parent_tool_use_id: null }) as unknown as SdkMessage;
const rewriteRows = (b: Built): Array<{ kind?: string; outcome: string; reason?: string }> =>
  b.events().filter((e) => e.type === 'tool-rewrite').map((e) => e.payload as { kind?: string; outcome: string; reason?: string });
const bashOut = (stdout: string): Record<string, unknown> => ({ stdout, stderr: '', interrupted: false, isImage: false });

const MARKER = '[REDACTED:short-secret]';
/** A redactor whose one finding is a 3-character span, under MIN_SPAN_LINE, so the entry records zero spans. */
const shortSpanRedactor = (text: string): RedactResult => {
  const start = text.indexOf('xyz');
  if (start < 0) return { redacted: text, findings: [] };
  return { redacted: text.replace('xyz', MARKER), findings: [{ rule_id: 'short-secret', start, end: start + 3, length: 3 }] };
};

async function runOnce(raw: string, modelCopy: string, redactor?: (t: string) => RedactResult) {
  const fake = drivenQuery([{ id: 'toolu_1', tool: 'Bash', output: bashOut(raw) }], { userMessages: [userResult('toolu_1', bashOut(modelCopy))] });
  const b = build(fake.query, undefined, redactor === undefined ? {} : { redactSecrets: redactor });
  const result = await start(b).run('hi');
  return { result, rows: rewriteRows(b), warnings: b.warnings };
}

describe('#207: a redaction entry with no recorded span cannot read applied on a planted marker', () => {
  it('raw content already carrying the marker, echoed RAW (the SDK dropped the rewrite): unobserved/no-content-span, not applied (N)', async () => {
    const raw = `token xyz ${MARKER}`;
    const { result, rows } = await runOnce(raw, raw, shortSpanRedactor);
    expect(result.outputRewrites.map((r) => [r.kind, r.outcome])).toEqual([['redact', 'unobserved']]);
    expect(rows).toEqual([expect.objectContaining({ kind: 'redact', outcome: 'unobserved', reason: 'no-content-span' })]);
  });

  it('a span-less entry whose rewrite DID land is also unobserved: without a span the two cases cannot be told apart', async () => {
    const raw = 'token xyz here';
    const { rows } = await runOnce(raw, `token ${MARKER} here`, shortSpanRedactor);
    expect(rows).toEqual([expect.objectContaining({ outcome: 'unobserved', reason: 'no-content-span' })]);
  });

  it('the default rules: a short keyword and a newline before the value record no span, so a planted marker reads unobserved (N)', async () => {
    // generic-keyword-secret's match starts `pwd:` (4 chars) on its first line, under MIN_SPAN_LINE.
    const raw = 'pwd:\n"' + 'abcdefghijklmnop1' + '" [REDACTED:generic-keyword-secret]';
    const { rows } = await runOnce(raw, raw);
    expect(rows).toEqual([expect.objectContaining({ kind: 'redact', outcome: 'unobserved', reason: 'no-content-span' })]);
  });

  describe('controls: an entry WITH a recorded span is unchanged', () => {
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const marker = '[REDACTED:aws-access-key-id]';

    it('the rewrite echoed: applied', async () => {
      const { rows } = await runOnce(`key ${key}`, `key ${marker}`);
      expect(rows).toEqual([expect.objectContaining({ kind: 'redact', outcome: 'applied' })]);
      expect(rows[0]?.reason).toBeUndefined();
    });

    it('the raw copy echoed: leaked', async () => {
      const { rows } = await runOnce(`key ${key}`, `key ${key}`);
      expect(rows).toEqual([expect.objectContaining({ kind: 'redact', outcome: 'leaked' })]);
    });
  });

  describe('review: the markers come from the findings, not from the text (F4)', () => {
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE';

    it('a planted marker for another rule id is not evidence: the key removed, only the planted marker left, reads neither-token, not applied (N)', async () => {
      const { rows } = await runOnce(`key ${key} [REDACTED:zzz]`, 'key [REDACTED:zzz]');
      expect(rows).toEqual([expect.objectContaining({ kind: 'redact', outcome: 'unobserved', reason: 'neither-token' })]);
    });

    it('a planted marker cannot put its id, or a forged line, into the warning (N)', async () => {
      const { warnings } = await runOnce(`key ${key} [REDACTED:zzz\nWARN: forged]`, `key ${key}`);
      const redacted = warnings.filter((w) => w.startsWith('secrets redacted from the Bash output shown to the model'));
      expect(redacted).toEqual([expect.stringContaining('rules: aws-access-key-id)')]);
      expect(warnings.join('\n')).not.toMatch(/zzz|forged/);
    });

    it('the failed-call warning names the finding rules only (N)', async () => {
      const fake = drivenQuery([{ id: 'toolu_1', tool: 'Bash', failError: `boom ${key} [REDACTED:zzz\nWARN: forged]` }]);
      const b = build(fake.query, undefined);
      await start(b).run('hi');
      const failure = b.warnings.filter((w) => w.startsWith('secrets found in Bash FAILURE output'));
      expect(failure).toEqual([expect.stringContaining('rules: aws-access-key-id)')]);
      expect(b.warnings.join('\n')).not.toMatch(/zzz|forged/);
    });
  });

  describe('review: an oversized leaf with no finding records a line of its dropped tail', () => {
    // Over the redactor's 128 KiB cap, numbered lines so the tail's last line appears nowhere in the scanned head.
    const big = Array.from({ length: 14_000 }, (_, i) => `log line number ${i} of the run`).join('\n');
    const rewritten = redact(big).redacted;

    it('the fixture is oversized, carries no finding and has its tail dropped', () => {
      expect(redact(big).findings).toEqual([]);
      expect(rewritten).toContain('[REDACTED:oversized-input]');
      expect(rewritten).not.toContain('log line number 13999 of the run');
    });

    it('the rewrite echoed: applied, not no-content-span', async () => {
      const { rows } = await runOnce(big, rewritten);
      expect(rows).toEqual([expect.objectContaining({ kind: 'redact', outcome: 'applied', findings: 0, truncated: true })]);
    });

    it('the raw copy echoed with a planted marker: both-present, never applied (N)', async () => {
      const { rows } = await runOnce(`${big} [REDACTED:oversized-input]`, `${big} [REDACTED:oversized-input]`);
      expect(rows).toEqual([expect.objectContaining({ outcome: 'unobserved', reason: 'both-present' })]);
    });

    it('the raw copy echoed: leaked', async () => {
      const { rows } = await runOnce(big, big);
      expect(rows).toEqual([expect.objectContaining({ outcome: 'leaked' })]);
    });

    it('a tail line the head also holds is skipped for one the rewrite lacks, so a landed rewrite still reads applied', async () => {
      // The last lines repeat the head (common in logs); a span from them would sit in the landed copy too and read both-present.
      const repeating = `${big}\nthe one line only the tail holds\n${Array.from({ length: 5 }, (_, i) => `log line number ${i} of the run`).join('\n')}`;
      const { rows } = await runOnce(repeating, redact(repeating).redacted);
      expect(rows).toEqual([expect.objectContaining({ outcome: 'applied', truncated: true })]);
    });

    it('one oversized line with no newline (minified output): its last characters are the span, so landed reads applied and raw leaked', async () => {
      const line = Array.from({ length: 9_000 }, (_, i) => `t${i}.`).join('').padEnd(140_000, 'z') + 'end-of-the-only-line';
      expect(line.length).toBeGreaterThan(131_072);
      expect((await runOnce(line, redact(line).redacted)).rows).toEqual([expect.objectContaining({ outcome: 'applied', truncated: true })]);
      expect((await runOnce(line, line)).rows).toEqual([expect.objectContaining({ outcome: 'leaked' })]);
    });

    it('a tail of only short lines records nothing, so even a landed rewrite reads no-content-span', async () => {
      const shorts = `${'x'.repeat(140_000)}\n${Array.from({ length: 70 }, () => 'ab').join('\n')}`;
      const { rows } = await runOnce(shorts, redact(shorts).redacted);
      expect(rows).toEqual([expect.objectContaining({ outcome: 'unobserved', reason: 'no-content-span' })]);
    });
  });
});
