import { statSync } from 'node:fs';

import Database from 'better-sqlite3';

import { formatUsd } from '../internal/money.js';
import { stalePriceRows, PRICE_MAX_AGE_DAYS } from '../internal/pricing.js';
import { DEFAULT_DB_PATH } from '../memory/index.js';
import { sanitizeDiagnostic, USAGE } from './shared.js';

/** Grouping axis for `telemetry cost`. */
export const COST_GROUPINGS = ['model', 'session', 'day'] as const;
export type CostGrouping = (typeof COST_GROUPINGS)[number];

export interface TelemetryCostArgs {
  command: 'telemetry-cost';
  dbPath: string;
  /** Validated `YYYY-MM-DD` (local calendar date), or null for "today, local time". */
  since: string | null;
  by: CostGrouping;
  /** `--estimate`: add the estimate-vs-actual section (#192). */
  estimate: boolean;
}

export type TelemetryCostParseResult =
  | { ok: true; value: TelemetryCostArgs }
  | { ok: false; error: string };

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local-midnight epoch ms for a strictly valid `YYYY-MM-DD`, or null for anything else (including 2026-02-30). */
export function localDayStartMs(date: string): number | null {
  const match = DATE_SHAPE.exec(date);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const start = new Date(year, month - 1, day);
  // Date silently rolls 30 Feb to 2 Mar; a round-trip check refuses it.
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    return null;
  }
  return start.getTime();
}

function localDateString(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

export function parseTelemetryCostArgs(argv: string[]): TelemetryCostParseResult {
  let dbPath = DEFAULT_DB_PATH;
  let since: string | null = null;
  let by: CostGrouping = 'model';
  let estimate = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === '--estimate') {
      estimate = true;
      continue;
    }
    if (arg !== '--db' && arg !== '--since' && arg !== '--by') {
      return { ok: false, error: `Unexpected argument '${arg}'. ${USAGE}` };
    }
    const value = argv[i + 1];
    if (value === undefined) return { ok: false, error: `Missing value for ${arg}. ${USAGE}` };
    if (arg === '--db') dbPath = value;
    if (arg === '--since') {
      if (localDayStartMs(value) === null) {
        return { ok: false, error: `--since must be a real calendar date as YYYY-MM-DD. ${USAGE}` };
      }
      since = value;
    }
    if (arg === '--by') {
      if (!(COST_GROUPINGS as readonly string[]).includes(value)) {
        return { ok: false, error: `--by must be one of ${COST_GROUPINGS.join('|')}. ${USAGE}` };
      }
      by = value as CostGrouping;
    }
    i += 1;
  }
  return { ok: true, value: { command: 'telemetry-cost', dbPath, since, by, estimate } };
}

export interface TelemetryCostStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface TelemetryCostOptions {
  /** Clock seam for the default `--since`; tests always pass `--since` instead. */
  now?: () => number;
}

interface Bucket {
  /** Rows whose cost was a usable number. */
  known: number;
  sum: number;
  /** Null cost or an unreadable payload: counted, NEVER added to `sum` as zero. */
  unknown: number;
}

interface RawRow {
  session_id: string;
  ts: number;
  type: 'turn-cost' | 'judge-call';
  payload: string;
}

type Spend = 'agent' | 'judge';

const NO_MODEL = '(not recorded)';

/** A usable cost is a finite number >= 0; anything else (null, wrong type, bad JSON) is unknown. */
function readCost(payload: string): { cost: number | null; model: string | null; estimate: number | null } {
  // A fallback-answered row was billed on a different model than the one the
  // estimate priced, so its estimate is dropped (the row reads as unpaired).
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return { cost: null, model: null, estimate: null };
    const record = parsed as Record<string, unknown>;
    const c = record.costUsd;
    const cost = typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : null;
    const model = typeof record.model === 'string' ? record.model : null;
    const e = record.estimateUsd;
    const fellBack = typeof record.refusalFallbackModel === 'string';
    const estimate = !fellBack && typeof e === 'number' && Number.isFinite(e) && e >= 0 ? e : null;
    return { cost, model, estimate };
  } catch {
    return { cost: null, model: null, estimate: null };
  }
}

function groupKey(row: RawRow, spend: Spend, model: string | null, by: CostGrouping): string {
  if (by === 'session') return row.session_id;
  if (by === 'day') return localDateString(row.ts);
  // judge-call rows carry no model, so they cannot be attributed by model.
  return spend === 'agent' ? (model ?? NO_MODEL) : NO_MODEL;
}

function rowsLabel(n: number): string {
  return `${n} ${n === 1 ? 'row' : 'rows'}`;
}

function quote(value: string): string {
  return JSON.stringify(sanitizeDiagnostic(value));
}

function sumOf(buckets: Map<string, Bucket>): Bucket {
  const total: Bucket = { known: 0, sum: 0, unknown: 0 };
  for (const b of buckets.values()) {
    total.known += b.known;
    total.sum += b.sum;
    total.unknown += b.unknown;
  }
  return total;
}

function costCell(b: Bucket): string {
  return b.known === 0 ? 'n/a' : formatUsd(b.sum);
}

function unknownCell(b: Bucket): string {
  return b.unknown === 0 ? '-' : `unknown (${rowsLabel(b.unknown)})`;
}

function section(title: string, by: CostGrouping, buckets: Map<string, Bucket>): string[] {
  const keys = [...buckets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = [title];
  if (keys.length === 0) return [...lines, '  (no rows)'];
  const shown = keys.map((key) => (by === 'day' ? key : quote(key)));
  const keyWidth = Math.max(by.length, ...shown.map((s) => s.length));
  const cells = keys.map((key) => {
    const b = buckets.get(key) as Bucket;
    return [String(b.known + b.unknown), costCell(b), unknownCell(b)];
  });
  const rowsWidth = Math.max(4, ...cells.map((c) => (c[0] as string).length));
  const costWidth = Math.max(4, ...cells.map((c) => (c[1] as string).length));
  lines.push(`  ${by.toUpperCase().padEnd(keyWidth)}  ${'ROWS'.padStart(rowsWidth)}  ${'COST'.padStart(costWidth)}  UNKNOWN`);
  keys.forEach((_, i) => {
    const [rows, cost, unknown] = cells[i] as string[];
    lines.push(
      `  ${(shown[i] as string).padEnd(keyWidth)}  ${(rows as string).padStart(rowsWidth)}  ${(cost as string).padStart(costWidth)}  ${unknown as string}`,
    );
  });
  return lines;
}

/** Per-key tally of agent rows whose estimate AND actual are both known. */
interface PairBucket {
  paired: number;
  estimate: number;
  actual: number;
  /** Null/absent estimate or null actual: counted, never summed as zero. */
  unpaired: number;
}

function estimateSection(by: CostGrouping, since: string, buckets: Map<string, PairBucket>): string[] {
  const lines = [`estimate vs actual (turn-cost rows with both known) by ${by}, since ${since} (local time)`];
  const keys = [...buckets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length === 0) return [...lines, '  (no rows)'];
  const shown = keys.map((key) => (by === 'day' ? key : quote(key)));
  const keyWidth = Math.max(by.length, ...shown.map((s) => s.length));
  const cells = keys.map((key) => {
    const b = buckets.get(key) as PairBucket;
    const none = b.paired === 0;
    return [
      String(b.paired),
      none ? 'n/a' : formatUsd(b.estimate),
      none ? 'n/a' : formatUsd(b.actual),
      none || b.estimate === 0 ? 'n/a' : `${(b.actual / b.estimate).toFixed(2)}x`,
      b.unpaired === 0 ? '-' : `unpaired (${rowsLabel(b.unpaired)})`,
    ];
  });
  const widths = [0, 1, 2, 3].map((c) => Math.max(...cells.map((row) => (row[c] as string).length), 4));
  const head = ['PAIRED', 'ESTIMATE', 'ACTUAL', 'ACTUAL/EST'];
  const pad = (c: number): number => Math.max(widths[c] as number, (head[c] as string).length);
  lines.push(
    `  ${by.toUpperCase().padEnd(keyWidth)}  ${head.map((h, c) => h.padStart(pad(c))).join('  ')}  UNPAIRED`,
  );
  keys.forEach((_, i) => {
    const row = cells[i] as string[];
    lines.push(
      `  ${(shown[i] as string).padEnd(keyWidth)}  ${[0, 1, 2, 3].map((c) => (row[c] as string).padStart(pad(c))).join('  ')}  ${row[4] as string}`,
    );
  });
  return lines;
}

function pairedRows(pairs: Map<string, PairBucket>): number {
  return [...pairs.values()].reduce((n, b) => n + b.paired, 0);
}

function staleNote(now: () => number): string[] {
  return stalePriceRows(now()).length === 0
    ? []
    : [`  note: price table is older than ${PRICE_MAX_AGE_DAYS} days (see src/internal/pricing.ts); estimates may be out of date`];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `telemetry cost`: a read-only spend report over the existing store (#191).
 * Opens the database read-only and never migrates it, so a missing file is a
 * usage error (exit 2), not a created one. Agent spend (turn-cost rows) and
 * judge spend (judge-call rows) are reported separately; a null or unusable
 * cost is counted as unknown, never summed as zero.
 */
export function runTelemetryCost(
  args: TelemetryCostArgs,
  streams: TelemetryCostStreams,
  options: TelemetryCostOptions = {},
): number {
  if (!isFile(args.dbPath)) {
    streams.stderr(`error: no telemetry database file at ${quote(args.dbPath)} (missing, or not a regular file); nothing to report\n`);
    return 2;
  }
  const since = args.since ?? localDateString((options.now ?? Date.now)());
  const sinceMs = localDayStartMs(since);
  if (sinceMs === null) {
    streams.stderr(`error: invalid --since date. ${USAGE}\n`);
    return 2;
  }

  let rows: RawRow[];
  let db: Database.Database | undefined;
  try {
    db = new Database(args.dbPath, { readonly: true, fileMustExist: true });
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_events';")
      .get();
    if (hasTable === undefined) {
      streams.stderr(`error: ${quote(args.dbPath)} has no telemetry_events table; not a harness database\n`);
      return 2;
    }
    rows = db
      .prepare(
        `SELECT session_id, ts, type, payload FROM telemetry_events
         WHERE type IN ('turn-cost', 'judge-call') AND ts >= @since
         ORDER BY ts, rowid;`,
      )
      .all({ since: sinceMs }) as RawRow[];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    streams.stderr(`error: could not read telemetry database: ${sanitizeDiagnostic(message).replace(/\n/g, ' ')}\n`);
    return 1;
  } finally {
    db?.close();
  }

  const agent = new Map<string, Bucket>();
  const judge = new Map<string, Bucket>();
  const pairs = new Map<string, PairBucket>();
  for (const row of rows) {
    const spend: Spend = row.type === 'turn-cost' ? 'agent' : 'judge';
    const { cost, model, estimate } = readCost(row.payload);
    const target = spend === 'agent' ? agent : judge;
    const key = groupKey(row, spend, model, args.by);
    const bucket = target.get(key) ?? { known: 0, sum: 0, unknown: 0 };
    if (cost === null) bucket.unknown += 1;
    else {
      bucket.known += 1;
      bucket.sum += cost;
    }
    target.set(key, bucket);
    if (spend === 'agent') {
      const pair = pairs.get(key) ?? { paired: 0, estimate: 0, actual: 0, unpaired: 0 };
      if (cost === null || estimate === null) pair.unpaired += 1;
      else {
        pair.paired += 1;
        pair.estimate += estimate;
        pair.actual += cost;
      }
      pairs.set(key, pair);
    }
  }

  const agentTotal = sumOf(agent);
  const judgeTotal = sumOf(judge);
  const unknown = agentTotal.unknown + judgeTotal.unknown;
  const lines = [
    ...section(`agent spend (turn-cost rows) by ${args.by}, since ${since} (local time)`, args.by, agent),
    '',
    ...section(`judge spend (judge-call rows) by ${args.by}, since ${since} (local time)`, args.by, judge),
    ...(args.estimate
      ? ['', ...estimateSection(args.by, since, pairs), ...(pairedRows(pairs) > 0 ? staleNote(options.now ?? Date.now) : [])]
      : []),
    '',
    `TOTAL ${formatUsd(agentTotal.sum + judgeTotal.sum)} (agent ${formatUsd(agentTotal.sum)}, judge ${formatUsd(judgeTotal.sum)})` +
      `; unknown cost, not included: ${rowsLabel(unknown)} (agent ${agentTotal.unknown}, judge ${judgeTotal.unknown})`,
  ];
  streams.stdout(`${lines.join('\n')}\n`);
  return 0;
}
