# E-3 Regression Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert E-2's canonical red-team scorecard into a committed baseline that fails CI on any behaviour drift, closing ADR-0018 decision 9's block→ask blind spot.

**Architecture:** A producer-agnostic row differ (`src/eval/scorecard/diff.ts`) + a redteam-specific baseline module (`src/eval/redteam/baseline.ts`: normalize / hostile-load / classify / re-derive totals / render) + CLI compare-by-default wiring extracted into `src/cli/redteam-command.ts` (with shared helpers hoisted to `src/cli/shared.ts` — cli.ts is at 753/800 lines). The committed artifact is `eval/redteam/baseline.json`, updated only via `--update-baseline`.

**Tech Stack:** TypeScript ESM, vitest, ajv 2020-12 (existing dep, golden-parser precedent), no new dependencies.

**Spec:** `process/designs/2026-07-10-e3-regression-gate.md` (user-approved; panel+arbiter APPROVED; Gemini SOUND). Decision log beside it. On any conflict, the spec wins.

## Global Constraints

- Verification command is `npm run typecheck` (runs BOTH `tsc --noEmit` and `tsc -p tsconfig.test.json`) — NEVER bare `npx tsc --noEmit` (CI-parity lesson, tasks/lessons.md).
- Full local gate per task: `npm run lint && npm run typecheck && npm test`.
- Locked semantics: strict per-row weakening; gate fails on ANY drift including improvements. Classification is messaging only.
- Exit codes: 0 gate green; 1 false-block and/or drift; 2 usage/infra (missing/oversized/symlinked/malformed/schema-mismatched baseline, totals-backstop `internal`).
- Row-determinism contract: volatility only ever in `meta`; normalization strips exactly `meta.createdAt` + `meta.harnessVersion`.
- Rows carry outcomes, never payloads (ADR-0018 d4). Drift report prints ids only, through `sanitizeForTerminal`.
- Conventional commits (`feat:`/`test:`/`refactor:`/`docs:`/`chore:`).
- Layering: `src/eval/**` must never import `src/cli*` — extend every eslint ban list containing `**/cli` with `**/cli/**`.
- Pinned output strings (copy verbatim, tests assert them literally):
  - `GATE_FAILURE=<none|false-block|drift|false-block+drift|internal>`
  - Remedy: `` Baseline drift detected. Run `npm run redteam -- --update-baseline`, review the diff, and commit eval/redteam/baseline.json. (The gate fails on improvements too — see docs/decisions/0019.) ``
  - New-case-only: `This failure is expected: you added <N> case(s) not yet in the baseline. No existing behaviour changed — update the baseline to record them.`
  - Missing baseline: `no baseline found at <path>; in the agent-harness-JA repo, run --update-baseline and commit the result; outside it, pass --baseline <path>`
  - Non-canonical: `baseline file is not canonical — regenerate with --update-baseline`

---

### Task 1: Branch + commit plan

**Files:** none created in `src/`.

- [ ] **Step 1:** `git checkout -b feat/eval-e3-regression-gate design/e3-regression-gate`
- [ ] **Step 2:** `git add process/plans/2026-07-10-e3-regression-gate-implementation.md && git commit -m "docs: E-3 implementation plan"`
- [ ] **Step 3:** Sanity: `npm run lint && npm run typecheck && npm test` → all green (baseline: 706 tests).

---

### Task 2: Shared arm-label constant

**Files:**
- Modify: `src/eval/redteam/types.ts` (add constant)
- Modify: `src/eval/redteam/index.ts` (export)
- Modify: `src/cli.ts:606` (consume)
- Modify: `src/eval/redteam/drift.test.ts:20` (consume)

**Interfaces:**
- Produces: `REDTEAM_ARM_LABEL = 'security-on'` (exported from `src/eval/redteam/types.ts` and the `./eval/index.js` barrel). Tasks 4, 8, 10 consume it.

- [ ] **Step 1:** Add to `src/eval/redteam/types.ts`:

```ts
/** Single source of truth for the redteam arm label (design SK5): the CLI,
 *  the baseline e2e, and the drift diagnostic all derive from this constant
 *  so the committed baseline can never split-brain against the live run. */
export const REDTEAM_ARM_LABEL = 'security-on';
```

- [ ] **Step 2:** Add `REDTEAM_ARM_LABEL` to the `./types.js` export line in `src/eval/redteam/index.ts`; confirm it re-exports through `src/eval/index.ts` (follow how `CATEGORIES` flows).
- [ ] **Step 3:** In `src/cli.ts` `runRedteamCommand`, replace `armLabel: 'security-on'` with `armLabel: REDTEAM_ARM_LABEL` (import from `./eval/index.js`). In `drift.test.ts`, replace the literal with `` `${REDTEAM_ARM_LABEL} (live, drift check)` ``.
- [ ] **Step 4:** `npm run lint && npm run typecheck && npm test` → green, then `git commit -m "refactor(eval): single REDTEAM_ARM_LABEL constant (E-3 SK5)"`.

---

### Task 3: Producer-agnostic row differ

**Files:**
- Create: `src/eval/scorecard/diff.ts`
- Create: `src/eval/scorecard/diff.test.ts`
- Modify: `src/eval/scorecard/index.ts` (export)

**Interfaces:**
- Produces:

```ts
export interface ChangedRow<R> { before: R; after: R; fields: string[]; }
export interface RowDiff<R> { identical: boolean; added: R[]; removed: R[]; changed: ChangedRow<R>[]; }
export function diffRows<R extends { id: string }>(
  baseline: readonly R[], fresh: readonly R[],
): RowDiff<R>;
```

Task 6's classifier consumes this. CRITICAL (design SK2): compares **all own enumerable fields** of both rows (union of keys), not just `ScorecardRowCore` fields — a `block→ask` softening changes only the extension field `verdict` while `pass`/`failureKind` are identical on both sides.

- [ ] **Step 1: Write the failing test** `src/eval/scorecard/diff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { diffRows } from './diff.js';

interface Row { id: string; pass: boolean; failureKind: string | null; verdict?: string }
const row = (id: string, over: Partial<Row> = {}): Row => ({ id, pass: true, failureKind: null, ...over });

describe('diffRows', () => {
  it('reports identical for equal sets regardless of order', () => {
    const d = diffRows([row('a'), row('b')], [row('b'), row('a')]);
    expect(d).toEqual({ identical: true, added: [], removed: [], changed: [] });
  });

  it('reports added and removed by id', () => {
    const d = diffRows([row('a')], [row('b')]);
    expect(d.identical).toBe(false);
    expect(d.removed.map((r) => r.id)).toEqual(['a']);
    expect(d.added.map((r) => r.id)).toEqual(['b']);
  });

  it('detects an extension-field-only change (design SK2: block→ask leaves core identical)', () => {
    const d = diffRows([row('a', { verdict: 'block' })], [row('a', { verdict: 'ask' })]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]?.fields).toEqual(['verdict']);
  });

  it('detects a field present on one side only', () => {
    const d = diffRows([row('a')], [row('a', { verdict: 'ask' })]);
    expect(d.changed[0]?.fields).toEqual(['verdict']);
  });

  it('pairs by id even with __proto__ as an id (Map pairing, design CG3)', () => {
    const d = diffRows([row('__proto__')], [row('__proto__')]);
    expect(d.identical).toBe(true);
  });

  it('handles empty row sets', () => {
    expect(diffRows([], []).identical).toBe(true);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/eval/scorecard/diff.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/eval/scorecard/diff.ts`:

```ts
export interface ChangedRow<R> {
  before: R;
  after: R;
  /** Sorted names of every own field whose value differs (strict equality). */
  fields: string[];
}

export interface RowDiff<R> {
  identical: boolean;
  added: R[];
  removed: R[];
  changed: ChangedRow<R>[];
}

/**
 * Id-keyed row diff over ALL own enumerable fields, generic over the concrete
 * row type (design SK2): a redteam block→ask softening changes only the
 * extension field `verdict` — core fields are identical on both sides — so a
 * core-fields-only comparison would fail the gate with an empty changed list.
 * Knows nothing about verdict strength; direction is the producer's concern.
 * Pairing uses Map, immune to `__proto__` id corruption (design CG3).
 */
export function diffRows<R extends { id: string }>(
  baseline: readonly R[],
  fresh: readonly R[],
): RowDiff<R> {
  const freshById = new Map(fresh.map((r) => [r.id, r]));
  const removed: R[] = [];
  const changed: ChangedRow<R>[] = [];
  for (const before of baseline) {
    const after = freshById.get(before.id);
    if (after === undefined) {
      removed.push(before);
      continue;
    }
    freshById.delete(before.id);
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const fields = keys.filter(
      (k) => (before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k],
    );
    if (fields.length > 0) changed.push({ before, after, fields });
  }
  const added = [...freshById.values()];
  return {
    identical: removed.length === 0 && added.length === 0 && changed.length === 0,
    added,
    removed,
    changed,
  };
}
```

- [ ] **Step 4:** Test passes; export `diffRows` + both types from `src/eval/scorecard/index.ts`; full gate green.
- [ ] **Step 5:** `git commit -m "feat(eval): producer-agnostic all-own-fields row differ (E-3)"`

---

### Task 4: Baseline normalization

**Files:**
- Create: `src/eval/redteam/baseline.ts`
- Create: `src/eval/redteam/baseline.test.ts`
- Modify: `src/eval/redteam/index.ts` (exports)

**Interfaces:**
- Consumes: `RedteamScorecard`, `RedteamRow`, `RedteamTotals` (runner.ts), `REDTEAM_ARM_LABEL` (Task 2), `toCanonicalJson` (scorecard).
- Produces:

```ts
export interface BaselineMeta { corpusSize: number; armLabel: string; }
export type BaselineScorecard = ScorecardEnvelope<BaselineMeta, RedteamRow, RedteamTotals>;
export function normalizeForBaseline(scorecard: RedteamScorecard): BaselineScorecard;
```

The ONLY normalization implementation (design CG9) — compare path, `--update-baseline`, and the e2e all call this.

- [ ] **Step 1: Failing test** (start `src/eval/redteam/baseline.test.ts`):

```ts
import { describe, expect, it } from 'vitest';

import { scan } from '../../security/index.js';
import { toCanonicalJson } from '../scorecard/index.js';
import { normalizeForBaseline } from './baseline.js';
import { CORPUS } from './corpus.js';
import { runRedteam } from './runner.js';
import { REDTEAM_ARM_LABEL } from './types.js';

const fresh = () =>
  runRedteam(CORPUS, scan, { armLabel: REDTEAM_ARM_LABEL, harnessVersion: '9.9.9', now: () => 1234 });

describe('normalizeForBaseline', () => {
  it('drops exactly createdAt and harnessVersion, keeps everything else', () => {
    const n = normalizeForBaseline(fresh());
    expect(n.meta).toEqual({ corpusSize: CORPUS.length, armLabel: REDTEAM_ARM_LABEL });
    expect(n.schemaVersion).toBe(1);
    expect(n.producer).toBe('redteam');
    expect(n.rows).toEqual(fresh().rows);
    expect(n.totals).toEqual(fresh().totals);
  });

  it('is volatile-proof: two runs at different times/versions normalize byte-identically', () => {
    const a = runRedteam(CORPUS, scan, { armLabel: REDTEAM_ARM_LABEL, harnessVersion: '1.0.0', now: () => 1 });
    const b = runRedteam(CORPUS, scan, { armLabel: REDTEAM_ARM_LABEL, harnessVersion: '2.0.0', now: () => 999_999 });
    expect(toCanonicalJson(normalizeForBaseline(a))).toBe(toCanonicalJson(normalizeForBaseline(b)));
  });

  it('does not mutate its input', () => {
    const s = fresh();
    normalizeForBaseline(s);
    expect(s.meta.createdAt).toBeDefined();
  });
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** in new `src/eval/redteam/baseline.ts`:

```ts
import type { ScorecardEnvelope } from '../scorecard/index.js';
import type { RedteamRow, RedteamScorecard, RedteamTotals } from './runner.js';

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
    rows: scorecard.rows,
    totals: scorecard.totals,
  };
}
```

- [ ] **Step 4:** Green; export `normalizeForBaseline`, `BaselineMeta`, `BaselineScorecard` from the redteam barrel; full gate; `git commit -m "feat(eval): baseline normalization — single implementation, volatile meta stripped (E-3)"`

---

### Task 5: Hostile baseline load

**Files:**
- Modify: `src/eval/redteam/baseline.ts` (add loader + error + schema)
- Modify: `src/eval/redteam/baseline.test.ts` (add cases)
- Modify: `src/eval/redteam/index.ts` (exports)

**Interfaces:**
- Produces:

```ts
export class BaselineError extends Error {}          // name = 'BaselineError'; ALL load failures; CLI maps to exit 2
export const MAX_BASELINE_BYTES = 1_000_000;         // mirrors src/internal/frontmatter.ts MAX_FILE_BYTES
export function loadBaseline(path: string): { raw: string; parsed: BaselineScorecard };
```

Load order (design §Baseline load): lstat symlink refusal (file AND parent dir) → stat size cap BEFORE read → read → JSON.parse → ajv 2020-12 structural validation with `additionalProperties:false` at every level and the id `pattern` `^[a-z0-9][a-z0-9-]{0,63}$` (the pattern IS the charset guard — excludes `__proto__` since `_` is outside the charset; design CG1/CG3) → `schemaVersion === 1` / `producer === 'redteam'` (covered by `const` in the schema).

- [ ] **Step 1: Failing tests** (append to `baseline.test.ts`; use `mkdtempSync(join(tmpdir(), 'e3-'))` + `writeFileSync`; helper `writeBaseline(dir, content)` returns path):

Cases (each expects `loadBaseline(path)` to throw `BaselineError` with a message containing the quoted phrase):
1. missing file → `/no baseline found/`
2. oversized: write `'x'.repeat(1_000_001)` → `/exceeds/`
3. symlinked file: `symlinkSync(realFile, linkPath)` → load via link → `/symlink/` (skip on platforms where symlink needs privileges is NOT a concern on darwin/linux CI)
4. malformed JSON `'{'` → `/parse/i`
5. shape violations (each a valid-JSON mutation of a good baseline produced by `toCanonicalJson(normalizeForBaseline(fresh()))` then `JSON.parse`-ed, mutated, re-stringified): extra top-level key `{...good, extra: 1}`; `rows: {}`; a row with `id: 42`; a row with an extra field `lastEvaluatedAt`; a row id `'__proto__'`; a row id `'x](http://evil)'` → all `/baseline/` + ajv detail
6. `schemaVersion: 2` and `producer: 'golden'` → rejected
7. happy path: `loadBaseline` on the canonical file returns `{ raw, parsed }` with `raw` byte-equal to what was written and `parsed.rows.length === CORPUS.length`

- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** (append to `baseline.ts`):

```ts
import { Ajv2020 } from 'ajv/dist/2020.js';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { CATEGORIES } from './types.js';
import { REDTEAM_FAILURE_KINDS } from './runner.js';

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
        required: ['id', 'pass', 'failureKind', 'category', 'verdict', 'expected', 'reason'],
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
      required: [
        'total', 'passed', 'failed', 'byFailureKind',
        'malicious', 'detected', 'blocked', 'flaggedOnly', 'falseBlockCount',
      ],
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

function refuseSymlink(path: string, label: string): void {
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
 * Hostile-input load (design §Baseline load): the baseline is repo-controlled
 * data under the malicious-cloned-repo threat model. Size-capped before read,
 * symlink-refused, ajv-validated against an exact allowlist whose id pattern
 * is the same charset runRedteam enforces on the fresh side (design CG1).
 */
export function loadBaseline(path: string): { raw: string; parsed: BaselineScorecard } {
  refuseSymlink(path, 'file');
  refuseSymlink(dirname(path), 'directory');
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new BaselineError(
      `no baseline found at ${path}; in the agent-harness-JA repo, run --update-baseline and commit the result; outside it, pass --baseline <path>`,
    );
  }
  if (size > MAX_BASELINE_BYTES) {
    throw new BaselineError(`baseline ${path} exceeds ${MAX_BASELINE_BYTES} bytes (${size})`);
  }
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new BaselineError(`baseline ${path} failed to parse as JSON: ${String(error)}`);
  }
  if (!validateBaseline(parsed)) {
    throw new BaselineError(`baseline ${path} is invalid: ${ajv.errorsText(validateBaseline.errors)}`);
  }
  return { raw, parsed: parsed as unknown as BaselineScorecard };
}
```

- [ ] **Step 4:** Green (note: `lstat` on the tmpdir parent is fine — tmp dirs are real dirs). Export `loadBaseline`, `BaselineError`, `MAX_BASELINE_BYTES`. Full gate; `git commit -m "feat(eval): hostile-input baseline loader — size cap, symlink refusal, ajv allowlist, id charset (E-3)"`

---

### Task 6: Classifier, independent totals re-derivation, drift report

**Files:**
- Modify: `src/eval/redteam/baseline.ts`
- Modify: `src/eval/redteam/baseline.test.ts`
- Modify: `src/eval/redteam/index.ts`

**Interfaces:**
- Consumes: `diffRows` (Task 3), `normalizeForBaseline`/`BaselineScorecard` (Task 4), `toCanonicalJson`.
- Produces:

```ts
export type DriftKind = 'regression' | 'improvement' | 'new-case' | 'recalibration' | 'envelope';
export interface DriftFinding { kind: DriftKind; id: string | null; detail: string; }  // id null only for envelope
export function classifyDrift(baseline: BaselineScorecard, fresh: BaselineScorecard): DriftFinding[];
export function totalsMismatchDetail(scorecard: BaselineScorecard): string | null;  // null = consistent
export function renderDriftReport(findings: readonly DriftFinding[]): string;       // plain text, ids only
```

Classification rules (design §Gate rule 6). Strength order: malicious `block(2) > ask(1) > pass(0)`; benign `pass(2) > ask(1) > block(0)`. For a paired row: cross-class category change → `recalibration`; verdict moved down → `regression`; up → `improvement`; verdict same but any other field changed → `recalibration`. Removed id → `regression` with the rename hint. Added id → `new-case`. No row findings but canonical strings differ → single `envelope` finding.

- [ ] **Step 1: Failing tests.** Build rows via a local helper mirroring runner semantics; mutate copies of a real normalized scorecard. Required cases:

```ts
// classifyDrift — direction table (baseline row → fresh row):
// malicious block→ask   ⇒ [{kind:'regression', id}]         (the decision-9 flagship)
// malicious ask→pass    ⇒ regression; malicious block→pass ⇒ regression
// malicious ask→block   ⇒ improvement; malicious pass→ask/block ⇒ improvement
// benign pass→ask       ⇒ regression (new false-flag); benign ask→pass ⇒ improvement
// benign pass→block     ⇒ regression
// same verdict, expected changed        ⇒ recalibration
// same verdict, reason reworded         ⇒ recalibration
// category direct→jailbreak (same class)+same verdict ⇒ recalibration
// category benign→exfil (cross-class), verdict ask→block ⇒ recalibration (NOT improvement)
// removed id            ⇒ regression, detail matches /removed, or renamed/
// added id (missed row) ⇒ new-case
// armLabel changed, rows identical ⇒ [{kind:'envelope', id:null}]
// identical scorecards  ⇒ []

// totalsMismatchDetail:
// consistent scorecard ⇒ null
// totals.detected off by one ⇒ string mentioning 'detected'
// meta.corpusSize ≠ rows.length ⇒ string mentioning 'corpusSize'   (design SK11)

// renderDriftReport:
// output contains one line per finding, kind-labelled, and NO payload text —
// assert the corpus case `text` of a mutated row never appears in the report
```

- [ ] **Step 2:** Run → FAIL. **Step 3: Implement** (append to `baseline.ts`):

```ts
import { toCanonicalJson, diffRows } from '../scorecard/index.js';

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

/** Design §Gate rule 6: six-way classification. Messaging only — ALL drift fails. */
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
```

- [ ] **Step 4:** Green; export the four new names + `DriftKind`/`DriftFinding`; full gate; `git commit -m "feat(eval): drift classifier, independent totals backstop, drift report (E-3)"`

---

### Task 7: CLI extraction (pure move — cli.ts is at 753/800)

**Files:**
- Create: `src/cli/shared.ts`
- Create: `src/cli/redteam-command.ts`
- Modify: `src/cli.ts` (remove moved code, import + re-export)
- Modify: `eslint.config.js` (add `**/cli/**` beside every `**/cli` ban)
- Modify: `src/layering.test.ts` (add probe: eval importing `../../cli/shared.js` is flagged)

**Interfaces:**
- Produces: `src/cli/shared.ts` exports (moved VERBATIM from cli.ts — byte-identical function bodies, S-4 pure-move precedent): `USAGE`, `EVAL_OUT_DIR`, `TERMINAL_UNSAFE`+`sanitizeForTerminal`, `scorecardFilename`, `refuseSymlinkedDir`, `writeScorecard`, `readPackageVersion` (note: its `new URL('../package.json', import.meta.url)` becomes `'../../package.json'` from the new depth — the ONE permitted textual change; test below pins it). `src/cli/redteam-command.ts` exports `parseRedteamArgs`, `runRedteamCommand`, `RedteamArgs` (moved verbatim this task; extended in Task 8).
- `src/cli.ts` re-exports every moved name (`export { writeScorecard, sanitizeForTerminal, scorecardFilename, refuseSymlinkedDir } from './cli/shared.js'` etc.) so `src/cli.test.ts` is UNMODIFIED — that is the pure-move proof.

- [ ] **Step 1:** Move the listed items; update `USAGE`'s redteam line to `agent-harness-ja redteam [--out <dir>] [--update-baseline] [--baseline <path>]` (UA3; flags parse in Task 8).
- [ ] **Step 2:** eslint: in every ban array containing `'**/cli'`, add `'**/cli/**'`. In `layering.test.ts`, add a probe file `src/eval/golden/bad-cli-dir-import.ts` with `import { USAGE } from '../../cli/shared.js';` asserting eslint flags it (mirror the existing `bad-cli-import.ts` probe at line ~114).
- [ ] **Step 3:** Add one pin test in a new `src/cli/shared.test.ts`: `readPackageVersion()` returns the version from the repo's real package.json (`expect(readPackageVersion()).toBe(JSON.parse(readFileSync(...)).version)`) — this catches the `../package.json` depth mistake.
- [ ] **Step 4:** `npm run lint && npm run typecheck && npm test` → green with `src/cli.test.ts` untouched; `npm run build && node dist/cli.js redteam` still exits 0. `git commit -m "refactor(cli): extract shared helpers + redteam command to src/cli/ (753/800 cap, E-3 CG8)"`

---

### Task 8: Compare-by-default wiring, flags, pinned output, exit codes

**Files:**
- Modify: `src/cli/redteam-command.ts`
- Create: `src/cli/redteam-command.test.ts`
- Modify: `package.json` (add `"redteam": "node ./dist/cli.js redteam"` script — the remedy text runs it)

**Interfaces:**
- Consumes: Task 4/5/6 exports via `../eval/index.js`; `writeScorecard`/`sanitizeForTerminal`/`USAGE` from `./shared.js`.
- Produces:

```ts
export const DEFAULT_BASELINE_PATH = 'eval/redteam/baseline.json';   // named constant (CG2)
export interface RedteamArgs {
  command: 'redteam';
  out: string;
  updateBaseline: boolean;
  baselinePath: string;
}
export function parseRedteamArgs(argv: string[]): ParseResult;
export function runRedteamCommand(args: RedteamArgs): number;
```

- [ ] **Step 1: Failing tests** `src/cli/redteam-command.test.ts`. Drive `runRedteamCommand` directly with a tmpdir; capture stdout/stderr via vitest spies on `process.stdout.write`/`process.stderr.write`. Required cases (each asserts exit code AND the pinned strings from Global Constraints verbatim):

1. parse: `--update-baseline` sets flag; `--baseline p` overrides path; unknown flag → `{ok:false}`; defaults = `{out: EVAL_OUT_DIR, updateBaseline: false, baselinePath: DEFAULT_BASELINE_PATH}`.
2. missing baseline (compare mode, tmp path) → exit 2, stderr contains the pinned missing-baseline message, stdout contains NO `GATE_FAILURE=` line.
3. update mode into tmpdir with pre-created `eval/redteam/` parent → exit 0, file exists, bytes === `toCanonicalJson(normalizeForBaseline(<live run>))`, NO `GATE_FAILURE=` line; re-running compare mode against it → exit 0, stdout contains `GATE_FAILURE=none`.
4. update mode with missing parent dir → exit 2, no file written.
5. compare with drift: write a baseline then mutate one malicious row `block→ask` in the file (keep totals consistent by also decrementing `blocked`/incrementing `flaggedOnly`) → exit 1, stdout contains `GATE_FAILURE=drift`, `REGRESSION`, the row id, and the pinned remedy line.
6. new-case-only drift: baseline missing one row (remove a row AND fix totals/corpusSize consistently) → exit 1, stdout contains the pinned `This failure is expected:` line with N=1.
7. non-canonical: write semantically-identical JSON with reordered keys (`JSON.stringify(JSON.parse(canonical))` — loses key sorting/indent) → exit 1, stdout contains the pinned non-canonical message and `GATE_FAILURE=drift`.
8. internal: baseline valid but totals inconsistent is caught at load?? No — backstop checks the FRESH scorecard. Simulate by injecting a broken runner? Instead: unit-test the mapping — `totalsMismatchDetail` mismatch path is unit-covered in Task 6; here assert wiring via a corrupted-baseline totals file → that fails ajv? No: ajv validates shape not arithmetic. A baseline with arithmetically-wrong totals vs its own rows is semantic drift vs fresh (rows equal, totals differ → envelope) → assert exit 1 + `GATE_FAILURE=drift` + `ENVELOPE`. (The fresh-side internal path cannot be reached through the real runner — cover the branch by exporting a small `gateOutcome(fresh, baseline)` helper if needed; acceptable to assert via that helper's unit test that a fresh-side mismatch yields `GATE_FAILURE=internal` + exit 2.)
9. symlinked baseline path → exit 2.
10. equal-baseline + a false-block CANNOT be produced by the real corpus (it has none) — cover the exit-code precedence with the `gateOutcome` helper: falseBlock+noDrift → 1 + `GATE_FAILURE=false-block`; falseBlock+drift → 1 + `GATE_FAILURE=false-block+drift`; update-mode falseBlock → refuses, no write.

- [ ] **Step 2:** Run → FAIL. **Step 3: Implement.** Structure `runRedteamCommand` as: run corpus → `writeScorecard` + markdown (existing behaviour, exit 2 on write failure) → compute pieces → branch update vs compare. Extract the pure decision into an exported helper so precedence is unit-testable without filesystem:

```ts
export interface GateOutcome { exitCode: 0 | 1 | 2; gateLine: string | null; }

export function gateOutcome(opts: {
  falseBlockCount: number;
  internalDetail: string | null;   // totalsMismatchDetail(freshNormalized)
  driftFindings: readonly DriftFinding[];
  nonCanonical: boolean;
}): GateOutcome {
  if (opts.internalDetail !== null) return { exitCode: 2, gateLine: 'GATE_FAILURE=internal' };
  const falseBlock = opts.falseBlockCount > 0;
  const drift = opts.driftFindings.length > 0 || opts.nonCanonical;
  if (falseBlock && drift) return { exitCode: 1, gateLine: 'GATE_FAILURE=false-block+drift' };
  if (falseBlock) return { exitCode: 1, gateLine: 'GATE_FAILURE=false-block' };
  if (drift) return { exitCode: 1, gateLine: 'GATE_FAILURE=drift' };
  return { exitCode: 0, gateLine: 'GATE_FAILURE=none' };
}
```

Compare path: `loadBaseline` (BaselineError → stderr + exit 2, no gate line) → `freshNorm = normalizeForBaseline(scorecard)`; `freshCanon = toCanonicalJson(freshNorm)`; byte-equal to `raw` → findings=[] nonCanonical=false; else if `toCanonicalJson(parsed) === freshCanon` → nonCanonical=true (print pinned non-canonical line); else `findings = classifyDrift(parsed, freshNorm)`. Print `renderDriftReport` (through `sanitizeForTerminal`), then the new-case-only summary when every finding is `new-case`, then the remedy line when drift, then the gate line, then return `gateOutcome(...)`. Update path: backstop check → falseBlock check → `refuseSymlink` file+parent → parent-exists check → write `${path}.tmp` then `renameSync` → informational `classifyDrift(oldParsed, freshNorm)` report when an old baseline loaded cleanly → exit 0, no gate line.

- [ ] **Step 4:** Add the npm script; green; full gate; `npm run build && node dist/cli.js redteam` from repo root → exit 2 (no baseline yet) with the pinned message — expected until Task 9. `git commit -m "feat(cli): redteam compare-by-default, --update-baseline, pinned GATE_FAILURE contract (E-3)"`

---

### Task 9: Commit the first baseline + .gitattributes

**Files:**
- Create: `eval/redteam/baseline.json` (generated, committed)
- Create: `.gitattributes`
- Modify: `README.md` (quick-start `redteam` line beside `eval`'s)

- [ ] **Step 1:** `npm run build && node dist/cli.js redteam --update-baseline` → exit 0, writes `eval/redteam/baseline.json`.
- [ ] **Step 2:** `node dist/cli.js redteam` → exit 0, stdout ends with `GATE_FAILURE=none`.
- [ ] **Step 3:** Create `.gitattributes`:

```
eval/redteam/baseline.json text eol=lf
```

- [ ] **Step 4:** README quick-start, after the `eval` line:

```markdown
# Run the keyless red-team gate (fails on ANY drift vs the committed baseline — see docs/decisions/0019)
npm run redteam
```

- [ ] **Step 5:** `git add eval/redteam/baseline.json .gitattributes README.md && git commit -m "feat(eval): commit first red-team baseline + eol pin (E-3)"`

---

### Task 10: E2E — committed baseline matches live run, failure message = drift report

**Files:**
- Create: `src/eval/redteam/baseline-e2e.test.ts`

- [ ] **Step 1: Write the test** (it should PASS immediately — Task 9 just generated the file; its purpose is failing on FUTURE drift inside `npm test`, which CI runs BEFORE the gate step, so its message must be the classified report, design SK4/UA6):

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { scan } from '../../security/index.js';
import { toCanonicalJson } from '../scorecard/index.js';
import { classifyDrift, loadBaseline, normalizeForBaseline, renderDriftReport } from './baseline.js';
import { CORPUS } from './corpus.js';
import { runRedteam } from './runner.js';
import { REDTEAM_ARM_LABEL } from './types.js';

// CI runs `npm test` before the redteam gate step, so on drift THIS test is
// the first failure surface — its assertion messages must be the same
// classified report the CLI prints, never a raw multi-KB JSON diff.
describe('committed baseline (eval/redteam/baseline.json)', () => {
  const fresh = normalizeForBaseline(
    runRedteam(CORPUS, scan, { armLabel: REDTEAM_ARM_LABEL, now: () => 0 }),
  );
  const { raw, parsed } = loadBaseline('eval/redteam/baseline.json');

  it('matches the live run (classified report on failure)', () => {
    const findings = classifyDrift(parsed, fresh);
    expect(findings, renderDriftReport(findings)).toEqual([]);
  });

  it('is byte-canonical (regenerate with --update-baseline on failure)', () => {
    expect(raw === toCanonicalJson(fresh), 'baseline file is not canonical — regenerate with --update-baseline').toBe(true);
  });

  it('is the file git has, unmangled by line endings', () => {
    expect(readFileSync('eval/redteam/baseline.json', 'utf8')).not.toContain('\r\n');
  });
});
```

- [ ] **Step 2:** `npx vitest run src/eval/redteam/baseline-e2e.test.ts` → PASS. Negative check: temporarily edit one verdict in baseline.json, re-run, confirm the failure output shows the classified report (not a JSON blob); revert (`git checkout eval/redteam/baseline.json`).
- [ ] **Step 3:** Full gate; `git commit -m "test(eval): e2e — committed baseline matches live run, classified failure message (E-3)"`

---

### Task 11: Documentation

**Files:**
- Create: `docs/decisions/0019-regression-gate.md`
- Modify: `docs/decisions/0018-redteam-corpus.md` (amendments: d7 wording, d8 note, d9 Revisit-if fired + level-vs-delta sentence)
- Modify: `process/01-requirements.md` (E-3 row: SQLite → committed canonical-JSON baseline, cross-ref ADR-0019)
- Modify: `docs/security-model.md` (hostile-baseline entry)
- Modify: `process/05-week-plan.md` (E-3 checkbox; checkpoint "once E-3 lands" → present tense)

Content requirements for ADR-0019 (each is a decision-log/spec item — copy the arguments from the spec, do not thin them): leads with fail-on-any-drift vs asymmetric-ratchet (latent-stale-baseline hole; Betterer/DEC-0016); survey citations; six-class table; requirements-table SQLite deviation + acceptance mapping to the corrupted-fixture test; repo/CI consumer contract + Week-4 npm-publish decision point; removed-case-fails rule; no-new-exit-code + GATE_FAILURE scope; row-determinism contract (GM2); branch-protection MUST (GM1); concurrent-PR accepted limitation; golden-reuse caveat (field projection, not built); two-hunk-diff note (UA9). ADR-0018 d7 amendment: replace "fires only on the one gate-load-bearing failure kind" with wording covering drift, cross-referencing ADR-0019.

- [ ] **Step 1:** Write ADR-0019 following 0018's format (Status/Date/Requirements/Context/Decisions/Consequences/Alternatives/Revisit-if).
- [ ] **Step 2:** Apply the four amendments; verify no stale claims: `grep -rn "falseBlockCount === 0 alone\|once E-3 lands" docs/ process/ README.md` → every hit updated or explicitly historical.
- [ ] **Step 3:** `git commit -m "docs: ADR-0019 regression gate + ADR-0018/requirements/security-model/week-plan amendments (E-3)"`

---

### Task 12: Gates + PR

- [ ] **Step 1:** Full local gate: `npm run lint && npm run typecheck && npm test && npm run build && node dist/cli.js redteam` → all green, exit 0, `GATE_FAILURE=none`.
- [ ] **Step 2:** `/review3` (code=sonnet; security+arch=Fable inherit). Fix confirmed findings; verifier-confirm fixes.
- [ ] **Step 3:** `/differential-review` whole branch vs main → report to `process/reviews/differential-review-e3-milestone.md`, commit.
- [ ] **Step 4:** Verify branch protection: `gh api repos/{owner}/{repo}/branches/main/protection --jq .required_status_checks.strict` — if not `true`, tell Jackson to enable require-branches-up-to-date (design GM1 MUST; needs admin).
- [ ] **Step 5:** Push, open PR onto main (squash target). PR body: what/why, gate semantics summary, the GATE_FAILURE contract, test counts, review-gate summary, `Closes` nothing (no open issue). Jackson merges + runs live smoke: `node dist/cli.js redteam` on merged main → exit 0.

---

## Self-Review (done at write time)

- **Spec coverage:** every spec section maps to a task — baseline artifact/normalization (T4, T9), hostile load (T5), gate rule + six classes (T6, T8), output contract (T8), update mechanics (T8), exit codes (T8), consumer contract (T8 DEFAULT_BASELINE_PATH + pinned message; ADR text T11), code placement/CLI extraction (T3, T7), interactions/e2e (T10), `.gitattributes` (T9), docs incl. GM1/GM2 (T11), branch-protection MUST (T12), arm-label constant (T2). Gap check: none found.
- **Placeholder scan:** no TBDs; every code step shows code; test case 8 in T8 explicitly resolves the fresh-side-internal reachability question via the `gateOutcome` helper rather than hand-waving.
- **Type consistency:** `BaselineScorecard`/`normalizeForBaseline`/`loadBaseline`/`classifyDrift`/`totalsMismatchDetail`/`renderDriftReport`/`DriftFinding`/`gateOutcome`/`DEFAULT_BASELINE_PATH`/`REDTEAM_ARM_LABEL` used with identical names and signatures across T4–T10.
