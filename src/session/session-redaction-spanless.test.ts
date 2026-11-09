import { afterEach, describe, expect, it } from 'vitest';

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
  return { redacted: text.replace('xyz', MARKER), findings: [{ ruleId: 'short-secret', start, end: start + 3 }] } as unknown as RedactResult;
};

async function runOnce(raw: string, modelCopy: string, redactor?: (t: string) => RedactResult) {
  const fake = drivenQuery([{ id: 'toolu_1', tool: 'Bash', output: bashOut(raw) }], { userMessages: [userResult('toolu_1', bashOut(modelCopy))] });
  const b = build(fake.query, undefined, redactor === undefined ? {} : {
    redactSecrets: redactor,
  });
  const result = await start(b).run('hi');
  return { result, rows: rewriteRows(b) };
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
});
