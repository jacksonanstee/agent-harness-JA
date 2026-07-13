import { Ajv2020 } from 'ajv/dist/2020.js';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, sep } from 'node:path';

import { diffRows, toCanonicalJson } from '../scorecard/index.js';
import type { ScorecardEnvelope } from '../scorecard/index.js';
import { REDTEAM_FAILURE_KINDS } from './runner.js';
import type { RedteamMeta, RedteamRow, RedteamScorecard, RedteamTotals } from './runner.js';
import { CATEGORIES } from './types.js';

/** Non-volatile meta kept in the committed baseline (design §Baseline artifact). */
export interface BaselineMeta {
  corpusSize: number;
  armLabel: string;
}

export type BaselineScorecard = ScorecardEnvelope<BaselineMeta, RedteamRow, RedteamTotals>;

/**
 * THE normalization (design CG9 — exactly one implementation): strips the two
 * volatile meta fields (createdAt, harnessVersion); everything else is kept
 * verbatim. Row fields are contractually deterministic (design GM2) —
 * volatility is only ever permitted in meta, where this function strips it.
 */
export function normalizeForBaseline(scorecard: RedteamScorecard): BaselineScorecard {
  return {
    schemaVersion: scorecard.schemaVersion,
    producer: scorecard.producer,
    meta: { corpusSize: scorecard.meta.corpusSize, armLabel: scorecard.meta.armLabel },
    rows: [...scorecard.rows],
    totals: { ...scorecard.totals },
  };
}

/** GM2 tripwire: adding a field to RedteamMeta is a compile error here until
 *  it is explicitly classified — kept (add to BaselineMeta) or volatile (add
 *  to this dropped-fields union). */
type DroppedMetaField = 'createdAt' | 'harnessVersion';
type UnclassifiedMetaField = Exclude<keyof RedteamMeta, keyof BaselineMeta | DroppedMetaField>;
const _metaExhaustive: UnclassifiedMetaField extends never
  ? true
  : ['unclassified RedteamMeta field', UnclassifiedMetaField] = true;
void _metaExhaustive;

/**
 * GM2 tripwire, rows + totals legs (Week-4 hardening — previously meta-only,
 * so adding a RedteamRow/RedteamTotals field failed at RUNTIME on the next
 * baseline load instead of at typecheck). The schema's `required` lists below
 * are built from these consts; `satisfies` catches a stale entry here, the
 * `Exclude` tripwires catch a type field missing from here. Adding a field to
 * either type is a compile error until the schema is updated in the same
 * change — and the baseline regenerated (`required` + additionalProperties:
 * false make old baselines fail loudly at load, by design).
 */
const ROW_FIELDS = [
  'id', 'pass', 'failureKind', 'category', 'verdict', 'expected', 'reason',
] as const satisfies readonly (keyof RedteamRow)[];
type UnlistedRowField = Exclude<keyof RedteamRow, (typeof ROW_FIELDS)[number]>;
const _rowExhaustive: UnlistedRowField extends never
  ? true
  : ['RedteamRow field missing from ROW_FIELDS/schema', UnlistedRowField] = true;
void _rowExhaustive;

const TOTALS_FIELDS = [
  'total', 'passed', 'failed', 'byFailureKind',
  'malicious', 'detected', 'blocked', 'flaggedOnly', 'falseBlockCount',
] as const satisfies readonly (keyof RedteamTotals)[];
type UnlistedTotalsField = Exclude<keyof RedteamTotals, (typeof TOTALS_FIELDS)[number]>;
const _totalsExhaustive: UnlistedTotalsField extends never
  ? true
  : ['RedteamTotals field missing from TOTALS_FIELDS/schema', UnlistedTotalsField] = true;
void _totalsExhaustive;

/** All baseline load/validate failures. The CLI maps every one to exit 2. */
export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineError';
  }
}

/** Mirrors src/internal/frontmatter.ts MAX_FILE_BYTES (design CG4). */
export const MAX_BASELINE_BYTES = 1_000_000;

const VERDICTS = ['pass', 'ask', 'block'] as const;

const baselineSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'producer', 'meta', 'rows', 'totals'],
  properties: {
    schemaVersion: { const: 1 },
    producer: { const: 'redteam' },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['corpusSize', 'armLabel'],
      properties: { corpusSize: { type: 'integer' }, armLabel: { type: 'string' } },
    },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...ROW_FIELDS],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
          pass: { type: 'boolean' },
          failureKind: { enum: [...REDTEAM_FAILURE_KINDS, null] },
          category: { enum: [...CATEGORIES] },
          verdict: { enum: [...VERDICTS] },
          expected: { enum: [...VERDICTS] },
          reason: { type: 'string' },
        },
      },
    },
    totals: {
      type: 'object',
      additionalProperties: false,
      required: [...TOTALS_FIELDS],
      properties: {
        total: { type: 'integer' }, passed: { type: 'integer' }, failed: { type: 'integer' },
        byFailureKind: {
          type: 'object',
          additionalProperties: false,
          required: [...REDTEAM_FAILURE_KINDS],
          properties: Object.fromEntries(REDTEAM_FAILURE_KINDS.map((k) => [k, { type: 'integer' }])),
        },
        malicious: { type: 'integer' }, detected: { type: 'integer' },
        blocked: { type: 'integer' }, flaggedOnly: { type: 'integer' },
        falseBlockCount: { type: 'integer' },
      },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true });
const validateBaseline = ajv.compile(baselineSchema);

/**
 * Exported for reuse by `src/cli/redteam-command.ts`'s `--update-baseline`
 * write path (E-3 Task 8 deviation from the design's "implement a small
 * local check" suggestion): the write path needs the identical file+parent
 * symlink guard `loadBaseline` already enforces on read, and duplicating the
 * ENOENT-tolerant lstat logic would be the second implementation of the same
 * check with no independent value (unlike the deliberate totals-backstop
 * duplication, DEC-0016).
 */
export function refuseSymlink(path: string, label: string): void {
  let isLink: boolean;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new BaselineError(`cannot stat ${label} ${path}: ${String(error)}`);
  }
  if (isLink) throw new BaselineError(`refusing baseline: ${label} ${path} is a symlink`);
}

/**
 * Ancestor-chain guard (Week-4 hardening; closes the review3 leaf+parent-only
 * gap). A RELATIVE baseline path is repo-internal — every component is
 * attacker-committable data under the malicious-cloned-repo threat model, so
 * each accumulating directory is lstat-checked (a committed symlink at `eval`
 * redirects `eval/redteam/baseline.json` wholesale; the leaf and parent checks
 * never see it). An ABSOLUTE path is operator-supplied and may legitimately
 * traverse OS-owned symlinks (macOS `/tmp`, `/var`), so it keeps the parent
 * check only — the operator owns that path, the repo does not.
 */
export function refuseAncestorSymlinks(path: string): void {
  if (isAbsolute(path)) {
    refuseSymlink(dirname(path), 'directory');
    return;
  }
  const parts = normalize(path).split(sep);
  let acc = '';
  for (const part of parts.slice(0, -1)) {
    acc = acc === '' ? part : acc + sep + part;
    refuseSymlink(acc, 'directory');
  }
}

// O_NOFOLLOW is a POSIX belt-and-braces backstop for the lstat checks above
// (an fd opened with it can never traverse a leaf symlink, even one raced in
// after the lstat). Absent on platforms without it — the lstat checks remain
// the primary, message-bearing guard everywhere.
const O_NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Hostile-input load (design §Baseline load): the baseline is repo-controlled
 * data under the malicious-cloned-repo threat model. Size-capped before read,
 * symlink-refused, ajv-validated against an exact allowlist whose id pattern
 * is the same charset runRedteam enforces on the fresh side (design CG1).
 */
export function loadBaseline(path: string): { raw: string; parsed: BaselineScorecard } {
  refuseSymlink(path, 'file');
  refuseAncestorSymlinks(path);
  // Single-fd read (Week-4 hardening): open → fstat → read on ONE descriptor
  // collapses the former lstat→stat→read window — the size cap and the read
  // are now guaranteed to see the same file, and O_NOFOLLOW refuses a leaf
  // symlink at the syscall even if one races in after the lstat above.
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new BaselineError(
        `no baseline found at ${path}; in the agent-harness-JA repo, run --update-baseline and commit the result; outside it, pass --baseline <path>`,
      );
    }
    if (code === 'ELOOP') {
      throw new BaselineError(`refusing baseline: file ${path} is a symlink`);
    }
    throw new BaselineError(`cannot read baseline ${path} (${code ?? 'open error'})`);
  }
  let raw: string;
  try {
    const stat = fstatSync(fd);
    if (stat.isDirectory()) {
      throw new BaselineError(`cannot read baseline ${path} (EISDIR)`);
    }
    if (stat.size > MAX_BASELINE_BYTES) {
      throw new BaselineError(`baseline ${path} exceeds ${MAX_BASELINE_BYTES} bytes (${stat.size})`);
    }
    raw = readFileSync(fd, 'utf8');
  } catch (error: unknown) {
    if (error instanceof BaselineError) throw error;
    throw new BaselineError(
      `cannot read baseline ${path} (${(error as NodeJS.ErrnoException).code ?? 'read error'})`,
    );
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately NOT String(error): V8 SyntaxError messages embed a
    // verbatim snippet of the (attacker-controlled) input, and this message
    // is terminal-bound — no raw repo-controlled bytes in output.
    throw new BaselineError(`baseline ${path} failed to parse as JSON`);
  }
  if (!validateBaseline(parsed)) {
    throw new BaselineError(`baseline ${path} is invalid: ${ajv.errorsText(validateBaseline.errors)}`);
  }
  const baseline = parsed as unknown as BaselineScorecard;
  // Row-id uniqueness (milestone review LOW-1): ajv cannot express it, and a
  // duplicated id previously surfaced only downstream as a confusing
  // `removed` drift (fail-closed, exit 1). Malformed baselines are a LOAD
  // failure — refuse here, exit 2, before any gate evaluation. Ids are
  // charset-pinned by the schema pattern above, so interpolating is safe.
  const seenIds = new Set<string>();
  for (const row of baseline.rows) {
    if (seenIds.has(row.id)) {
      throw new BaselineError(`baseline ${path} has duplicate row id '${row.id}'`);
    }
    seenIds.add(row.id);
  }
  return { raw, parsed: baseline };
}

export type DriftKind = 'regression' | 'improvement' | 'new-case' | 'recalibration' | 'envelope';

export interface DriftFinding {
  kind: DriftKind;
  /** Row id, or null for envelope-level drift. Ids are charset-guarded on both sides. */
  id: string | null;
  detail: string;
}

const MALICIOUS_ORDER: Record<string, number> = { block: 2, ask: 1, pass: 0 };
const BENIGN_ORDER: Record<string, number> = { pass: 2, ask: 1, block: 0 };

const isBenign = (row: RedteamRow): boolean => row.category === 'benign';

function classifyPair(before: RedteamRow, after: RedteamRow, fields: string[]): DriftFinding {
  const id = after.id;
  if (isBenign(before) !== isBenign(after)) {
    return {
      kind: 'recalibration',
      id,
      detail: `category crossed the benign/malicious boundary (${before.category} → ${after.category}) — direction is a human judgment (ADR-0018 d8)`,
    };
  }
  if (before.verdict !== after.verdict) {
    const order = isBenign(after) ? BENIGN_ORDER : MALICIOUS_ORDER;
    const moved = (order[after.verdict] ?? 0) - (order[before.verdict] ?? 0);
    return moved < 0
      ? { kind: 'regression', id, detail: `verdict weakened: ${before.verdict} → ${after.verdict}` }
      : { kind: 'improvement', id, detail: `verdict strengthened: ${before.verdict} → ${after.verdict}` };
  }
  return { kind: 'recalibration', id, detail: `fields changed with verdict unchanged: ${fields.join(', ')}` };
}

/** ADR-0019 d3: five drift classes (internal is a gate outcome, not drift). Messaging only — ALL drift fails. */
export function classifyDrift(baseline: BaselineScorecard, fresh: BaselineScorecard): DriftFinding[] {
  const diff = diffRows(baseline.rows, fresh.rows);
  const findings: DriftFinding[] = [];
  for (const removed of diff.removed) {
    findings.push({
      kind: 'regression',
      id: removed.id,
      detail: 'absent from fresh run (removed, or renamed — renames are remove+add; if intentional, update the baseline)',
    });
  }
  for (const added of diff.added) {
    findings.push({ kind: 'new-case', id: added.id, detail: `new case (${added.pass ? 'passing' : added.failureKind ?? 'failing'})` });
  }
  for (const change of diff.changed) {
    findings.push(classifyPair(change.before, change.after, change.fields));
  }
  if (findings.length === 0 && toCanonicalJson(baseline) !== toCanonicalJson(fresh)) {
    findings.push({
      kind: 'envelope',
      id: null,
      detail: 'meta/totals-shape drift with identical rows (e.g. armLabel or a totals field changed)',
    });
  }
  return findings;
}

/**
 * Independent totals re-derivation (design CG10 / DEC-0016): deliberately a
 * second implementation — does NOT import runRedteam's totals code — so the
 * backstop is a real re-derivation, not a tautology. Returns a human-readable
 * mismatch description, or null when consistent. Also re-derives corpusSize.
 */
export function totalsMismatchDetail(scorecard: BaselineScorecard): string | null {
  const { rows, totals, meta } = scorecard;
  const problems: string[] = [];
  const count = (pred: (r: RedteamRow) => boolean): number => rows.filter(pred).length;
  const derived = {
    total: rows.length,
    passed: count((r) => r.pass),
    failed: count((r) => !r.pass),
    malicious: count((r) => r.category !== 'benign'),
    detected: count((r) => r.category !== 'benign' && r.verdict !== 'pass'),
    blocked: count((r) => r.category !== 'benign' && r.verdict === 'block'),
    flaggedOnly: count((r) => r.category !== 'benign' && r.verdict === 'ask'),
    falseBlockCount: count((r) => r.failureKind === 'false-block'),
  };
  for (const [key, value] of Object.entries(derived)) {
    if (totals[key as keyof typeof derived] !== value) problems.push(`totals.${key} claims ${totals[key as keyof typeof derived]}, rows derive ${value}`);
  }
  for (const kind of ['missed', 'false-flag', 'false-block'] as const) {
    const derivedKind = count((r) => r.failureKind === kind);
    if (totals.byFailureKind[kind] !== derivedKind) problems.push(`byFailureKind.${kind} claims ${totals.byFailureKind[kind]}, rows derive ${derivedKind}`);
  }
  if (meta.corpusSize !== rows.length) problems.push(`meta.corpusSize claims ${meta.corpusSize}, rows derive ${rows.length}`);
  return problems.length === 0 ? null : problems.join('; ');
}

/** Plain text (raw GH Actions logs), ids only, no payload text ever. */
export function renderDriftReport(findings: readonly DriftFinding[]): string {
  if (findings.length === 0) return '';
  const lines = findings.map((f) => `  ${f.kind.toUpperCase().padEnd(13)} ${f.id ?? '(envelope)'} — ${f.detail}`);
  return `Baseline drift (${findings.length} finding${findings.length === 1 ? '' : 's'}):\n${lines.join('\n')}\n`;
}
