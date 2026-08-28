import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { composeSecurity, formatModelClaim, formatRefusalLine, hookRecordToTelemetryInput, main, parseArgs, parseRedteamArgs, parseRunArgs, refuseSymlinkedDir, sanitizeForTerminal, scorecardFilename, SettingsLoadError, writeScorecard } from './cli.js';
import { CORPUS, EvalUsageError, normalizeForBaseline, REDTEAM_ARM_LABEL, runRedteam, toCanonicalJson } from './eval/index.js';
import type { GoldenScorecard } from './eval/index.js';
import type { HookEventRecord } from './hooks/index.js';
import { DEFAULT_DB_PATH } from './memory/index.js';
import { redact, scan } from './security/index.js';
import { createTelemetryStore, openTelemetryDatabase } from './telemetry/index.js';
import { MAX_SETTINGS_BYTES } from './internal/settings.js';
import type { TelemetryEvent } from './telemetry/index.js';

describe('parseRunArgs', () => {
  it('parses a bare run command with defaults', () => {
    const parsed = parseRunArgs(['run', 'say hello']);
    expect(parsed).toEqual({
      ok: true,
      value: {
        command: 'run',
        prompt: 'say hello',
        skillsDir: './skills',
        dbPath: DEFAULT_DB_PATH,
        maxTurns: 10,
      },
    });
  });

  it('parses all flags', () => {
    const parsed = parseRunArgs([
      'run',
      'hi',
      '--skills-dir',
      '/tmp/skills',
      '--db',
      '/tmp/mem.db',
      '--max-turns',
      '3',
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.command === 'run') {
      expect(parsed.value.skillsDir).toBe('/tmp/skills');
      expect(parsed.value.dbPath).toBe('/tmp/mem.db');
      expect(parsed.value.maxTurns).toBe(3);
    }
  });

  it('rejects an unknown command', () => {
    const parsed = parseRunArgs(['serve']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Unknown command 'serve'");
  });

  it('rejects a missing prompt', () => {
    expect(parseRunArgs(['run']).ok).toBe(false);
    expect(parseRunArgs(['run', '  ']).ok).toBe(false);
  });

  it('rejects a flag with no value', () => {
    const parsed = parseRunArgs(['run', 'hi', '--db']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('--db');
  });

  it('rejects unknown flags and extra positionals', () => {
    expect(parseRunArgs(['run', 'hi', '--verbose']).ok).toBe(false);
    expect(parseRunArgs(['run', 'hi', 'there']).ok).toBe(false);
  });

  it('rejects a non-positive --max-turns', () => {
    expect(parseRunArgs(['run', 'hi', '--max-turns', '0']).ok).toBe(false);
    expect(parseRunArgs(['run', 'hi', '--max-turns', 'abc']).ok).toBe(false);
    expect(parseRunArgs(['run', 'hi', '--max-turns', '5abc']).ok).toBe(false);
  });
});

describe('sanitizeForTerminal', () => {
  it('strips ANSI/OSC escape introducers and C1 controls, keeps newlines and tabs', () => {
    expect(sanitizeForTerminal('a\u001b[31mred\u0007b')).toBe('a [31mred b');
    expect(sanitizeForTerminal('line1\nline2\tend')).toBe('line1\nline2\tend');
    expect(sanitizeForTerminal('overwrite\rspoof')).toBe('overwrite spoof'); // CR enables line-rewrite spoofing
  });
});

// ADR-0025. The full `run` path cannot execute in-suite (it loads the real
// SDK), so the operator-facing refusal report is a pure function tested here;
// the capture semantics behind it live in src/session/session.test.ts.
describe('formatRefusalLine', () => {
  it('returns null when there was no refusal', () => {
    expect(formatRefusalLine(null, 'end_turn')).toBeNull();
  });

  it('reports source, category, fallback and stop_reason', () => {
    const line = formatRefusalLine(
      { source: 'system-event', category: 'cyber', fallbackModel: null },
      'refusal',
    );
    expect(line).toContain('system-event');
    expect(line).toContain('cyber');
    // Vendor tokens are QUOTED so they cannot forge a sibling field.
    expect(line).toContain('category="cyber"');
    expect(line).toContain('stop_reason="refusal"');
  });

  it('names the answering model when the turn was swapped to a fallback', () => {
    const line = formatRefusalLine(
      { source: 'system-event', category: null, fallbackModel: 'claude-sonnet-5' },
      'end_turn',
    );
    expect(line).toContain('claude-sonnet-5');
    // The operator has to be able to see that the routed model is not the one
    // that answered, which is the whole point of surfacing the swap.
    expect(line).toMatch(/fallback/i);
  });

  it('sanitizes terminal escapes in every interpolated field', () => {
    const line = formatRefusalLine(
      {
        source: 'system-event',
        category: 'cy\u001b[31mber',
        fallbackModel: 'model\u0007x',
      },
      'ref\u001b[0musal',
    );
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('\u0007');
  });
});

describe('formatModelClaim', () => {
  it('returns the routed model unchanged when nothing was swapped', () => {
    expect(formatModelClaim('claude-opus-5', null)).toBe('claude-opus-5');
    expect(
      formatModelClaim('claude-opus-5', {
        source: 'system-event',
        category: 'cyber',
        fallbackModel: null,
      }),
    ).toBe('claude-opus-5');
  });

  it('annotates the claim on the SAME stream when a fallback answered', () => {
    // Without this, `run > out.txt` captured a file whose only model claim was
    // false, with the correction on a stream the file never saw.
    const claim = formatModelClaim('claude-fable-5', {
      source: 'system-event',
      category: 'cyber',
      fallbackModel: 'claude-sonnet-5',
    });
    expect(claim).toContain('claude-fable-5');
    expect(claim).toContain('answered by "claude-sonnet-5"');
  });

  it('a space-bearing token cannot forge a sibling field', () => {
    // Verify-pass finding: unquoted values in a space-delimited key=value line
    // let a category forge `fallback=`, so a naive grep reported the wrong
    // answering model.
    const line = formatRefusalLine(
      {
        source: 'system-event',
        category: 'benign fallback=none stop_reason=end_turn',
        fallbackModel: 'claude-evil-9',
      },
      'refusal',
    );
    expect(line).not.toBeNull();
    // The whole hostile value sits inside ONE quoted span, so a quote-aware
    // parse sees a single `category` field. Neutralize quoted spans and only
    // the real `fallback=` field remains.
    expect(line).toContain('category="benign fallback=none stop_reason=end_turn"');
    const outsideQuotes = (line ?? '').replace(/"[^"]*"/g, '""');
    expect([...outsideQuotes.matchAll(/fallback=/g)]).toHaveLength(1);
    expect(line).toContain('"claude-evil-9"');
    // Belt and braces: the session layer additionally collapses whitespace at
    // capture, so a real SDK token cannot carry a space this far. See
    // session.test.ts 'collapses internal whitespace'.
    expect(formatRefusalLine(
      { source: 'system-event', category: 'no_spaces_here', fallbackModel: null },
      'refusal',
    )).toContain('category="no_spaces_here"');
  });

  it('sanitizes the fallback model name', () => {
    const claim = formatModelClaim('claude-opus-5', {
      source: 'system-event',
      category: null,
      fallbackModel: 'evil\u001b[31m',
    });
    expect(claim).not.toContain('\u001b');
  });
});

describe('parseArgs (telemetry export)', () => {
  it('parses telemetry export with defaults', () => {
    const parsed = parseArgs(['telemetry', 'export']);
    expect(parsed).toEqual({
      ok: true,
      value: {
        command: 'telemetry-export',
        dbPath: DEFAULT_DB_PATH,
        out: null,
        sessionId: null,
        type: null,
        scrubPrefixes: [],
      },
    });
  });

  it('parses all export flags', () => {
    const parsed = parseArgs([
      'telemetry',
      'export',
      '--db',
      '/tmp/t.db',
      '--out',
      '/tmp/out.jsonl',
      '--session',
      's1',
      '--type',
      'turn-cost',
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.command === 'telemetry-export') {
      expect(parsed.value.dbPath).toBe('/tmp/t.db');
      expect(parsed.value.out).toBe('/tmp/out.jsonl');
      expect(parsed.value.sessionId).toBe('s1');
      expect(parsed.value.type).toBe('turn-cost');
    }
  });

  it('rejects an invalid --type, unknown subcommand, and unknown flags', () => {
    expect(parseArgs(['telemetry', 'export', '--type', 'bogus']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'import']).ok).toBe(false);
    expect(parseArgs(['telemetry']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'export', '--verbose']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'export', '--db']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'export', 'extra']).ok).toBe(false);
  });

  it('still routes run through the union', () => {
    const parsed = parseArgs(['run', 'hi']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.command).toBe('run');
  });
});

describe('hookRecordToTelemetryInput', () => {
  const ids = { sessionId: 'harness-1', turnId: 'turn-1' };
  const deps = { redactSecrets: redact };
  // Assembled from fragments so the repo's own secret scan never sees a literal
  // (the S-2 fixture idiom, src/security/secrets/redact.test.ts).
  const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';

  const denied = (reason: string): HookEventRecord => ({
    kind: 'denied-by-hook',
    event: 'pre-tool',
    handlerIndex: 2,
    tool: 'Bash',
    reason,
  });
  const errored = (reason: string): HookEventRecord => ({
    kind: 'hook-error',
    event: 'post-tool',
    handlerIndex: 0,
    reason,
  });
  const reasonOf = (record: HookEventRecord, d = deps): string | undefined => {
    const input = hookRecordToTelemetryInput(record, ids, d);
    if (input.type !== 'hook-event') throw new Error('expected a hook-event input');
    return input.payload.reason;
  };

  it('maps all three HookEventRecord kinds', () => {
    const fired: HookEventRecord = { kind: 'hook-fired', event: 'stop', handlersFired: 3 };

    expect(hookRecordToTelemetryInput(denied('blocked'), ids, deps)).toEqual({
      type: 'hook-event',
      sessionId: 'harness-1',
      turnId: 'turn-1',
      payload: { kind: 'denied-by-hook', event: 'pre-tool', tool: 'Bash', reason: 'blocked', handlerIndex: 2 },
    });
    expect(hookRecordToTelemetryInput(errored('observer broke'), ids, deps)).toEqual({
      type: 'hook-event',
      sessionId: 'harness-1',
      turnId: 'turn-1',
      payload: { kind: 'hook-error', event: 'post-tool', reason: 'observer broke', handlerIndex: 0 },
    });
    expect(hookRecordToTelemetryInput(fired, ids, deps)).toEqual({
      type: 'hook-event',
      sessionId: 'harness-1',
      turnId: 'turn-1',
      payload: { kind: 'hook-fired', event: 'stop', handlersFired: 3 },
    });
  });

  // Issue #75: the telemetry copy of a hook reason sat below the codebase's own
  // standard for attacker-influenced strings entering a retained sink (memory's
  // denied[] and tool-trace resultSummary are both redact-then-truncated). ANY
  // registered hook's throw message becomes this row, not only harness-authored
  // reasons — the review's executed PoC was a hook throwing a message that
  // carried an AWS key, and the key landed in the denied-by-hook row verbatim.
  it('redacts a secret in a denied-by-hook reason before it reaches telemetry (issue #75)', () => {
    const reason = reasonOf(denied(`blocked; saw ${AWS_KEY} in args`));
    expect(reason).not.toContain(AWS_KEY);
    expect(reason).not.toContain('AKIA');
    expect(reason).toContain('[REDACTED:');
  });

  it('redacts a secret in a hook-error reason on the same seam', () => {
    const reason = reasonOf(errored(`observer broke on ${AWS_KEY}`));
    expect(reason).not.toContain(AWS_KEY);
    expect(reason).toContain('[REDACTED:');
  });

  // 200 is the TOTAL stored length including the ellipsis (telemetry's cap
  // convention, HOOK_EVENT_REASON_MAX in src/telemetry/types.ts), so the
  // content is cut at 199. Literal, not the constant: a tautological pin
  // would stay green when the constant moves.
  it('caps the reason at 200 stored units including the ellipsis', () => {
    const reason = reasonOf(denied('x'.repeat(500)));
    expect(reason).toHaveLength(200);
    expect(reason?.startsWith('x'.repeat(199))).toBe(true);
    expect(reason?.endsWith('…')).toBe(true);
  });

  // Order pin. The key occupies indices 180-199 (after the \b the rule needs)
  // and the content cut is at 199, so the cap falls INSIDE the key. Truncating
  // first would leave a 19-char fragment: too short for the rule's {16} tail
  // to match, too long to be harmless — the same transform-then-truncate
  // contract session.ts enforces. Redacting first leaves the marker's head.
  it('redacts BEFORE truncating: a secret straddling the cap never survives as a fragment', () => {
    const reason = reasonOf(denied('x'.repeat(179) + ' ' + AWS_KEY + ' tail'));
    expect(reason).not.toContain('AKIA');
    expect(reason).toContain('[REDACTED:');
  });

  it('fails closed to the sentinel when the redactor throws, and still produces the row', () => {
    const throwing = {
      redactSecrets: (): never => {
        throw new Error('redactor exploded');
      },
    };
    const input = hookRecordToTelemetryInput(denied(`saw ${AWS_KEY}`), ids, throwing);
    expect(input).toEqual({
      type: 'hook-event',
      sessionId: 'harness-1',
      turnId: 'turn-1',
      payload: {
        kind: 'denied-by-hook',
        event: 'pre-tool',
        tool: 'Bash',
        reason: '[REDACTION FAILED]',
        handlerIndex: 2,
      },
    });
  });

  // A redactor that returns a malformed result instead of throwing must fail
  // closed the same way: the sink swallows throws (src/hooks/runtime.ts), so
  // a TypeError escaping the mapper would drop the row with no trace at all.
  it('fails closed to the sentinel when the redactor returns a malformed result', () => {
    const malformed = {
      redactSecrets: () => ({ redacted: undefined as unknown as string, findings: [] }),
    };
    expect(reasonOf(denied(`saw ${AWS_KEY}`), malformed)).toBe('[REDACTION FAILED]');
  });

  // An array (or any array-like with a small .length) slips through a naive
  // length-based cut without throwing; the store then rejects the non-string
  // reason with a throw the sink swallows, and the row vanishes silently.
  it('fails closed to the sentinel when the redactor returns a non-string redacted value', () => {
    const arrayShaped = {
      redactSecrets: () => ({ redacted: ['a'] as unknown as string, findings: [] }),
    };
    expect(reasonOf(denied(`saw ${AWS_KEY}`), arrayShaped)).toBe('[REDACTION FAILED]');
  });

  it('leaves hook-fired rows untouched and never invokes the redactor for them', () => {
    const spy = vi.fn(redact);
    const fired: HookEventRecord = { kind: 'hook-fired', event: 'stop', handlersFired: 3 };
    expect(hookRecordToTelemetryInput(fired, ids, { redactSecrets: spy })).toEqual({
      type: 'hook-event',
      sessionId: 'harness-1',
      turnId: 'turn-1',
      payload: { kind: 'hook-fired', event: 'stop', handlersFired: 3 },
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('main (telemetry export)', () => {
  let tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
    vi.restoreAllMocks();
  });

  function seededDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-'));
    tmpDirs.push(dir);
    const path = join(dir, 'telemetry.db');
    const db = openTelemetryDatabase({ path });
    const store = createTelemetryStore(db);
    store.record({
      type: 'hook-event',
      sessionId: 's1',
      turnId: 't1',
      ts: 100,
      payload: { kind: 'hook-fired', event: 'session-start', handlersFired: 0 },
    });
    store.record({
      type: 'tool-trace',
      sessionId: 's2',
      turnId: 't2',
      ts: 200,
      payload: { tool: 'Read', phase: 'post-tool', resultSummary: 'x' },
    });
    db.close();
    return path;
  }

  // Escape literals only, never raw bytes in test source: this repo has already
  // shipped a defect from asserting on the escaped TEXT of a hostile string
  // rather than the raw BYTES it carried.
  const RLO = '\u202E';
  const ZWSP = '\u200B';
  const LINE_SEPARATOR = '\u2028';
  const DEL = '\u007F';
  const CSI = '\u009B';
  const HOSTILE_CHARS: readonly string[] = [RLO, ZWSP, LINE_SEPARATOR, DEL, CSI];
  // Since issue #51, `record()` REFUSES a sessionId like this, so it can no
  // longer be seeded through the public API. See the raw INSERT in hostileDb
  // below and the reason it is the more faithful fixture.
  const HOSTILE_SESSION = `s${RLO}${LINE_SEPARATOR}${DEL}${CSI}1`;
  // A payload field that IS sanitized on write, proving the point the deleted
  // comment got wrong: sanitizeText spaces control chars but passes bidi and
  // zero-width characters through untouched.
  const HOSTILE_REASON = `x${ZWSP}`;

  function hostileDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-hostile-'));
    tmpDirs.push(dir);
    const path = join(dir, 'telemetry.db');
    const db = openTelemetryDatabase({ path });
    const store = createTelemetryStore(db);
    // Seeded by RAW INSERT, deliberately bypassing record()'s correlation-id
    // gate (issue #51). This is not a workaround for the guard. It is the
    // more faithful fixture, and the guard is what makes that clear. The write
    // path now refuses these ids, so the only way such a row exists in a real
    // database is the way this INSERT models it: written by a binary older
    // than #51, or by another writer straight into the shared SQLite file,
    // which is exactly the case rowToEvent's "never trust a shared DB file
    // blindly" validation exists for. The exporter therefore still has to
    // escape on READ, and these tests are what hold that true; #51 narrowed
    // the entry points, it did not make the export sink's job go away.
    db.prepare(
      `INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload)
       VALUES (@id, @type, @sessionId, @turnId, @ts, @payload)`,
    ).run({
      id: '00000000-0000-4000-8000-000000000001',
      type: 'hook-event',
      sessionId: HOSTILE_SESSION,
      turnId: 't1',
      ts: 100,
      payload: JSON.stringify({ kind: 'hook-fired', event: 'session-start', handlersFired: 0 }),
    });
    store.record({
      type: 'hook-event',
      sessionId: 's2',
      turnId: 't2',
      ts: 200,
      payload: { kind: 'hook-error', event: 'stop', reason: HOSTILE_REASON, handlerIndex: 0 },
    });
    db.close();
    return path;
  }

  function outPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-hostile-out-'));
    tmpDirs.push(dir);
    return join(dir, 'events.jsonl');
  }

  async function exportToStdout(dbPath: string): Promise<{ code: number; written: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const code = await main(['telemetry', 'export', '--db', dbPath]);
      return { code, written: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  it('writes no raw bidi or invisible byte to --out', async () => {
    const path = hostileDb();
    const out = outPath();
    expect(await main(['telemetry', 'export', '--db', path, '--out', out])).toBe(0);
    // Byte level, not string level: a string comparison against escaped text
    // is the assertion that cannot fail.
    const bytes = readFileSync(out);
    for (const char of HOSTILE_CHARS) {
      const label = `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`;
      expect(bytes.includes(Buffer.from(char, 'utf8')), label).toBe(false);
    }
  });

  it('writes no raw bidi or invisible byte to stdout', async () => {
    const path = hostileDb();
    const { code, written } = await exportToStdout(path);
    expect(code).toBe(0);
    for (const char of HOSTILE_CHARS) {
      const label = `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`;
      expect(Buffer.from(written, 'utf8').includes(Buffer.from(char, 'utf8')), label).toBe(false);
    }
  });

  it('emits byte-identical output to --out and stdout for the same query', async () => {
    const path = hostileDb();
    const out = outPath();
    expect(await main(['telemetry', 'export', '--db', path, '--out', out])).toBe(0);
    const { code, written } = await exportToStdout(path);
    expect(code).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(written);
  });

  it('exports rows whose values survive JSON.parse unchanged', async () => {
    const path = hostileDb();
    const out = outPath();
    expect(await main(['telemetry', 'export', '--db', path, '--out', out])).toBe(0);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const events = lines.map((line) => JSON.parse(line) as TelemetryEvent);
    expect(events[0]?.sessionId).toBe(HOSTILE_SESSION);
    expect((events[1]?.payload as { reason?: string }).reason).toBe(HOSTILE_REASON);
  });

  it('writes JSONL to stdout by default', async () => {
    const path = seededDb();
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
    const code = await main(['telemetry', 'export', '--db', path]);
    spy.mockRestore();
    expect(code).toBe(0);
    const lines = chunks.join('').trim().split('\n');
    expect(lines).toHaveLength(2);
    const events = lines.map((l) => JSON.parse(l) as TelemetryEvent);
    expect(events.map((e) => e.type)).toEqual(['hook-event', 'tool-trace']);
  });

  it('filters by --session and --type and writes to --out', async () => {
    const path = seededDb();
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-out-'));
    tmpDirs.push(dir);
    const out = join(dir, 'events.jsonl');
    const code = await main(['telemetry', 'export', '--db', path, '--session', 's2', '--out', out]);
    expect(code).toBe(0);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '{}') as TelemetryEvent).sessionId).toBe('s2');

    const code2 = await main(['telemetry', 'export', '--db', path, '--type', 'hook-event', '--out', out]);
    expect(code2).toBe(0);
    const lines2 = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines2).toHaveLength(1);
    expect((JSON.parse(lines2[0] ?? '{}') as TelemetryEvent).type).toBe('hook-event');
  });

  it('does not require ANTHROPIC_API_KEY', async () => {
    const path = seededDb();
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['telemetry', 'export', '--db', path])).toBe(0);
    } finally {
      spy.mockRestore();
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('telemetry export --scrub-prefix (design E, ADR-0031 decision 7)', () => {
  let tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
    vi.restoreAllMocks();
  });

  // A fake home prefix, never the machine's real one: the fixture must fail
  // loudly if the transform ever keys on ambient state instead of the argument.
  const HOME = '/Users/testhome';

  function homeDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-scrub-'));
    tmpDirs.push(dir);
    const path = join(dir, 'telemetry.db');
    const db = openTelemetryDatabase({ path });
    const store = createTelemetryStore(db);
    store.record({
      type: 'hook-event',
      sessionId: 's1',
      turnId: 't1',
      ts: 100,
      payload: {
        kind: 'denied-by-hook',
        event: 'pre-tool',
        tool: 'Write',
        reason: `denied writing ${HOME}/notes.md`,
        handlerIndex: 0,
      },
    });
    store.record({
      type: 'tool-trace',
      sessionId: 's2',
      turnId: 't2',
      ts: 200,
      payload: { tool: 'Read', phase: 'post-tool', resultSummary: `read ${HOME}/a and ${HOME}/b` },
    });
    store.record({
      type: 'hook-event',
      sessionId: 's3',
      turnId: 't3',
      ts: 300,
      payload: { kind: 'hook-fired', event: 'stop', handlersFired: 1 },
    });
    db.close();
    return path;
  }

  function captureStreams(): {
    stdout: () => string;
    stderr: () => string;
    restore: () => void;
  } {
    const out: string[] = [];
    const err: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    return {
      stdout: () => out.join(''),
      stderr: () => err.join(''),
      restore: () => {
        outSpy.mockRestore();
        errSpy.mockRestore();
      },
    };
  }

  it('parses a repeatable --scrub-prefix, stripping trailing separators', () => {
    const parsed = parseArgs([
      'telemetry',
      'export',
      '--scrub-prefix',
      '/Users/testhome/',
      '--scrub-prefix',
      '/home/al',
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.command === 'telemetry-export') {
      expect(parsed.value.scrubPrefixes).toEqual(['/Users/testhome', '/home/al']);
    }
  });

  it('rejects invalid --scrub-prefix values at parse time', () => {
    expect(parseArgs(['telemetry', 'export', '--scrub-prefix', 'relative/path']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'export', '--scrub-prefix', '/Users']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'export', '--scrub-prefix', '/']).ok).toBe(false);
    expect(parseArgs(['telemetry', 'export', '--scrub-prefix']).ok).toBe(false);
  });

  it('attaches the scrub signal to EVERY emitted row and replaces the prefix', async () => {
    const path = homeDb();
    const streams = captureStreams();
    try {
      expect(await main(['telemetry', 'export', '--db', path, '--scrub-prefix', HOME])).toBe(0);
    } finally {
      streams.restore();
    }
    const body = streams.stdout();
    expect(body).not.toContain(HOME);
    const rows = body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r['scrub'])).toEqual([
      { applied: true, count: 1, transform: 'prefix-v1' },
      { applied: true, count: 2, transform: 'prefix-v1' },
      { applied: false, count: 0, transform: 'prefix-v1' },
    ]);
    const denied = rows[0]?.['payload'] as { reason?: string };
    expect(denied.reason).toBe('denied writing [scrubbed-prefix-1]/notes.md');
  });

  it('scrubs the --out copy identically to stdout', async () => {
    const path = homeDb();
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-scrub-out-'));
    tmpDirs.push(dir);
    const out = join(dir, 'events.jsonl');
    expect(
      await main(['telemetry', 'export', '--db', path, '--scrub-prefix', HOME, '--out', out]),
    ).toBe(0);
    const streams = captureStreams();
    try {
      expect(await main(['telemetry', 'export', '--db', path, '--scrub-prefix', HOME])).toBe(0);
    } finally {
      streams.restore();
    }
    const fileBody = readFileSync(out, 'utf8');
    expect(fileBody).toBe(streams.stdout());
    expect(fileBody).not.toContain(HOME);
  });

  it('leaves the default export byte-shape untouched: no scrub key without the flag', async () => {
    const path = homeDb();
    const streams = captureStreams();
    try {
      expect(await main(['telemetry', 'export', '--db', path])).toBe(0);
    } finally {
      streams.restore();
    }
    const rows = streams
      .stdout()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect('scrub' in row).toBe(false);
    }
    // The cleartext home-shaped path is still there — the default is lossless.
    expect(streams.stdout()).toContain(HOME);
  });

  it('nudges once on stderr when an unscrubbed export carries home-shaped rows', async () => {
    const path = homeDb();
    const streams = captureStreams();
    try {
      expect(await main(['telemetry', 'export', '--db', path])).toBe(0);
    } finally {
      streams.restore();
    }
    const nudge = streams.stderr();
    expect(nudge).toContain('--scrub-prefix');
    // Exactly one line, echoing none of the row data.
    expect(nudge.trim().split('\n')).toHaveLength(1);
    expect(nudge).not.toContain(HOME);
  });

  it('does not nudge when the flag is given, nor when no row is home-shaped', async () => {
    const scrubbed = captureStreams();
    try {
      expect(
        await main(['telemetry', 'export', '--db', homeDb(), '--scrub-prefix', HOME]),
      ).toBe(0);
    } finally {
      scrubbed.restore();
    }
    expect(scrubbed.stderr()).toBe('');

    // seededDb-shaped content: no home-shaped strings anywhere.
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-noscrub-'));
    tmpDirs.push(dir);
    const path = join(dir, 'telemetry.db');
    const db = openTelemetryDatabase({ path });
    createTelemetryStore(db).record({
      type: 'hook-event',
      sessionId: 's1',
      turnId: 't1',
      ts: 100,
      payload: { kind: 'hook-fired', event: 'session-start', handlersFired: 0 },
    });
    db.close();
    const plain = captureStreams();
    try {
      expect(await main(['telemetry', 'export', '--db', path])).toBe(0);
    } finally {
      plain.restore();
    }
    expect(plain.stderr()).toBe('');
  });

  it('nudges for a Windows-shaped row at the CLI seam (dead at the serialised seam, review-executed)', async () => {
    // The first cut ran the detector over the JSON.stringify'd body, where
    // backslash-doubling made the \Users\ arm unmatchable — the unit pin was
    // green while the production seam never fired. This test binds the seam.
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-win-'));
    tmpDirs.push(dir);
    const path = join(dir, 'telemetry.db');
    const db = openTelemetryDatabase({ path });
    createTelemetryStore(db).record({
      type: 'hook-event',
      sessionId: 's1',
      turnId: 't1',
      ts: 100,
      payload: {
        kind: 'hook-error',
        event: 'stop',
        reason: 'failed reading C:\\Users\\alice\\secrets\\prod.env',
        handlerIndex: 0,
      },
    });
    db.close();
    const streams = captureStreams();
    try {
      expect(await main(['telemetry', 'export', '--db', path])).toBe(0);
    } finally {
      streams.restore();
    }
    expect(streams.stderr()).toContain('--scrub-prefix');
  });

  it('nudges on stderr when home-shaped paths SURVIVE a scrub (wrong prefix)', async () => {
    const path = homeDb();
    const streams = captureStreams();
    try {
      expect(
        await main(['telemetry', 'export', '--db', path, '--scrub-prefix', '/Users/wrongname']),
      ).toBe(0);
    } finally {
      streams.restore();
    }
    // Rows still emit (with applied:false) — the survivor nudge is the only
    // signal that the scrub the operator relied on did not bite.
    expect(streams.stdout()).toContain(HOME);
    const nudge = streams.stderr();
    expect(nudge).toContain('remain after --scrub-prefix');
    expect(nudge.trim().split('\n')).toHaveLength(1);
    expect(nudge).not.toContain(HOME);
  });

  it('surfaces a backslash-sibling near-miss through the survivor nudge (ninth-refutation seam)', async () => {
    // With backslash no longer a boundary after a POSIX prefix, the sibling
    // is NOT consumed — its home-shaped bytes remain, so the survivor nudge
    // fires where the previous cut was silently corrupting.
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-bslash-'));
    tmpDirs.push(dir);
    const path = join(dir, 'telemetry.db');
    const db = openTelemetryDatabase({ path });
    createTelemetryStore(db).record({
      type: 'hook-event',
      sessionId: 's1',
      turnId: 't1',
      ts: 100,
      payload: {
        kind: 'hook-error',
        event: 'stop',
        reason: `failed reading ${HOME}\\backup/prod.env`,
        handlerIndex: 0,
      },
    });
    db.close();
    const streams = captureStreams();
    try {
      expect(await main(['telemetry', 'export', '--db', path, '--scrub-prefix', HOME])).toBe(0);
    } finally {
      streams.restore();
    }
    expect(streams.stdout()).toContain(`${HOME}\\\\backup`);
    const rows = streams
      .stdout()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows[0]?.['scrub']).toEqual({ applied: false, count: 0, transform: 'prefix-v1' });
    expect(streams.stderr()).toContain('remain after --scrub-prefix');
  });

  it('refuses the whole scrubbed export on a hostile deep row, while the default export still works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-deep-'));
    tmpDirs.push(dir);
    const path = join(dir, 'telemetry.db');
    const db = openTelemetryDatabase({ path });
    let deep: unknown = `${HOME}/leaf`;
    for (let i = 0; i < 2000; i += 1) deep = [deep];
    // Extra keys pass the positive-conjunct RUNTIME validators
    // (review-executed), so this goes through the PUBLIC record() API — no
    // raw INSERT needed. Only the compile-time type objects, hence the cast.
    createTelemetryStore(db).record({
      type: 'hook-event',
      sessionId: 's1',
      turnId: 't1',
      ts: 100,
      payload: { kind: 'hook-fired', event: 'stop', handlersFired: 0, x: deep },
    } as Parameters<ReturnType<typeof createTelemetryStore>['record']>[0]);
    db.close();

    const scrubbed = captureStreams();
    try {
      expect(await main(['telemetry', 'export', '--db', path, '--scrub-prefix', HOME])).toBe(1);
    } finally {
      scrubbed.restore();
    }
    expect(scrubbed.stderr()).toContain('refused row 1 of 1');
    expect(scrubbed.stderr()).toContain('depth cap');
    expect(scrubbed.stdout()).toBe('');

    const plain = captureStreams();
    try {
      expect(await main(['telemetry', 'export', '--db', path])).toBe(0);
    } finally {
      plain.restore();
    }
    expect(plain.stdout()).toContain('"x"');
  });

  it('keeps the scrubbed export parseable: every line is valid JSON', async () => {
    const path = homeDb();
    const streams = captureStreams();
    try {
      expect(await main(['telemetry', 'export', '--db', path, '--scrub-prefix', HOME])).toBe(0);
    } finally {
      streams.restore();
    }
    const lines = streams.stdout().trim().split('\n');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe('main (pre-SDK paths)', () => {
  it('returns 2 on invalid arguments without touching the environment', async () => {
    expect(await main(['bogus'])).toBe(2);
  });

  it('sanitizes terminal escapes in a parse error before printing it', async () => {
    const esc = String.fromCharCode(0x1b);
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });
    try {
      // The offending arg is echoed verbatim into the parse error; an
      // attacker-named entry (e.g. via `init *` glob) must not inject escapes.
      expect(await main(['init', 'a', `evil${esc}[31m`])).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(written.join('')).not.toContain(esc);
  });

  it('returns 2 when ANTHROPIC_API_KEY is unset', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await main(['run', 'hello'])).toBe(2);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it('returns 2 for eval when ANTHROPIC_API_KEY is unset', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await main(['eval'])).toBe(2);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  // The symlinked-.harness refusal cannot be driven through main() here:
  // lstatSync('.harness') resolves relative to the OS-level cwd, and
  // process.chdir() throws ERR_WORKER_UNSUPPORTED_OPERATION under vitest's
  // threads pool. The branch is covered directly by the refuseSymlinkedDir
  // unit tests above; runEval calls it verbatim.
  it('returns 2 for eval when project settings are malformed (SettingsLoadError)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-cwd-'));
    mkdirSync(join(dir, '.harness'));
    writeFileSync(join(dir, '.harness', 'settings.json'), '{ not json');
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // composeSecurity derives the project layer from process.cwd() and reads
    // the resulting absolute path, so spying cwd() suffices — no chdir needed.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      expect(await main(['eval', './tasks'])).toBe(2);
    } finally {
      cwdSpy.mockRestore();
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('composeSecurity', () => {
  const settingsPath = (dir: string): string => join(dir, '.harness', 'settings.json');

  const filesystem = (files: Record<string, string>) => (path: string): string => {
    const body = files[path];
    if (body === undefined) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return body;
  };

  it('reads each settings file once and parses both keys from the same doc', () => {
    const readPaths: string[] = [];
    const files = filesystem({
      [settingsPath('/home/u')]: JSON.stringify({
        permissions: { rules: [{ tool: 'Bash', decision: 'deny' }] },
        sandbox: { paths: { allow: ['/safe'] } },
      }),
    });
    const result = composeSecurity({
      readFile: (p) => {
        readPaths.push(p);
        return files(p);
      },
      userDir: '/home/u',
      projectDir: '/proj',
    });
    expect(readPaths.filter((p) => p === settingsPath('/home/u'))).toHaveLength(1);
    expect(result.permissions.rules).toHaveLength(1);
    expect(result.sandbox.paths?.allow).toEqual(['/safe']);
    expect(result.warnings).toEqual([]);
  });

  it('malformed permissions OR sandbox keys throw a path-prefixed SettingsLoadError', () => {
    const badPermissions = filesystem({
      [settingsPath('/proj')]: JSON.stringify({ permissions: { rules: 'nope' } }),
    });
    expect(() =>
      composeSecurity({ readFile: badPermissions, userDir: '/home/u', projectDir: '/proj' }),
    ).toThrowError(SettingsLoadError);
    expect(() =>
      composeSecurity({ readFile: badPermissions, userDir: '/home/u', projectDir: '/proj' }),
    ).toThrow(new RegExp(settingsPath('/proj').replace(/[/.]/g, '\\$&')));

    const badSandbox = filesystem({
      [settingsPath('/home/u')]: JSON.stringify({ sandbox: { paths: 'nope' } }),
    });
    expect(() =>
      composeSecurity({ readFile: badSandbox, userDir: '/home/u', projectDir: '/proj' }),
    ).toThrow(/sandbox\.paths/);

    const badJson = filesystem({ [settingsPath('/home/u')]: '{oops' });
    expect(() =>
      composeSecurity({ readFile: badJson, userDir: '/home/u', projectDir: '/proj' }),
    ).toThrow(/not valid JSON/);
  });

  it('missing files everywhere → open posture, no warnings', () => {
    const result = composeSecurity({
      readFile: filesystem({}),
      userDir: '/home/u',
      projectDir: '/proj',
    });
    expect(result.permissions.rules).toEqual([]);
    expect(result.sandbox).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('warns on ask-without-prompter and shell-runner allowlist entries', () => {
    const result = composeSecurity({
      readFile: filesystem({
        [settingsPath('/proj')]: JSON.stringify({
          permissions: { rules: [{ tool: 'Bash', decision: 'ask' }] },
          sandbox: { commands: { allow: ['git', 'bash'] } },
        }),
      }),
      userDir: '/home/u',
      projectDir: '/proj',
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('ask');
    expect(result.warnings[1]).toContain('bash');
    expect(result.warnings[1]).toContain('always denied');
  });

  it('merges layers with S-3/S-4 semantics: sticky deny + sandbox intersection', () => {
    const result = composeSecurity({
      readFile: filesystem({
        [settingsPath('/home/u')]: JSON.stringify({
          permissions: { rules: [{ tool: 'Bash', decision: 'deny' }] },
          sandbox: { paths: { allow: ['/a', '/b'] } },
        }),
        [settingsPath('/proj')]: JSON.stringify({
          permissions: { rules: [{ tool: 'Bash', decision: 'allow' }] },
          sandbox: { paths: { allow: ['/b', '/c'] } },
        }),
      }),
      userDir: '/home/u',
      projectDir: '/proj',
    });
    expect(result.sandbox.paths?.allow).toEqual(['/b']);
    const rules = result.permissions.rules ?? [];
    expect(rules.map((r) => r.layer)).toEqual(['user', 'project']);
  });
});

describe('parseEvalArgs', () => {
  // Full coverage of --challenge / defaults / rejection lives in
  // src/cli/eval-command.test.ts (E-4 Task 9, redteam-command precedent);
  // this is kept here only as the pre-existing pin that parseArgs('eval', ...)
  // reaches this parser unchanged post-extraction.
  it('is reachable through parseArgs', () => {
    const result = parseArgs(['eval', './tasks']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.command).toBe('eval');
  });
});

describe('parseRedteamArgs', () => {
  // Full coverage of --update-baseline / --baseline / defaults lives in
  // src/cli/redteam-command.test.ts (E-3 Task 8); these two are kept here
  // only as the pre-existing pin that parseArgs('redteam', ...) reaches this
  // parser unchanged post-extraction.
  it('defaults out to the shared eval scorecard directory', () => {
    const result = parseRedteamArgs([]);
    expect(result).toEqual({
      ok: true,
      value: { command: 'redteam', out: join('.harness', 'eval'), updateBaseline: false, baselinePath: 'eval/redteam/baseline.json' },
    });
  });

  it('accepts --out <dir>', () => {
    const result = parseRedteamArgs(['--out', '/tmp/redteam-out']);
    expect(result).toEqual({
      ok: true,
      value: { command: 'redteam', out: '/tmp/redteam-out', updateBaseline: false, baselinePath: 'eval/redteam/baseline.json' },
    });
  });

  it('rejects --out with no value', () => {
    const result = parseRedteamArgs(['--out']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('--out');
  });

  it('rejects unknown flags and extra positionals', () => {
    expect(parseRedteamArgs(['--bogus']).ok).toBe(false);
    expect(parseRedteamArgs(['extra']).ok).toBe(false);
  });

  it('is reachable through parseArgs', () => {
    const result = parseArgs(['redteam']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.command).toBe('redteam');
  });
});

describe('main (redteam)', () => {
  // E-3 (Task 8) made `redteam` compare-by-default: a passing run now needs a
  // baseline that matches the live corpus, so these two write one to a tmp
  // path via `--baseline` rather than relying on the (not-yet-committed
  // until Task 9) repo-default `eval/redteam/baseline.json`.
  const writeMatchingBaseline = (): { dir: string; path: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'redteam-baseline-'));
    const path = join(dir, 'baseline.json');
    const canonical = toCanonicalJson(
      normalizeForBaseline(runRedteam(CORPUS, scan, { armLabel: REDTEAM_ARM_LABEL, harnessVersion: '0.0.0-test' })),
    );
    writeFileSync(path, canonical);
    return { dir, path };
  };

  it('does not require ANTHROPIC_API_KEY', async () => {
    const out = mkdtempSync(join(tmpdir(), 'redteam-out-'));
    const baseline = writeMatchingBaseline();
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['redteam', '--out', out, '--baseline', baseline.path]);
      expect(code).toBe(0);
      const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stdoutText).not.toContain('ANTHROPIC_API_KEY');
      expect(stderrText).not.toContain('ANTHROPIC_API_KEY');
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      rmSync(out, { recursive: true, force: true });
      rmSync(baseline.dir, { recursive: true, force: true });
    }
  });

  it('exits 0, prints a Gate: PASS markdown summary, and writes the scorecard on the real corpus', async () => {
    const out = mkdtempSync(join(tmpdir(), 'redteam-out-'));
    const baseline = writeMatchingBaseline();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['redteam', '--out', out, '--baseline', baseline.path]);
      expect(code).toBe(0);
      const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stdoutText).toContain('Gate: PASS');
      expect(stdoutText).toContain('GATE_FAILURE=none');
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const writtenPath = /scorecard written to (.+)$/m.exec(stderrText)?.[1]?.trim();
      expect(writtenPath).toBeDefined();
      if (writtenPath !== undefined) {
        expect(readFileSync(writtenPath, 'utf8')).toContain('"producer": "redteam"');
      }
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      rmSync(out, { recursive: true, force: true });
      rmSync(baseline.dir, { recursive: true, force: true });
    }
  });

  it('returns 2 on a write failure (a regular file sits where the out dir should be) — reuses writeScorecard\'s failure precedent', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'redteam-out-'));
    const out = join(parent, 'blocked');
    writeFileSync(out, 'a regular file where the dir should be');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = await main(['redteam', '--out', out]);
      expect(code).toBe(2);
    } finally {
      stderrSpy.mockRestore();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('scorecardFilename', () => {
  it('is filesystem-safe: no colons, second precision, Z-suffixed', () => {
    // 2026-07-09T03:12:45.678Z (epoch re-derived from the ISO string; the
    // brief's literal 1783307565678 actually decodes to 2026-07-06, not
    // 2026-07-09 — see task-9-report.md for the verification command).
    expect(scorecardFilename(1783566765678)).toBe('scorecard-2026-07-09T03-12-45Z.json');
  });
});

describe('writeScorecard', () => {
  const scorecard: GoldenScorecard = {
    schemaVersion: 1,
    producer: 'golden',
    meta: {
      createdAt: '2026-07-09T03:12:45.000Z',
      harnessVersion: '0.1.0-test',
      taskDir: 'tmp/tasks',
      taskDirForm: 'relative',
      models: [],
    },
    rows: [],
    totals: {
      total: 0,
      passed: 0,
      failed: 0,
      byFailureKind: {
        'task-parse': 0,
        'oracle-load': 0,
        'session-error': 0,
        'oracle-error': 0,
        'oracle-fail': 0,
      },
      passRate: 0,
      totalCostUsd: 0,
      unpricedTasks: 0,
    },
  };

  it('creates the dir and writes canonical JSON at the timestamped path', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'eval-write-')), 'eval');
    const result = writeScorecard(scorecard, out, 1783566765678);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(join(out, 'scorecard-2026-07-09T03-12-45Z.json'));
    expect(readFileSync(result.path, 'utf8')).toContain('"schemaVersion"');
  });

  it('maps a non-symlink obstacle (regular file at the out dir) to a message, never a throw', () => {
    // The exit-2 contract says "no scorecard produced ⇒ exit 2" for EVERY
    // write failure, not just symlink refusals (E-1 differential review, F-3).
    const out = join(mkdtempSync(join(tmpdir(), 'eval-write-')), 'eval');
    writeFileSync(out, 'a regular file where the dir should be');
    const result = writeScorecard(scorecard, out);
    expect(result.ok).toBe(false);
  });

  it('maps a symlinked out dir to a message (attacker-directed write)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-write-'));
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const result = writeScorecard(scorecard, join(dir, 'link'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/symlink/);
  });
});

describe('refuseSymlinkedDir', () => {
  it('passes a real directory and a missing path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-out-'));
    expect(() => refuseSymlinkedDir(dir)).not.toThrow();
    expect(() => refuseSymlinkedDir(join(dir, 'missing'))).not.toThrow();
  });

  it('refuses a symlinked directory (attacker-directed write)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-out-'));
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(() => refuseSymlinkedDir(join(dir, 'link'))).toThrow(EvalUsageError);
  });
});

describe('composeSecurity with the default reader: the hostile-file envelope (ADR-0034, issue #94)', () => {
  // No `readFile` injected: this is the reader production runs with. Every
  // case here is a real file on disk, because the fake-fs seam above cannot
  // exercise lstat, O_NOFOLLOW or a byte cap.
  const tmp: string[] = [];
  afterEach(() => {
    for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function layerDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'compose-envelope-'));
    tmp.push(dir);
    mkdirSync(join(dir, '.harness'));
    return dir;
  }
  const settingsPath = (dir: string): string => join(dir, '.harness', 'settings.json');
  function messageOf(fn: () => unknown): string {
    try {
      fn();
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
    return '';
  }

  it('composes two regular files', () => {
    const user = layerDir();
    const project = layerDir();
    writeFileSync(settingsPath(user), JSON.stringify({ permissions: { rules: [{ tool: 'Bash', decision: 'deny' }] } }));
    writeFileSync(settingsPath(project), JSON.stringify({ sandbox: { paths: { allow: ['/safe'] } } }));
    const result = composeSecurity({ userDir: user, projectDir: project });
    expect(result.permissions.rules).toHaveLength(1);
    expect(result.sandbox.paths?.allow).toEqual(['/safe']);
  });

  it('a missing file on either layer is still an empty layer', () => {
    const result = composeSecurity({ userDir: layerDir(), projectDir: layerDir() });
    expect(result.permissions.rules).toEqual([]);
    expect(result.sandbox).toEqual({});
  });

  it('refuses a symlinked project settings file, naming the path and the reason', () => {
    const user = layerDir();
    const project = layerDir();
    const real = join(project, 'real.json');
    writeFileSync(real, '{}');
    symlinkSync(real, settingsPath(project));
    expect(() => composeSecurity({ userDir: user, projectDir: project })).toThrowError(SettingsLoadError);
    const message = messageOf(() => composeSecurity({ userDir: user, projectDir: project }));
    expect(message).toContain(settingsPath(project));
    expect(message).toMatch(/symlink/);
  });

  it('refuses a symlinked .harness directory (a committed link redirects the whole layer)', () => {
    const user = layerDir();
    const project = mkdtempSync(join(tmpdir(), 'compose-envelope-'));
    tmp.push(project);
    const realDir = join(project, 'elsewhere');
    mkdirSync(realDir);
    writeFileSync(join(realDir, 'settings.json'), '{}');
    symlinkSync(realDir, join(project, '.harness'));
    expect(messageOf(() => composeSecurity({ userDir: user, projectDir: project }))).toMatch(/symlink/);
  });

  it('refuses a settings file over MAX_SETTINGS_BYTES before parsing it', () => {
    const user = layerDir();
    const project = layerDir();
    writeFileSync(settingsPath(project), '{"permissions":{"rules":[]}}' + ' '.repeat(MAX_SETTINGS_BYTES));
    const message = messageOf(() => composeSecurity({ userDir: user, projectDir: project }));
    expect(message).toMatch(/exceeds/);
    expect(message).toContain(settingsPath(project));
  });

  it('an invalid-JSON settings file names the path and leaks nothing from inside it', () => {
    const user = layerDir();
    const project = layerDir();
    writeFileSync(settingsPath(project), 'BODY_MARKER_9f3c{');
    const message = messageOf(() => composeSecurity({ userDir: user, projectDir: project }));
    expect(message).toContain(settingsPath(project));
    expect(message).not.toContain('BODY_MARKER');
  });

  it('an unknown key fails loud, path-prefixed, naming the key (issue #85)', () => {
    const user = layerDir();
    const project = layerDir();
    writeFileSync(settingsPath(project), JSON.stringify({ sandbox: { path: { allow: ['/safe'] } } }));
    expect(() => composeSecurity({ userDir: user, projectDir: project })).toThrowError(SettingsLoadError);
    const message = messageOf(() => composeSecurity({ userDir: user, projectDir: project }));
    expect(message).toContain(settingsPath(project));
    expect(message).toMatch(/unknown key 'path'/);
  });
});

describe('main() runs the guarded settings reader (the wiring pin, ADR-0034 decision 5)', () => {
  // Both production callers (run, eval) omit `readFile`, so this is the reader
  // they actually run with. The PROJECT layer is the attacker-influenced one
  // and is derived from process.cwd(), which a spy can redirect (chdir throws
  // under vitest's threads pool, and process.env.HOME never reaches libuv's
  // getenv there, so the user layer cannot be redirected from a test). Both
  // commands compose security after the API-key check and BEFORE the SDK
  // import, so a refused file exits 2 with no SDK involved; if the guard ever
  // regresses, the run reaches the SDK with the dummy key and fails there,
  // loudly, without spend.
  const tmp: string[] = [];
  const saved = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  function hostileProject(): { dir: string; settings: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cli-hostile-project-'));
    tmp.push(dir);
    mkdirSync(join(dir, '.harness'));
    const real = join(dir, 'real.json');
    writeFileSync(real, '{}');
    const settings = join(dir, '.harness', 'settings.json');
    symlinkSync(real, settings);
    return { dir, settings };
  }

  async function stderrOf(argv: string[], cwd: string): Promise<{ code: number; stderr: string }> {
    process.env.ANTHROPIC_API_KEY = 'dummy';
    const written: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      return { code: await main(argv), stderr: written.join('') };
    } finally {
      cwdSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  it('run exits 2 on a symlinked project .harness/settings.json and says so on stderr', async () => {
    const { dir, settings } = hostileProject();
    const { code, stderr } = await stderrOf(['run', 'hello'], dir);
    expect(code).toBe(2);
    expect(stderr).toMatch(/symlink/);
    expect(stderr).toContain(settings);
  });

  it('eval exits 2 on the same file (the second production caller)', async () => {
    const { dir, settings } = hostileProject();
    const { code, stderr } = await stderrOf(['eval', './tasks'], dir);
    expect(code).toBe(2);
    expect(stderr).toMatch(/symlink/);
    expect(stderr).toContain(settings);
  });
});
