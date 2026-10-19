import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, parseArgs } from '../cli.js';
import { formatUsd } from '../internal/money.js';
import { PRICE_MAX_AGE_DAYS, PRICE_TABLE } from '../internal/pricing.js';
import { createTelemetryStore, openTelemetryDatabase } from '../telemetry/index.js';
import { USAGE } from './shared.js';
import {
  localDayStartMs,
  parseTelemetryCostArgs,
  runTelemetryCost,
  type TelemetryCostArgs,
} from './telemetry-cost-command.js';

// Records the options of every Database opened, so a test can pin that the
// report opens read-only (a writable open of an existing file writes nothing
// observable, and SQLite silently falls back to read-only on a 0444 file, so
// no black-box check can tell the two apart).
const opens = vi.hoisted(() => [] as { path: unknown; options: unknown }[]);
vi.mock('better-sqlite3', async (importOriginal) => {
  const mod = await importOriginal<{ default: new (...a: never[]) => object }>();
  const Real = mod.default;
  class Recording extends (Real as unknown as new (...a: unknown[]) => object) {
    constructor(path?: unknown, options?: unknown) {
      super(path, options);
      opens.push({ path, options });
    }
  }
  return { default: Recording };
});

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcost-'));
  dirs.push(dir);
  return dir;
}

/** Local-time noon on 2026-10-<day>, so day grouping is timezone-independent. */
const at = (day: number): number => new Date(2026, 9, day, 12).getTime();

interface Fixture {
  kind: 'agent' | 'judge';
  session: string;
  day: number;
  model: string;
  /** Dyadic values so any summation order is exact. */
  cost: number | null;
}

const FIXTURE: Fixture[] = [
  { kind: 'agent', session: 's-a', day: 1, model: 'model-x', cost: 0.5 },
  { kind: 'agent', session: 's-a', day: 2, model: 'model-x', cost: 0.25 },
  { kind: 'agent', session: 's-b', day: 2, model: 'model-y', cost: 0.125 },
  { kind: 'agent', session: 's-b', day: 3, model: 'model-y', cost: null },
  { kind: 'agent', session: 's-c', day: 3, model: 'model-x', cost: 1 },
  { kind: 'judge', session: 's-a', day: 2, model: '', cost: 0.0625 },
  { kind: 'judge', session: 's-b', day: 3, model: '', cost: null },
  { kind: 'judge', session: 's-c', day: 3, model: '', cost: 0.03125 },
];

function seed(dbPath: string, rows: Fixture[]): void {
  const db = openTelemetryDatabase({ path: dbPath });
  try {
    const store = createTelemetryStore(db);
    rows.forEach((r, i) => {
      const base = { sessionId: r.session, turnId: `t${i}`, ts: at(r.day) };
      if (r.kind === 'agent') {
        store.record({
          ...base,
          type: 'turn-cost',
          payload: {
            model: r.model,
            ruleId: 'rule',
            costUsd: r.cost,
            numTurns: 1,
            usage: null,
            sdkSessionId: null,
            resultSubtype: 'success',
          },
        });
      } else {
        store.record({
          ...base,
          type: 'judge-call',
          payload: {
            tool: 'Read',
            tool_use_id: null,
            phase: 'post-tool',
            state: 'judged',
            heuristic: 'pass',
            judge: 'pass',
            composed: 'pass',
            errorKind: null,
            redacted: false,
            costUsd: r.cost,
            durationMs: 1,
          },
        });
      }
    });
  } finally {
    db.close();
  }
}

function fixtureDb(rows: Fixture[] = FIXTURE): string {
  const path = join(tempDir(), 'telemetry.db');
  seed(path, rows);
  return path;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

function run(over: Partial<TelemetryCostArgs> & { dbPath: string }, now?: () => number): Run {
  const out: string[] = [];
  const err: string[] = [];
  const code = runTelemetryCost(
    { command: 'telemetry-cost', since: '2026-10-01', by: 'model', estimate: false, ...over },
    { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
    now === undefined ? {} : { now },
  );
  return { code, out: out.join(''), err: err.join('') };
}

interface Expected {
  sum: number;
  rows: number;
  unknown: number;
}

/** Re-derives per-key totals from the fixture rows; nothing is hand-copied. */
function derive(rows: Fixture[], kind: Fixture['kind'], by: 'model' | 'session' | 'day', sinceDay: number) {
  const map = new Map<string, Expected>();
  for (const r of rows.filter((x) => x.kind === kind && x.day >= sinceDay)) {
    const key = by === 'session' ? r.session : by === 'day' ? `2026-10-${String(r.day).padStart(2, '0')}` : kind === 'judge' ? '(not recorded)' : r.model;
    const e = map.get(key) ?? { sum: 0, rows: 0, unknown: 0 };
    e.rows += 1;
    if (r.cost === null) e.unknown += 1;
    else e.sum += r.cost;
    map.set(key, e);
  }
  return map;
}

/** Table rows from the named section: cells split on 2+ spaces, header dropped. */
function sectionRows(out: string, titlePrefix: string): string[][] {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.startsWith(titlePrefix));
  expect(start).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (let i = start + 2; i < lines.length && lines[i]?.startsWith('  '); i += 1) {
    rows.push((lines[i] as string).trim().split(/\s{2,}/));
  }
  return rows;
}

const label = (n: number): string => `${n} ${n === 1 ? 'row' : 'rows'}`;

describe('parseTelemetryCostArgs', () => {
  it('defaults: model grouping, today (null since), default db', () => {
    const parsed = parseTelemetryCostArgs([]);
    expect(parsed).toEqual({
      ok: true,
      value: expect.objectContaining({ command: 'telemetry-cost', since: null, by: 'model' }),
    });
  });

  it('takes all three flags and is reached through parseArgs', () => {
    expect(parseArgs(['telemetry', 'cost', '--db', 'x.db', '--since', '2026-10-05', '--by', 'day'])).toEqual({
      ok: true,
      value: { command: 'telemetry-cost', dbPath: 'x.db', since: '2026-10-05', by: 'day', estimate: false },
    });
  });

  it.each([
    [['--by', 'tool']],
    [['--by']],
    [['--since']],
    [['--db']],
    [['--bogus']],
    [['positional']],
    [['--since', 'yesterday']],
    [['--since', '2026-1-5']],
    [['--since', '2026-02-30']],
    [['--since', '2026-13-01']],
    [['--since', '2026-10-05T00:00']],
    [['--since', '']],
    [['--since', '+2026-10-05']],
  ])('rejects %j with USAGE', (argv) => {
    const parsed = parseTelemetryCostArgs(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(USAGE);
  });

  it('USAGE names the new subcommand', () => {
    expect(USAGE).toContain('telemetry cost');
  });

  it('still rejects an unknown telemetry subcommand', () => {
    expect(parseArgs(['telemetry', 'bogus']).ok).toBe(false);
  });

  it('localDayStartMs accepts leap days only in leap years', () => {
    expect(localDayStartMs('2028-02-29')).not.toBeNull();
    expect(localDayStartMs('2026-02-29')).toBeNull();
  });
});

describe('runTelemetryCost', () => {
  it('a missing database is exit 2 and is not created', () => {
    const dir = tempDir();
    const missing = join(dir, 'nope', 'telemetry.db');
    const result = run({ dbPath: missing });
    expect(result.code).toBe(2);
    expect(result.err).toContain('no telemetry database');
    expect(result.out).toBe('');
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(dir, 'nope'))).toBe(false);
  });

  it('a --db that is a directory is exit 2 with a usage-style message, not a read error', () => {
    const result = run({ dbPath: tempDir() });
    expect(result.code).toBe(2);
    expect(result.err).toContain('not a regular file');
  });

  it('--since is inclusive at local 00:00:00.000 and excludes 23:59:59.999 the day before', () => {
    const path = fixtureDb([]);
    const db = new Database(path);
    const insert = db.prepare(
      "INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload) VALUES (@id, 'turn-cost', @sid, 't', @ts, @payload);",
    );
    const payload = JSON.stringify({ model: 'm', costUsd: 0.5 });
    insert.run({ id: 'edge-in', sid: 'in', ts: new Date(2026, 9, 5, 0, 0, 0, 0).getTime(), payload });
    insert.run({ id: 'edge-out', sid: 'out', ts: new Date(2026, 9, 4, 23, 59, 59, 999).getTime(), payload });
    db.close();
    const result = run({ dbPath: path, since: '2026-10-05', by: 'session' });
    expect(sectionRows(result.out, 'agent spend').map((c) => c[0])).toEqual(['"in"']);
  });

  it('refuses to sanitise-leak control bytes in the missing-path diagnostic', () => {
    const result = run({ dbPath: join(tempDir(), 'a\u001bb.db') });
    expect(result.code).toBe(2);
    expect(result.err).not.toContain('\u001b');
  });

  it('a SQLite file with no telemetry table is exit 2 and is not migrated', () => {
    const path = join(tempDir(), 'other.db');
    const other = new Database(path);
    other.exec('CREATE TABLE unrelated (x INTEGER);');
    other.close();
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    const result = run({ dbPath: path });
    expect(result.code).toBe(2);
    expect(result.err).toContain('telemetry_events');
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before);
  });

  it('never writes: db bytes are unchanged and only WAL sidecars may appear', () => {
    const path = fixtureDb();
    // Settle the WAL so the main file is the whole state before hashing.
    const db = new Database(path);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const dir = join(path, '..');
    const listing = readdirSync(dir).sort();
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    expect(run({ dbPath: path }).code).toBe(0);
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(before);
    // SQLite itself creates the -wal/-shm sidecars when ANY connection (even
    // read-only) opens a WAL-mode file; nothing else may appear.
    const extra = readdirSync(dir).filter((f) => !listing.includes(f));
    expect(extra.filter((f) => !f.endsWith('-wal') && !f.endsWith('-shm'))).toEqual([]);
  });

  it('opens the database read-only and must-exist', () => {
    const path = fixtureDb();
    opens.length = 0;
    expect(run({ dbPath: path }).code).toBe(0);
    expect(opens).toEqual([{ path, options: { readonly: true, fileMustExist: true } }]);
  });

  it.each(['model', 'session', 'day'] as const)('agent and judge totals by %s re-derive from the fixture', (by) => {
    const result = run({ dbPath: fixtureDb(), by });
    expect(result.code).toBe(0);
    for (const [kind, prefix] of [
      ['agent', 'agent spend'],
      ['judge', 'judge spend'],
    ] as const) {
      const expected = derive(FIXTURE, kind, by, 1);
      const actual = sectionRows(result.out, prefix);
      expect(actual).toHaveLength(expected.size);
      for (const cells of actual) {
        const key = by === 'day' ? (cells[0] as string) : (JSON.parse(cells[0] as string) as string);
        const e = expected.get(key);
        expect(e, `unexpected key ${key}`).toBeDefined();
        const known = (e as Expected).rows - (e as Expected).unknown;
        expect(cells[1]).toBe(String(e?.rows));
        expect(cells[2]).toBe(known === 0 ? 'n/a' : formatUsd((e as Expected).sum));
        expect(cells[3]).toBe((e as Expected).unknown === 0 ? '-' : `unknown (${label((e as Expected).unknown)})`);
      }
    }
  });

  it('the TOTAL line is agent + judge re-derived, with unknowns counted not summed', () => {
    const result = run({ dbPath: fixtureDb() });
    const known = (kind: Fixture['kind']): number =>
      FIXTURE.filter((r) => r.kind === kind).reduce((s, r) => s + (r.cost ?? 0), 0);
    const unknown = (kind: Fixture['kind']): number =>
      FIXTURE.filter((r) => r.kind === kind && r.cost === null).length;
    const total = result.out.split('\n').filter((l) => l.startsWith('TOTAL'));
    expect(total).toEqual([
      `TOTAL ${formatUsd(known('agent') + known('judge'))} (agent ${formatUsd(known('agent'))}, judge ${formatUsd(known('judge'))})` +
        `; unknown cost, not included: ${label(unknown('agent') + unknown('judge'))} (agent ${unknown('agent')}, judge ${unknown('judge')})`,
    ]);
    // The fixture really has an unknown on each side, or the above proves nothing.
    expect(unknown('agent')).toBeGreaterThan(0);
    expect(unknown('judge')).toBeGreaterThan(0);
  });

  it('judge spend is not folded into agent spend', () => {
    const agentOnly = FIXTURE.filter((r) => r.kind === 'agent');
    const withJudge = run({ dbPath: fixtureDb() });
    const without = run({ dbPath: fixtureDb(agentOnly) });
    expect(sectionRows(withJudge.out, 'agent spend')).toEqual(sectionRows(without.out, 'agent spend'));
    expect(without.out).toContain('(no rows)');
  });

  it('--since excludes earlier rows, inclusive of the named local day', () => {
    const result = run({ dbPath: fixtureDb(), since: '2026-10-03', by: 'session' });
    const expected = derive(FIXTURE, 'agent', 'session', 3);
    const keys = sectionRows(result.out, 'agent spend').map((c) => JSON.parse(c[0] as string) as string);
    expect(keys.sort()).toEqual([...expected.keys()].sort());
    expect(keys).not.toContain('s-a');
    expect(result.out).toContain('since 2026-10-03 (local time)');
  });

  it('a group whose every row is null cost shows n/a, never $0.0000', () => {
    const rows: Fixture[] = [{ kind: 'agent', session: 's', day: 2, model: 'm', cost: null }];
    const result = run({ dbPath: fixtureDb(rows) });
    expect(sectionRows(result.out, 'agent spend')).toEqual([['"m"', '1', 'n/a', 'unknown (1 row)']]);
  });

  it('an unreadable payload is unknown, not zero and not a crash', () => {
    const path = fixtureDb([]);
    const db = new Database(path);
    const insert = db.prepare(
      "INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload) VALUES (@id, 'turn-cost', 's', 't', @ts, @payload);",
    );
    insert.run({ id: 'bad-json', ts: at(2), payload: 'not json' });
    insert.run({ id: 'string-cost', ts: at(2), payload: JSON.stringify({ model: 'm', costUsd: '9' }) });
    insert.run({ id: 'negative', ts: at(2), payload: JSON.stringify({ model: 'm', costUsd: -1 }) });
    db.close();
    const result = run({ dbPath: path });
    expect(result.code).toBe(0);
    expect(result.out).toContain('TOTAL $0.0000');
    expect(result.out).toContain('unknown cost, not included: 3 rows (agent 3, judge 0)');
  });

  it('a hostile session id cannot forge a row or a line', () => {
    const path = fixtureDb([]);
    const db = new Database(path);
    db.prepare(
      "INSERT INTO telemetry_events (id, type, session_id, turn_id, ts, payload) VALUES ('x', 'turn-cost', @sid, 't', @ts, @payload);",
    ).run({ sid: 'evil\nTOTAL $0.0000 forged\u202e', ts: at(2), payload: JSON.stringify({ model: 'm', costUsd: 0.5 }) });
    db.close();
    const result = run({ dbPath: path, by: 'session' });
    expect(result.out.split('\n').filter((l) => l.startsWith('TOTAL'))).toHaveLength(1);
    expect(result.out).not.toContain('\u202e');
  });

  it('defaults --since to today in local time via the clock seam', () => {
    const path = fixtureDb();
    const result = run({ dbPath: path, since: null }, () => at(3));
    expect(result.out).toContain('since 2026-10-03 (local time)');
    const expected = derive(FIXTURE, 'agent', 'model', 3);
    expect(sectionRows(result.out, 'agent spend')).toHaveLength(expected.size);
  });
});

interface EstFixture {
  session: string;
  day: number;
  model: string;
  cost: number | null;
  /** 'absent' writes a pre-#192 payload with no estimateUsd key at all. */
  estimate: number | null | 'absent';
  /** Non-null writes refusalFallbackModel: priced on a different model, so unpaired. */
  fallback?: string;
}

/** Dyadic values so any summation order is exact. */
const EST_FIXTURE: EstFixture[] = [
  { session: 's-a', day: 1, model: 'model-x', cost: 0.5, estimate: 0.25 },
  { session: 's-a', day: 2, model: 'model-x', cost: 0.25, estimate: 0.125 },
  { session: 's-b', day: 2, model: 'model-y', cost: 0.125, estimate: null },
  { session: 's-b', day: 3, model: 'model-y', cost: null, estimate: 0.5 },
  { session: 's-c', day: 3, model: 'model-x', cost: 1, estimate: 'absent' },
];

function estDb(rows: EstFixture[] = EST_FIXTURE): string {
  const path = join(tempDir(), 'telemetry.db');
  const db = openTelemetryDatabase({ path });
  try {
    const store = createTelemetryStore(db);
    rows.forEach((r, i) => {
      const payload = {
        model: r.model,
        ruleId: 'rule',
        costUsd: r.cost,
        numTurns: 1,
        usage: null,
        sdkSessionId: null,
        resultSubtype: 'success',
        ...(r.estimate === 'absent' ? {} : { estimateUsd: r.estimate }),
        ...(r.fallback === undefined ? {} : { refusalFallbackModel: r.fallback }),
      };
      store.record({ type: 'turn-cost', sessionId: r.session, turnId: `t${i}`, ts: at(r.day), payload });
    });
  } finally {
    db.close();
  }
  return path;
}

const EST_TITLE = 'estimate vs actual';

describe('telemetry cost --estimate (#192)', () => {
  it('parses --estimate as a value-less flag, default off', () => {
    expect(parseTelemetryCostArgs(['--estimate'])).toEqual({
      ok: true,
      value: expect.objectContaining({ estimate: true }),
    });
    expect(parseTelemetryCostArgs([])).toEqual({ ok: true, value: expect.objectContaining({ estimate: false }) });
    expect(parseTelemetryCostArgs(['--estimate', '--by', 'day'])).toEqual({
      ok: true,
      value: expect.objectContaining({ estimate: true, by: 'day' }),
    });
    expect(USAGE).toContain('--estimate');
  });

  it('adds nothing to the default report', () => {
    const path = estDb();
    expect(run({ dbPath: path }).out).not.toContain(EST_TITLE);
    const base = run({ dbPath: path }).out;
    const withFlag = run({ dbPath: path, estimate: true }).out;
    expect(withFlag.startsWith(base.split('\nTOTAL')[0] as string)).toBe(true);
  });

  it('pairs only rows where estimate and actual are both known; sums and ratio re-derived', () => {
    const result = run({ dbPath: estDb(), estimate: true });
    expect(result.code).toBe(0);
    const rows = sectionRows(result.out, EST_TITLE);
    const paired = EST_FIXTURE.filter(
      (r): r is EstFixture & { cost: number; estimate: number } =>
        r.cost !== null && typeof r.estimate === 'number',
    );
    const keys = [...new Set(EST_FIXTURE.map((r) => r.model))].sort();
    expect(rows.map((c) => c[0])).toEqual(keys.map((k) => JSON.stringify(k)));
    for (const key of keys) {
      const mine = paired.filter((r) => r.model === key);
      const unpaired = EST_FIXTURE.filter((r) => r.model === key).length - mine.length;
      const est = mine.reduce((a, r) => a + r.estimate, 0);
      const act = mine.reduce((a, r) => a + r.cost, 0);
      const cells = rows.find((c) => c[0] === JSON.stringify(key)) as string[];
      expect(cells[1]).toBe(String(mine.length));
      expect(cells[2]).toBe(mine.length === 0 ? 'n/a' : formatUsd(est));
      expect(cells[3]).toBe(mine.length === 0 ? 'n/a' : formatUsd(act));
      expect(cells[4]).toBe(mine.length === 0 || est === 0 ? 'n/a' : `${(act / est).toFixed(2)}x`);
      expect(cells[5]).toBe(unpaired === 0 ? '-' : `unpaired (${label(unpaired)})`);
    }
  });

  it('a null or absent estimate is unpaired, never a zero estimate', () => {
    const rows = sectionRows(run({ dbPath: estDb(), estimate: true }).out, EST_TITLE);
    const y = rows.find((c) => c[0] === '"model-y"') as string[];
    expect(y[1]).toBe('0');
    expect(y[2]).toBe('n/a');
    expect(y[5]).toBe('unpaired (2 rows)');
    const x = rows.find((c) => c[0] === '"model-x"') as string[];
    expect(x[5]).toBe('unpaired (1 row)');
  });

  it('leaves a row unpaired when it was answered by a fallback model', () => {
    const path = estDb([
      { session: 's-a', day: 1, model: 'model-x', cost: 0.5, estimate: 0.25 },
      { session: 's-a', day: 2, model: 'model-x', cost: 0.5, estimate: 0.25, fallback: 'other-model' },
    ]);
    const x = sectionRows(run({ dbPath: path, estimate: true }).out, EST_TITLE)[0] as string[];
    expect(x[1]).toBe('1');
    expect(x[5]).toBe('unpaired (1 row)');
  });

  it('suppresses the stale note when no row was paired', () => {
    const path = estDb([{ session: 's-a', day: 1, model: 'model-x', cost: 0.5, estimate: null }]);
    const checked = Date.parse(`${(PRICE_TABLE[0] as { checked: string }).checked}T00:00:00Z`);
    const out = run({ dbPath: path, estimate: true }, () => checked + (PRICE_MAX_AGE_DAYS + 1) * 86_400_000).out;
    expect(out).toContain(EST_TITLE);
    expect(out).not.toContain('price table is older');
  });

  it('notes a stale price table through the clock seam, and stays quiet when fresh', () => {
    const path = estDb();
    const checked = Date.parse(`${(PRICE_TABLE[0] as { checked: string }).checked}T00:00:00Z`);
    const fresh = run({ dbPath: path, estimate: true }, () => checked);
    expect(fresh.out).not.toContain('price table is older');
    const stale = run({ dbPath: path, estimate: true }, () => checked + (PRICE_MAX_AGE_DAYS + 1) * 86_400_000);
    expect(stale.out).toMatch(new RegExp(`note: price table is older than ${PRICE_MAX_AGE_DAYS} days`));
  });
});

describe('main dispatch', () => {
  it('prints the report to stdout and exits 0', async () => {
    const path = fixtureDb();
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      chunks.push(String(c));
      return true;
    });
    const code = await main(['telemetry', 'cost', '--db', path, '--since', '2026-10-01']);
    expect(code).toBe(0);
    expect(chunks.join('')).toContain('TOTAL ');
  });

  it('a missing db is exit 2 through main', async () => {
    const errs: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      errs.push(String(c));
      return true;
    });
    const code = await main(['telemetry', 'cost', '--db', join(tempDir(), 'none.db'), '--since', '2026-10-01']);
    expect(code).toBe(2);
    expect(errs.join('')).toContain('no telemetry database');
  });
});
