# E-1 Golden Task Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx agent-harness-ja eval [taskDir]` runs a directory of golden tasks (`*.task.md` + sibling `*.oracle.mjs`) through the real harness and emits a scorecard — Markdown to stdout, canonical JSON to `.harness/eval/`.

**Architecture:** Two new eval-layer modules: `src/eval/scorecard/` (producer-agnostic schema + rendering, reused by E-2's red-team arm) and `src/eval/golden/` (task parsing, oracle loading, the session-driving runner). The CLI gains an `eval` command wiring real sessions with an in-memory DB. Spec: `process/designs/2026-07-08-e1-golden-runner.md` (review-validated; the decision log there is binding).

**Tech Stack:** TypeScript (strict, ESM, NodeNext — all relative imports use `.js` extensions), vitest, ajv 2020-12, gray-matter, better-sqlite3 (`:memory:`).

## Global Constraints

- **Layering:** eval (top) may import harness + security + internal; **nothing outside eval may import eval** except `src/cli.ts` (composition root). Enforced by eslint `no-restricted-imports` and proven in `src/layering.test.ts`.
- **House style:** factory functions with injected deps (`createGoldenRunner(deps)`); no `any` (use `unknown` + narrowing); immutability; explicit types on all exported APIs; files < 400 lines; functions < 50 lines.
- **TDD:** every task = failing test → verify fail → implement → verify pass → commit. Coverage ≥ 80% on new modules.
- **Task id pattern (spec, verbatim):** `^[a-z0-9][a-z0-9-]{0,63}$`.
- **Default `maxTurns`: 10** (mirrors `run`).
- **Exit codes (spec, verbatim):** `0` = ran, all tasks passed; `1` = ran, ≥1 row failed; `2` = run-level usage/config error.
- **`failureKind` enum (spec, verbatim):** `null | 'task-parse' | 'oracle-load' | 'session-error' | 'oracle-error' | 'oracle-fail'`.
- **No raw `resultText` ever enters a scorecard.** Every string entering a row is redacted → control-char/bidi-sanitized → truncated; fail-closed to `[REDACTION FAILED]`.
- **Golden eval never runs in per-PR CI** — do not add it to `.github/workflows`.
- All 585 existing tests must stay green after every task. Skills tests must pass **unmodified** after Task 2 (proof of pure move).
- Commits: conventional format (`feat:`, `test:`, `docs:`, `refactor:`).
- One PR to `main`, branched from `design/e1-golden-runner` (so the spec commit `98c5770` rides along).

## Deviations from the spec (record in ADR-0017)

- Spec lists `generateId?` as a runner dep; **omitted** — no scorecard field consumes an id in v1 (the JSON filename is timestamped). Add when E-3 needs run identity (YAGNI).
- `harnessVersion` is an injected runner dep (default `'0.0.0-unknown'`); the CLI reads it from `package.json` at runtime. Avoids a `rootDir`-breaking JSON import.

---

### Task 1: Branch + plan commit

**Files:**
- Create: `process/plans/2026-07-09-e1-golden-runner-implementation.md` (this file)

- [ ] **Step 1: Create the feature branch off the design branch**

```bash
cd ~/Documents/agent-harness-JA
git switch design/e1-golden-runner
git switch -c feat/eval-e1-golden-runner
```

Expected: `Switched to a new branch 'feat/eval-e1-golden-runner'` (tip `98c5770`).

- [ ] **Step 2: Commit the plan**

```bash
git add process/plans/2026-07-09-e1-golden-runner-implementation.md
git commit -m "docs: E-1 implementation plan (from review-validated design)"
```

---

### Task 2: Hoist frontmatter guards to `src/internal/frontmatter.ts`

Pure move of the anti-code-execution guards out of the skills loader so eval task files get the identical protection (spec decision #12; precedent: S-4's `settings.ts` hoist at the second consumer).

**Files:**
- Create: `src/internal/frontmatter.ts`
- Create: `src/internal/frontmatter.test.ts`
- Modify: `src/skills/load.ts` (delete moved code, import from internal)
- Test: `src/skills/load.test.ts` must pass **unmodified**

**Interfaces:**
- Produces: `MAX_FILE_BYTES: number` (1_000_000), `SAFE_MATTER_OPTIONS` (gray-matter options object), `hasUnsafeFenceLanguage(raw: string): boolean` — consumed by `src/skills/load.ts` (Task 2) and `src/eval/golden/task.ts` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `src/internal/frontmatter.test.ts`:

```typescript
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import {
  hasUnsafeFenceLanguage,
  MAX_FILE_BYTES,
  SAFE_MATTER_OPTIONS,
} from './frontmatter.js';

describe('hasUnsafeFenceLanguage', () => {
  it('accepts a plain --- fence', () => {
    expect(hasUnsafeFenceLanguage('---\nname: x\n---\nbody')).toBe(false);
  });

  it('accepts yaml/yml fence languages case-insensitively', () => {
    expect(hasUnsafeFenceLanguage('---yaml\nname: x\n---\n')).toBe(false);
    expect(hasUnsafeFenceLanguage('---YML\nname: x\n---\n')).toBe(false);
  });

  it('rejects a js fence (the gray-matter eval RCE vector)', () => {
    expect(hasUnsafeFenceLanguage('---js\n({run: eval("1")})\n---\n')).toBe(true);
  });

  it('rejects unknown fence languages', () => {
    expect(hasUnsafeFenceLanguage('---coffee\nx\n---\n')).toBe(true);
  });

  it('handles a BOM before the fence', () => {
    expect(hasUnsafeFenceLanguage('﻿---js\nx\n---\n')).toBe(true);
  });

  it('does not hang on a long dash run (ReDoS guard)', () => {
    const start = Date.now();
    hasUnsafeFenceLanguage('-'.repeat(1_000_000));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('SAFE_MATTER_OPTIONS', () => {
  it('neutralizes the javascript engine even without the fence guard', () => {
    expect(() => matter('---js\n({x: 1})\n---\n', SAFE_MATTER_OPTIONS)).toThrow(
      /non-YAML frontmatter engine is disabled/,
    );
  });
});

describe('MAX_FILE_BYTES', () => {
  it('is the shared 1MB resource-exhaustion cap', () => {
    expect(MAX_FILE_BYTES).toBe(1_000_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/internal/frontmatter.test.ts`
Expected: FAIL — `Cannot find module './frontmatter.js'`

- [ ] **Step 3: Create `src/internal/frontmatter.ts` (verbatim move from `src/skills/load.ts`)**

Move these blocks from `src/skills/load.ts` lines 26–61 (keep every comment byte-identical — this is a pure move):

```typescript
/**
 * Shared frontmatter-parsing guards (spec 2026-07-08 E-1: hoisted from the
 * skills loader at the second consumer, mirroring the settings.ts precedent).
 * Any module parsing untrusted `---`-fenced Markdown MUST use all three:
 * MAX_FILE_BYTES before read, hasUnsafeFenceLanguage before matter(), and
 * SAFE_MATTER_OPTIONS as the matter() options. Zero repo dependencies.
 */

/** Refuse to read frontmatter files larger than this (resource-exhaustion guard). */
export const MAX_FILE_BYTES = 1_000_000;

// gray-matter picks its parse engine from a language tag on the opening
// fence (`---js`, `---coffee`, ...). Its built-in `javascript` engine
// `eval()`s the frontmatter body — arbitrary code execution from an
// untrusted skill file, BEFORE schema validation ever runs. Two independent
// guards close this:
//   1. FENCE_LANGUAGE rejects any fence whose language is not empty/yaml/yml
//      before matter() is called at all.
//   2. SAFE_MATTER_OPTIONS replaces the `javascript`/`js` engines with ones
//      that throw, so no eval happens even if guard (1) is ever bypassed.
// Only YAML frontmatter is a valid skill (ADR-0006), so this loses nothing.
// Matches exactly `---` (gray-matter's delimiter), not `---+`: the greedy
// `---+` shared a `-` with the `[^\r\n]*` capture, giving O(n^2) backtracking
// on a long dash run (a ~1 MB dash file hung validate() for minutes). Exactly
// three dashes is also gray-matter's real behavior — it early-returns when the
// 4th char is another dash — so this is stricter-or-equal, never looser.
const FENCE_LANGUAGE = /^﻿?---([^\r\n]*)(?:\r?\n|$)/;

function refuseNonYaml(): never {
  throw new Error('non-YAML frontmatter engine is disabled');
}

const refuseEngine = { parse: refuseNonYaml, stringify: refuseNonYaml };

export const SAFE_MATTER_OPTIONS = {
  engines: { javascript: refuseEngine, js: refuseEngine },
} as const;

export function hasUnsafeFenceLanguage(raw: string): boolean {
  const match = FENCE_LANGUAGE.exec(raw);
  if (match === null) return false;
  const language = (match[1] ?? '').trim();
  return language !== '' && !/^ya?ml$/i.test(language);
}
```

- [ ] **Step 4: Update `src/skills/load.ts` to import from the new leaf**

Delete lines 26–61 of `src/skills/load.ts` (the `MAX_FILE_BYTES` const through `hasUnsafeFenceLanguage` function, including their comments — they now live in internal) and add to its imports:

```typescript
import {
  hasUnsafeFenceLanguage,
  MAX_FILE_BYTES,
  SAFE_MATTER_OPTIONS,
} from '../internal/frontmatter.js';
```

Leave a one-line breadcrumb where the block was:

```typescript
// Frontmatter safety guards (fence-language RCE, engine neutralization, size
// cap) are shared with the eval task parser: src/internal/frontmatter.ts.
```

- [ ] **Step 5: Run the full suite — skills tests unmodified is the proof of pure move**

Run: `npm test`
Expected: all 585 existing tests PASS + the new frontmatter tests PASS. `git diff --stat src/skills/load.test.ts` shows **no changes**.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/internal/frontmatter.ts src/internal/frontmatter.test.ts src/skills/load.ts
git commit -m "refactor: hoist frontmatter safety guards to src/internal (second consumer incoming)"
```

Note: `src/internal/**` eslint zero-dep rules already cover the new file (external deps like gray-matter are fine; the rule bans *repo* sibling imports — `frontmatter.ts` imports nothing from the repo).

---

### Task 3: Scorecard types, sanitizer, canonical JSON

**Files:**
- Create: `src/eval/scorecard/types.ts`
- Create: `src/eval/scorecard/sanitize.ts`
- Create: `src/eval/scorecard/canonical.ts`
- Create: `src/eval/scorecard/index.ts`
- Test: `src/eval/scorecard/sanitize.test.ts`, `src/eval/scorecard/canonical.test.ts`

**Interfaces:**
- Consumes: `sanitizeControlChars` from `src/internal/sanitize.js`; `RedactResult` type from `src/security/index.js`.
- Produces (consumed by Tasks 4, 6, 7, 9):
  - types: `FailureKind`, `RowVolatile`, `ScorecardRow`, `ScorecardMeta`, `ScorecardTotals`, `Scorecard`, `FAILURE_KINDS`
  - `cleanForScorecard(text: string, redactSecrets?: (t: string) => RedactResult): string`
  - `toCanonicalJson(scorecard: Scorecard): string`

- [ ] **Step 1: Write `src/eval/scorecard/types.ts`** (types-only, no test cycle of its own — exercised by every following test)

```typescript
/**
 * Scorecard schema (spec 2026-07-08 E-1, ADR-0017). The DETERMINISTIC
 * partition — rows sorted by id, each {id, pass, failureKind, reason} — is
 * the only part a future baseline diff (E-3) may compare. Everything under
 * `volatile` and `meta` is informational and never diffed: golden scorecards
 * come from live model runs and are not re-derivable byte-for-byte.
 */

export const FAILURE_KINDS = [
  'task-parse',
  'oracle-load',
  'session-error',
  'oracle-error',
  'oracle-fail',
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Volatile partition — informational, never baseline-diffed. */
export interface RowVolatile {
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  resultSubtype: string | null;
}

export interface ScorecardRow {
  id: string;
  pass: boolean;
  failureKind: FailureKind | null;
  /** Redacted, sanitized, truncated before storage — never raw model output. */
  reason: string | null;
  volatile: RowVolatile;
}

/** Volatile — informational, never baseline-diffed. */
export interface ScorecardMeta {
  /** ISO-8601, from the injected clock. */
  createdAt: string;
  harnessVersion: string;
  /** Resolved absolute task directory the run scored. */
  taskDir: string;
  /** Distinct router model choices observed across rows that ran, sorted. */
  models: string[];
}

export interface ScorecardTotals {
  tasks: number;
  passed: number;
  failed: number;
  byFailureKind: Record<FailureKind, number>;
  /** passed / tasks; tasks >= 1 is guaranteed (zero tasks is a run-level error). */
  passRate: number;
  /** Sum of known per-row costs; pair with unpricedTasks — never a silently understated sum. */
  totalCostUsd: number;
  /** Rows whose costUsd is null (didn't run, or SDK reported no cost). */
  unpricedTasks: number;
}

export interface Scorecard {
  schemaVersion: 1;
  meta: ScorecardMeta;
  /** Sorted by id (the deterministic partition's order contract). */
  rows: ScorecardRow[];
  totals: ScorecardTotals;
}
```

- [ ] **Step 2: Write the failing sanitize test**

Create `src/eval/scorecard/sanitize.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { cleanForScorecard, MAX_REASON_LENGTH } from './sanitize.js';

describe('cleanForScorecard', () => {
  it('passes plain text through', () => {
    expect(cleanForScorecard('oracle expected pong')).toBe('oracle expected pong');
  });

  it('applies the injected redactor before anything else', () => {
    const redactSecrets = (t: string) => ({
      redacted: t.replace('sk-secret', '[REDACTED:test]'),
      findings: [],
    });
    expect(cleanForScorecard('leaked sk-secret here', redactSecrets)).toBe(
      'leaked [REDACTED:test] here',
    );
  });

  it('fails closed to the sentinel when the redactor throws', () => {
    const redactSecrets = () => {
      throw new Error('boom');
    };
    expect(cleanForScorecard('anything', redactSecrets)).toBe('[REDACTION FAILED]');
  });

  it('strips control characters and bidi overrides (Trojan Source)', () => {
    const dirty = 'ok\x1b[31m‮evil⁦x⁩';
    const clean = cleanForScorecard(dirty);
    expect(clean).not.toMatch(/[\x00-\x1F‪-‮⁦-⁩]/);
  });

  it('truncates to MAX_REASON_LENGTH with an ellipsis', () => {
    const long = 'a'.repeat(MAX_REASON_LENGTH + 100);
    const clean = cleanForScorecard(long);
    expect(clean.length).toBe(MAX_REASON_LENGTH + 1); // 500 chars + ellipsis
    expect(clean.endsWith('…')).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/eval/scorecard/sanitize.test.ts`
Expected: FAIL — `Cannot find module './sanitize.js'`

- [ ] **Step 4: Write `src/eval/scorecard/sanitize.ts`**

```typescript
import type { RedactResult } from '../../security/index.js';
import { sanitizeControlChars } from '../../internal/sanitize.js';

/** Stored-reason cap; toMarkdown truncates further for table cells. */
export const MAX_REASON_LENGTH = 500;

// Bidi format/override + isolate controls (Trojan Source, CVE-2021-42574) +
// explicit marks. sanitizeControlChars covers C0/C1 but not these; the
// injection scanner's SMUGGLING_CHARS is deliberately module-private, so this
// small charset is owned here (scorecard text is a different sink contract).
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏؜]/g;

/**
 * Every string entering a scorecard row goes through this: redact (fail-closed
 * to a sentinel — spec decision #1), strip control/bidi chars, truncate.
 * The field allowlist is structural (ScorecardRow has no raw-output field);
 * this guards the fields that do exist.
 */
export function cleanForScorecard(
  text: string,
  redactSecrets?: (text: string) => RedactResult,
): string {
  let out = text;
  if (redactSecrets !== undefined) {
    try {
      out = redactSecrets(out).redacted;
    } catch {
      return '[REDACTION FAILED]';
    }
  }
  out = sanitizeControlChars(out).replace(BIDI_CONTROLS, ' ');
  return out.length > MAX_REASON_LENGTH ? `${out.slice(0, MAX_REASON_LENGTH)}…` : out;
}
```

- [ ] **Step 5: Run sanitize tests to verify they pass**

Run: `npx vitest run src/eval/scorecard/sanitize.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Write the failing canonical-JSON test**

Create `src/eval/scorecard/canonical.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { toCanonicalJson } from './canonical.js';
import type { Scorecard, ScorecardRow } from './types.js';

function row(id: string, pass: boolean): ScorecardRow {
  return {
    id,
    pass,
    failureKind: pass ? null : 'oracle-fail',
    reason: pass ? null : 'expected pong',
    volatile: { costUsd: 0.05, numTurns: 3, durationMs: 1200, resultSubtype: 'success' },
  };
}

function card(rows: ScorecardRow[]): Scorecard {
  return {
    schemaVersion: 1,
    meta: {
      createdAt: '2026-07-09T00:00:00.000Z',
      harnessVersion: '0.1.0-pre',
      taskDir: '/tmp/tasks',
      models: ['claude-sonnet-4-6'],
    },
    rows,
    totals: {
      tasks: rows.length,
      passed: rows.filter((r) => r.pass).length,
      failed: rows.filter((r) => !r.pass).length,
      byFailureKind: {
        'task-parse': 0,
        'oracle-load': 0,
        'session-error': 0,
        'oracle-error': 0,
        'oracle-fail': rows.filter((r) => !r.pass).length,
      },
      passRate: rows.filter((r) => r.pass).length / rows.length,
      totalCostUsd: 0.05 * rows.length,
      unpricedTasks: 0,
    },
  };
}

describe('toCanonicalJson', () => {
  it('is byte-identical for scorecards that differ only in key/row order', () => {
    const a = toCanonicalJson(card([row('b-task', true), row('a-task', false)]));
    const b = toCanonicalJson(card([row('a-task', false), row('b-task', true)]));
    expect(a).toBe(b);
  });

  it('sorts rows by id', () => {
    const json = toCanonicalJson(card([row('zz', true), row('aa', true)]));
    expect(json.indexOf('"aa"')).toBeLessThan(json.indexOf('"zz"'));
  });

  it('sorts object keys recursively', () => {
    const json = toCanonicalJson(card([row('a', true)]));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    const meta = parsed.meta as Record<string, unknown>;
    expect(Object.keys(meta)).toEqual([...Object.keys(meta)].sort());
  });

  it('ends with exactly one trailing newline', () => {
    const json = toCanonicalJson(card([row('a', true)]));
    expect(json.endsWith('\n')).toBe(true);
    expect(json.endsWith('\n\n')).toBe(false);
  });

  it('round-trips through JSON.parse', () => {
    const original = card([row('a', true)]);
    const parsed = JSON.parse(toCanonicalJson(original)) as Scorecard;
    expect(parsed.rows).toEqual(original.rows);
    expect(parsed.totals).toEqual(original.totals);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/eval/scorecard/canonical.test.ts`
Expected: FAIL — `Cannot find module './canonical.js'`

- [ ] **Step 8: Write `src/eval/scorecard/canonical.ts`**

```typescript
import type { Scorecard } from './types.js';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeysDeep(record[key])]),
    );
  }
  return value;
}

/**
 * Byte-stable given identical inputs (spec §scorecard): recursively sorted
 * keys, rows sorted by id (ordinal), 2-space indent, one trailing newline.
 * E-3's baseline diff depends on this stability — change only with a
 * schemaVersion bump.
 */
export function toCanonicalJson(scorecard: Scorecard): string {
  const rows = [...scorecard.rows].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return `${JSON.stringify(sortKeysDeep({ ...scorecard, rows }), null, 2)}\n`;
}
```

- [ ] **Step 9: Create the barrel `src/eval/scorecard/index.ts`**

```typescript
export { toCanonicalJson } from './canonical.js';
export { toMarkdown } from './markdown.js';
export { cleanForScorecard, MAX_REASON_LENGTH } from './sanitize.js';
export { FAILURE_KINDS } from './types.js';
export type {
  FailureKind,
  RowVolatile,
  Scorecard,
  ScorecardMeta,
  ScorecardRow,
  ScorecardTotals,
} from './types.js';
```

(The `markdown.js` line will fail typecheck until Task 4 — create `src/eval/scorecard/markdown.ts` in Task 4 *before* running typecheck, or defer the barrel's markdown line to Task 4. **Do the latter: omit the `toMarkdown` line now, add it in Task 4.**)

- [ ] **Step 10: Run tests, lint, typecheck, commit**

Run: `npx vitest run src/eval/scorecard && npm run lint && npm run typecheck`
Expected: PASS

```bash
git add src/eval/scorecard
git commit -m "feat: eval scorecard schema, row sanitizer, canonical JSON (E-1)"
```

---

### Task 4: Scorecard Markdown renderer

**Files:**
- Create: `src/eval/scorecard/markdown.ts`
- Modify: `src/eval/scorecard/index.ts` (add the `toMarkdown` export line)
- Test: `src/eval/scorecard/markdown.test.ts`

**Interfaces:**
- Consumes: `Scorecard`, `ScorecardRow`, `FAILURE_KINDS` from `./types.js`.
- Produces: `toMarkdown(scorecard: Scorecard): string` — consumed by the CLI (Task 8).

- [ ] **Step 1: Write the failing test**

Create `src/eval/scorecard/markdown.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { toMarkdown } from './markdown.js';
import type { Scorecard, ScorecardRow } from './types.js';

function makeCard(rows: ScorecardRow[], overrides?: {
  totalCostUsd?: number;
  unpricedTasks?: number;
}): Scorecard {
  const passed = rows.filter((r) => r.pass).length;
  return {
    schemaVersion: 1,
    meta: {
      createdAt: '2026-07-09T00:00:00.000Z',
      harnessVersion: '0.1.0-pre',
      taskDir: '/tmp/tasks',
      models: ['claude-sonnet-4-6'],
    },
    rows,
    totals: {
      tasks: rows.length,
      passed,
      failed: rows.length - passed,
      byFailureKind: {
        'task-parse': rows.filter((r) => r.failureKind === 'task-parse').length,
        'oracle-load': rows.filter((r) => r.failureKind === 'oracle-load').length,
        'session-error': rows.filter((r) => r.failureKind === 'session-error').length,
        'oracle-error': rows.filter((r) => r.failureKind === 'oracle-error').length,
        'oracle-fail': rows.filter((r) => r.failureKind === 'oracle-fail').length,
      },
      passRate: rows.length === 0 ? 0 : passed / rows.length,
      totalCostUsd: overrides?.totalCostUsd ?? 0.1,
      unpricedTasks: overrides?.unpricedTasks ?? 0,
    },
  };
}

const passRow: ScorecardRow = {
  id: 'hello-world',
  pass: true,
  failureKind: null,
  reason: null,
  volatile: { costUsd: 0.05, numTurns: 3, durationMs: 8200, resultSubtype: 'success' },
};

const failRow: ScorecardRow = {
  id: 'broken-task',
  pass: false,
  failureKind: 'oracle-fail',
  reason: 'expected "pong" | got\nsomething else',
  volatile: { costUsd: null, numTurns: null, durationMs: null, resultSubtype: null },
};

describe('toMarkdown', () => {
  it('renders totals BEFORE the table', () => {
    const md = toMarkdown(makeCard([passRow, failRow]));
    expect(md.indexOf('passed')).toBeLessThan(md.indexOf('| task |'));
  });

  it('renders an exact cost when every row is priced', () => {
    const md = toMarkdown(makeCard([passRow], { totalCostUsd: 0.05, unpricedTasks: 0 }));
    expect(md).toContain('$0.0500');
    expect(md).not.toContain('≥');
  });

  it('renders a lower-bound cost when rows are unpriced — never a silent understatement', () => {
    const md = toMarkdown(makeCard([passRow, failRow], { totalCostUsd: 0.05, unpricedTasks: 1 }));
    expect(md).toContain('≥ $0.0500 (1 task unpriced)');
  });

  it('escapes pipes and newlines in reason cells (Markdown injection)', () => {
    const md = toMarkdown(makeCard([failRow]));
    const tableLine = md.split('\n').find((l) => l.includes('broken-task'));
    expect(tableLine).toBeDefined();
    expect(tableLine).toContain('\\|');
    expect(tableLine).not.toContain('got\nsomething');
  });

  it('truncates long reasons to a single short cell', () => {
    const long = { ...failRow, reason: 'x'.repeat(400) };
    const md = toMarkdown(makeCard([long]));
    const tableLine = md.split('\n').find((l) => l.includes('broken-task'));
    expect(tableLine).toBeDefined();
    expect((tableLine as string).length).toBeLessThan(250);
  });

  it('lists only non-zero failure kinds in the totals', () => {
    const md = toMarkdown(makeCard([passRow, failRow]));
    expect(md).toContain('oracle-fail: 1');
    expect(md).not.toContain('task-parse: 0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/eval/scorecard/markdown.test.ts`
Expected: FAIL — `Cannot find module './markdown.js'`

- [ ] **Step 3: Write `src/eval/scorecard/markdown.ts`**

```typescript
import type { Scorecard, ScorecardRow } from './types.js';
import { FAILURE_KINDS } from './types.js';

/** Table cells stay one short line; full detail lives only in the JSON. */
const MAX_CELL_LENGTH = 120;

function escapeCell(text: string): string {
  const oneLine = text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return oneLine.length > MAX_CELL_LENGTH
    ? `${oneLine.slice(0, MAX_CELL_LENGTH)}…`
    : oneLine;
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

function rowLine(row: ScorecardRow): string {
  const result = row.pass ? 'pass' : 'FAIL';
  const kind = row.failureKind ?? '—';
  const reason = row.reason === null ? '—' : escapeCell(row.reason);
  const cost = row.volatile.costUsd === null ? 'n/a' : money(row.volatile.costUsd);
  const turns = row.volatile.numTurns === null ? 'n/a' : String(row.volatile.numTurns);
  const duration =
    row.volatile.durationMs === null
      ? 'n/a'
      : `${(row.volatile.durationMs / 1000).toFixed(1)}s`;
  return `| ${escapeCell(row.id)} | ${result} | ${kind} | ${reason} | ${cost} | ${turns} | ${duration} |`;
}

/** Totals first (spec decision #20), then the per-task table. */
export function toMarkdown(scorecard: Scorecard): string {
  const { totals, meta } = scorecard;
  const pct = (totals.passRate * 100).toFixed(1);
  const cost =
    totals.unpricedTasks === 0
      ? money(totals.totalCostUsd)
      : `≥ ${money(totals.totalCostUsd)} (${totals.unpricedTasks} task${
          totals.unpricedTasks === 1 ? '' : 's'
        } unpriced)`;
  const lines = [
    '# Golden eval scorecard',
    '',
    `- **Tasks:** ${totals.tasks} — ${totals.passed} passed / ${totals.failed} failed (pass rate ${pct}%)`,
    `- **Cost:** ${cost}`,
    `- **Created:** ${meta.createdAt} · harness v${meta.harnessVersion}`,
  ];
  const kinds = FAILURE_KINDS.filter((kind) => totals.byFailureKind[kind] > 0)
    .map((kind) => `${kind}: ${totals.byFailureKind[kind]}`)
    .join(', ');
  if (kinds !== '') lines.push(`- **Failures by kind:** ${kinds}`);
  lines.push(
    '',
    '| task | result | failure kind | reason | cost | turns | duration |',
    '|------|--------|--------------|--------|------|-------|----------|',
    ...scorecard.rows.map(rowLine),
    '',
  );
  return lines.join('\n');
}
```

- [ ] **Step 4: Add the export to `src/eval/scorecard/index.ts`**

Add: `export { toMarkdown } from './markdown.js';` (alphabetical position shown in Task 3 Step 9).

- [ ] **Step 5: Run tests, lint, typecheck, commit**

Run: `npx vitest run src/eval/scorecard && npm run lint && npm run typecheck`
Expected: PASS

```bash
git add src/eval/scorecard
git commit -m "feat: scorecard Markdown renderer — totals-first, injection-escaped cells (E-1)"
```

---

### Task 5: Task-file parser (`*.task.md`)

**Files:**
- Create: `src/eval/golden/schema.json`
- Create: `src/eval/golden/task.ts`
- Create: `src/eval/golden/__fixtures__/` (test task files)
- Test: `src/eval/golden/task.test.ts`

**Interfaces:**
- Consumes: `MAX_FILE_BYTES`, `SAFE_MATTER_OPTIONS`, `hasUnsafeFenceLanguage` (Task 2); `TaskDescriptor`, `TASK_SHAPES`, `TASK_SENSITIVITIES` from `src/router/index.js`; `sanitizeControlChars` from internal.
- Produces (consumed by the runner, Task 7):
  - `GoldenTask { id: string; prompt: string; descriptor?: TaskDescriptor; maxTurns: number; skillsDir: string; path: string; oraclePath: string }`
  - `TaskParseResult = { ok: true; value: GoldenTask } | { ok: false; rowId: string; message: string }`
  - `parseTaskFile(path: string): TaskParseResult`
  - `DEFAULT_MAX_TURNS = 10`

- [ ] **Step 1: Create test fixtures**

```bash
mkdir -p src/eval/golden/__fixtures__/valid src/eval/golden/__fixtures__/invalid
```

Create `src/eval/golden/__fixtures__/valid/hello.task.md`:

```markdown
---
id: hello
descriptor:
  shape: lookup
  sensitivity: low
  expected_tokens: 200
maxTurns: 3
---
Reply with exactly the single word: pong
```

Create `src/eval/golden/__fixtures__/valid/minimal.task.md`:

```markdown
---
id: minimal
---
Just answer.
```

Create `src/eval/golden/__fixtures__/invalid/bad-id.task.md`:

```markdown
---
id: "Has Spaces And Caps"
---
Body.
```

Create `src/eval/golden/__fixtures__/invalid/no-id.task.md`:

```markdown
---
maxTurns: 2
---
Body.
```

Create `src/eval/golden/__fixtures__/invalid/empty-body.task.md`:

```markdown
---
id: empty-body
---
```

Create `src/eval/golden/__fixtures__/invalid/bad-descriptor.task.md`:

```markdown
---
id: bad-descriptor
descriptor:
  shape: dance
  sensitivity: low
  expected_tokens: 10
---
Body.
```

Create `src/eval/golden/__fixtures__/invalid/js-fence.task.md` with EXACT content (the RCE vector — must never eval):

```markdown
---js
({ id: (() => { throw new Error('EVAL EXECUTED'); })() })
---
Body.
```

- [ ] **Step 2: Write the failing test**

Create `src/eval/golden/task.test.ts`:

```typescript
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TASK_SENSITIVITIES, TASK_SHAPES } from '../../router/index.js';
import taskSchema from './schema.json' with { type: 'json' };
import { DEFAULT_MAX_TURNS, parseTaskFile } from './task.js';

const here = dirname(fileURLToPath(import.meta.url));
const valid = (name: string) => join(here, '__fixtures__', 'valid', name);
const invalid = (name: string) => join(here, '__fixtures__', 'invalid', name);

describe('parseTaskFile', () => {
  it('parses a full task: id, descriptor, maxTurns, prompt from the body', () => {
    const result = parseTaskFile(valid('hello.task.md'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('hello');
    expect(result.value.prompt).toBe('Reply with exactly the single word: pong');
    expect(result.value.descriptor).toEqual({
      shape: 'lookup',
      sensitivity: 'low',
      expected_tokens: 200,
    });
    expect(result.value.maxTurns).toBe(3);
    expect(result.value.oraclePath).toBe(valid('hello.oracle.mjs'));
  });

  it('defaults maxTurns and skillsDir on a minimal task', () => {
    const result = parseTaskFile(valid('minimal.task.md'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(result.value.skillsDir).toBe(resolve(join(here, '__fixtures__', 'valid', 'skills')));
    expect(result.value.descriptor).toBeUndefined();
  });

  it('rejects an id that violates the pattern, keyed by the frontmatter id', () => {
    const result = parseTaskFile(invalid('bad-id.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rowId).toBe('Has Spaces And Caps');
    expect(result.message).toMatch(/id/);
  });

  it('rejects a missing id, keyed by the file basename (stable fallback)', () => {
    const result = parseTaskFile(invalid('no-id.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rowId).toBe('no-id.task.md');
    expect(result.message).toMatch(/id/);
  });

  it('rejects an empty prompt body', () => {
    const result = parseTaskFile(invalid('empty-body.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/prompt|body/i);
  });

  it('rejects an invalid descriptor at parse time (not a mid-session TypeError)', () => {
    const result = parseTaskFile(invalid('bad-descriptor.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/descriptor|shape/);
  });

  it('refuses a js frontmatter fence WITHOUT executing it (RCE guard)', () => {
    const result = parseTaskFile(invalid('js-fence.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/YAML/i);
    expect(result.message).not.toMatch(/EVAL EXECUTED/);
  });

  it('returns a read error for a missing file', () => {
    const result = parseTaskFile(invalid('does-not-exist.task.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rowId).toBe('does-not-exist.task.md');
  });
});

describe('schema/router lockstep', () => {
  // The descriptor enums are hand-copied into schema.json (a JSON import
  // widens value types, so a compile-time guard can't see them). This test is
  // the drift guard.
  it('descriptor enums match the router constants exactly', () => {
    const descriptor = taskSchema.properties.descriptor;
    expect(descriptor.properties.shape.enum).toEqual([...TASK_SHAPES]);
    expect(descriptor.properties.sensitivity.enum).toEqual([...TASK_SENSITIVITIES]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/eval/golden/task.test.ts`
Expected: FAIL — `Cannot find module './schema.json'`

- [ ] **Step 4: Create `src/eval/golden/schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/jacksonanstee/agent-harness-JA/blob/main/src/eval/golden/schema.json",
  "title": "Golden task frontmatter",
  "type": "object",
  "additionalProperties": false,
  "required": ["id"],
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^[a-z0-9][a-z0-9-]{0,63}$"
    },
    "descriptor": {
      "type": "object",
      "additionalProperties": false,
      "required": ["shape", "sensitivity", "expected_tokens"],
      "properties": {
        "shape": { "enum": ["review", "build", "research", "lookup"] },
        "sensitivity": { "enum": ["low", "medium", "high"] },
        "expected_tokens": { "type": "integer", "minimum": 0 },
        "hint": { "type": "string", "minLength": 1 }
      }
    },
    "maxTurns": { "type": "integer", "minimum": 1 },
    "skillsDir": { "type": "string", "minLength": 1 }
  }
}
```

- [ ] **Step 5: Write `src/eval/golden/task.ts`**

```typescript
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import matter from 'gray-matter';
import taskSchema from './schema.json' with { type: 'json' };
import type { TaskDescriptor } from '../../router/index.js';
import {
  hasUnsafeFenceLanguage,
  MAX_FILE_BYTES,
  SAFE_MATTER_OPTIONS,
} from '../../internal/frontmatter.js';
import { sanitizeControlChars as sanitize } from '../../internal/sanitize.js';

const ajv = new Ajv2020({ allErrors: true });
const validateFrontmatter = ajv.compile(taskSchema);

export const DEFAULT_MAX_TURNS = 10;

interface TaskFrontmatter {
  id: string;
  descriptor?: TaskDescriptor;
  maxTurns?: number;
  skillsDir?: string;
}

// Compile-time parity guard between schema.json and TaskFrontmatter keys
// (same pattern as src/skills/load.ts). Enum VALUES are runtime-guarded by
// the schema/router lockstep test — JSON imports widen literal values.
type KeysMatch<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
true satisfies KeysMatch<keyof typeof taskSchema.properties, keyof TaskFrontmatter>;

export interface GoldenTask {
  id: string;
  /** The Markdown body below the frontmatter, trimmed. */
  prompt: string;
  descriptor?: TaskDescriptor;
  maxTurns: number;
  /** Resolved absolute; default `<task file dir>/skills` (spec decision #25). */
  skillsDir: string;
  /** Absolute path of the source file. */
  path: string;
  /** Sibling `<name>.oracle.mjs`, derived — existence checked at load time. */
  oraclePath: string;
}

export type TaskParseResult =
  | { ok: true; value: GoldenTask }
  | { ok: false; rowId: string; message: string };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Row key for a failed parse (spec: arbiter condition 1): the frontmatter id
 * when one is extractable, else the file's basename — stable either way.
 */
function fallbackRowId(data: unknown, path: string): string {
  if (data !== null && typeof data === 'object') {
    const id = (data as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return sanitize(id).slice(0, 64);
  }
  return basename(path);
}

// Second copy of the skills loader's failingField pattern; extract to
// src/internal on a third consumer (the settings.ts / frontmatter.ts rule).
function failingField(): string | undefined {
  const errors = validateFrontmatter.errors ?? [];
  const unknownKey = errors.find((e) => e.keyword === 'additionalProperties');
  if (unknownKey) {
    const extra = (unknownKey.params as { additionalProperty: string }).additionalProperty;
    return `${unknownKey.instancePath}/${extra}`;
  }
  const first = errors[0];
  if (!first) return undefined;
  if (first.keyword === 'required') {
    const missing = (first.params as { missingProperty: string }).missingProperty;
    return `${first.instancePath}/${missing}`;
  }
  return first.instancePath || undefined;
}

export function parseTaskFile(file: string): TaskParseResult {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError(`file must be a non-empty string, got ${String(file)}`);
  }
  const path = resolve(file);
  const fail = (rowId: string, message: string): TaskParseResult => ({
    ok: false,
    rowId: sanitize(rowId),
    message: sanitize(message),
  });

  let raw: string;
  try {
    const { size } = statSync(path);
    if (size > MAX_FILE_BYTES) {
      return fail(basename(path), `task file exceeds ${MAX_FILE_BYTES} bytes (got ${size})`);
    }
    raw = readFileSync(path, 'utf8');
  } catch (cause: unknown) {
    return fail(basename(path), errorMessage(cause));
  }

  if (hasUnsafeFenceLanguage(raw)) {
    return fail(
      basename(path),
      'frontmatter must be YAML; non-YAML fence language is refused',
    );
  }

  let parsed: { data: unknown; content: string };
  try {
    parsed = matter(raw, SAFE_MATTER_OPTIONS);
  } catch (cause: unknown) {
    return fail(basename(path), errorMessage(cause));
  }

  if (!validateFrontmatter(parsed.data)) {
    const field = failingField();
    const detail = ajv.errorsText(validateFrontmatter.errors);
    return fail(
      fallbackRowId(parsed.data, path),
      field === undefined ? detail : `${field}: ${detail}`,
    );
  }

  // Safe: just validated against the schema whose keys the compile-time
  // guard pins to this type; descriptor enums are pinned by the lockstep test.
  const frontmatter = parsed.data as TaskFrontmatter;

  const prompt = parsed.content.trim();
  if (prompt === '') {
    return fail(frontmatter.id, 'task body (the prompt) is empty');
  }

  const taskFileDir = dirname(path);
  return {
    ok: true,
    value: {
      id: frontmatter.id,
      prompt,
      ...(frontmatter.descriptor !== undefined && { descriptor: frontmatter.descriptor }),
      maxTurns: frontmatter.maxTurns ?? DEFAULT_MAX_TURNS,
      skillsDir: resolve(taskFileDir, frontmatter.skillsDir ?? 'skills'),
      path,
      oraclePath: join(taskFileDir, `${basename(path, '.task.md')}.oracle.mjs`),
    },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/eval/golden/task.test.ts`
Expected: PASS (10 tests). Also run `npm test` — full suite green.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/eval/golden
git commit -m "feat: golden task-file parser — hardened frontmatter, parse-time descriptor validation (E-1)"
```

---

### Task 6: Oracle loader + verdict validation

**Files:**
- Create: `src/eval/golden/oracle.ts`
- Create: `src/eval/golden/__fixtures__/oracles/` (fixture oracle modules)
- Test: `src/eval/golden/oracle.test.ts`

**Interfaces:**
- Consumes: `SessionResult` type from `src/session/index.js`.
- Produces (consumed by the runner, Task 7, and exported from the package for task authors):
  - `OracleVerdict { pass: boolean; reason?: string }`
  - `OracleFn = (result: SessionResult) => OracleVerdict | Promise<OracleVerdict>`
  - `LoadOracleFn = (path: string) => Promise<OracleFn>`
  - `loadOracle(path: string): Promise<OracleFn>` — throws on missing/invalid module
  - `validateVerdict(value: unknown): OracleVerdict` — throws on shape violation (strict boolean, no truthy coercion)

- [ ] **Step 1: Create fixture oracle modules**

```bash
mkdir -p src/eval/golden/__fixtures__/oracles
```

Create `src/eval/golden/__fixtures__/oracles/good.oracle.mjs`:

```javascript
export const oracle = (result) => ({
  pass: result.resultSubtype === 'success',
  reason: 'checked subtype',
});
```

Create `src/eval/golden/__fixtures__/oracles/no-export.oracle.mjs`:

```javascript
export const somethingElse = () => ({ pass: true });
```

Create `src/eval/golden/__fixtures__/oracles/not-a-function.oracle.mjs`:

```javascript
export const oracle = { pass: true };
```

Create `src/eval/golden/__fixtures__/oracles/throws-on-import.oracle.mjs`:

```javascript
throw new Error('hostile import');
```

- [ ] **Step 2: Write the failing test**

Create `src/eval/golden/oracle.test.ts`:

```typescript
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadOracle, validateVerdict } from './oracle.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, '__fixtures__', 'oracles', name);

describe('loadOracle', () => {
  it('loads a module with a named oracle function export', async () => {
    const oracle = await loadOracle(fixture('good.oracle.mjs'));
    expect(typeof oracle).toBe('function');
  });

  it('rejects a module without an oracle export', async () => {
    await expect(loadOracle(fixture('no-export.oracle.mjs'))).rejects.toThrow(
      /named export 'oracle'/,
    );
  });

  it('rejects an oracle export that is not a function', async () => {
    await expect(loadOracle(fixture('not-a-function.oracle.mjs'))).rejects.toThrow(
      /named export 'oracle'/,
    );
  });

  it('surfaces a module that throws at import time', async () => {
    await expect(loadOracle(fixture('throws-on-import.oracle.mjs'))).rejects.toThrow(
      /hostile import/,
    );
  });

  it('surfaces a missing oracle file', async () => {
    await expect(loadOracle(fixture('missing.oracle.mjs'))).rejects.toThrow();
  });
});

describe('validateVerdict', () => {
  it('accepts { pass: true }', () => {
    expect(validateVerdict({ pass: true })).toEqual({ pass: true });
  });

  it('accepts { pass: false, reason }', () => {
    expect(validateVerdict({ pass: false, reason: 'nope' })).toEqual({
      pass: false,
      reason: 'nope',
    });
  });

  it('rejects truthy coercion — a broken oracle must never silently pass', () => {
    expect(() => validateVerdict({ pass: 1 })).toThrow(/strict boolean/);
    expect(() => validateVerdict({ pass: 'true' })).toThrow(/strict boolean/);
  });

  it('rejects a missing pass field, null, and non-objects', () => {
    expect(() => validateVerdict({})).toThrow(/strict boolean/);
    expect(() => validateVerdict(null)).toThrow(/must return an object/);
    expect(() => validateVerdict(undefined)).toThrow(/must return an object/);
    expect(() => validateVerdict('pass')).toThrow(/must return an object/);
  });

  it('rejects a non-string reason', () => {
    expect(() => validateVerdict({ pass: true, reason: 42 })).toThrow(/reason/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/eval/golden/oracle.test.ts`
Expected: FAIL — `Cannot find module './oracle.js'`

- [ ] **Step 4: Write `src/eval/golden/oracle.ts`**

```typescript
import { pathToFileURL } from 'node:url';
import type { SessionResult } from '../../session/index.js';

export interface OracleVerdict {
  pass: boolean;
  reason?: string;
}

/**
 * The task author's contract: pure, deterministic, no model calls, no I/O.
 * Judges the SessionResult surface only (final text, resultSubtype, denied[],
 * usage) — not filesystem side effects (ADR-0017 named limitation). Author
 * `.mjs` oracles with: @type {import('agent-harness-ja').OracleFn}
 */
export type OracleFn = (result: SessionResult) => OracleVerdict | Promise<OracleVerdict>;

export type LoadOracleFn = (path: string) => Promise<OracleFn>;

/**
 * Dynamic-imports the sibling oracle module (file URL — Windows-safe). This
 * executes arbitrary in-process code from the task directory: security-model
 * R-10; the CLI warns before the first load. ESM caches by path — irrelevant
 * for the one-shot CLI, relevant if a watch mode ever lands.
 */
export async function loadOracle(path: string): Promise<OracleFn> {
  const mod: unknown = await import(pathToFileURL(path).href);
  const oracle = (mod as Record<string, unknown>).oracle;
  if (typeof oracle !== 'function') {
    throw new Error(`oracle module must have a named export 'oracle' that is a function: ${path}`);
  }
  return oracle as OracleFn;
}

/**
 * Boundary validation of an oracle's return value. Strict: `pass` must be a
 * real boolean (truthy coercion rejected — a broken oracle that returns
 * objects/strings must never silently pass everything), `reason` if present
 * must be a string.
 */
export function validateVerdict(value: unknown): OracleVerdict {
  if (value === null || typeof value !== 'object') {
    throw new Error(`oracle must return an object { pass: boolean }, got ${typeof value}`);
  }
  const pass = (value as { pass?: unknown }).pass;
  if (typeof pass !== 'boolean') {
    throw new Error(
      `oracle must return a strict boolean 'pass' (truthy coercion is rejected), got ${typeof pass}`,
    );
  }
  const reason = (value as { reason?: unknown }).reason;
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error(`oracle 'reason' must be a string when present, got ${typeof reason}`);
  }
  return reason === undefined ? { pass } : { pass, reason };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/eval/golden/oracle.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/eval/golden
git commit -m "feat: oracle loader with strict verdict boundary validation (E-1)"
```

---

### Task 7: The golden runner

**Files:**
- Create: `src/eval/golden/runner.ts`
- Create: `src/eval/golden/index.ts`
- Create: `src/eval/index.ts`
- Modify: `src/index.ts`
- Test: `src/eval/golden/runner.test.ts`
- Fixtures: add `src/eval/golden/__fixtures__/run/` (a runnable task dir)

**Interfaces:**
- Consumes: `parseTaskFile`, `GoldenTask`, `DEFAULT_MAX_TURNS` (Task 5); `loadOracle`, `validateVerdict`, `OracleFn`, `LoadOracleFn` (Task 6); scorecard types + `cleanForScorecard` (Task 3); `Session`, `SessionResult` from session; `TaskDescriptor` from router; `RedactResult` from security.
- Produces (consumed by the CLI, Task 9):
  - `EvalUsageError` (class) — run-level errors, maps to exit 2
  - `TaskSessionConfig { skillsDir: string; descriptor?: TaskDescriptor; maxTurns: number }`
  - `GoldenRunnerDeps { createTaskSession: (config: TaskSessionConfig) => Session; redactSecrets?: (text: string) => RedactResult; loadOracle?: LoadOracleFn; now?: () => number; harnessVersion?: string }`
  - `RunOptions { onProgress?: (line: string) => void }`
  - `GoldenRunner { run(taskDir: string, opts?: RunOptions): Promise<Scorecard> }`
  - `createGoldenRunner(deps: GoldenRunnerDeps): GoldenRunner`

- [ ] **Step 1: Create the runnable fixture dir**

Create `src/eval/golden/__fixtures__/run/alpha.task.md`:

```markdown
---
id: alpha
maxTurns: 2
---
Say alpha.
```

Create `src/eval/golden/__fixtures__/run/alpha.oracle.mjs`:

```javascript
export const oracle = (result) => ({
  pass: (result.resultText ?? '').includes('alpha'),
  reason: 'expected alpha in the reply',
});
```

Create `src/eval/golden/__fixtures__/run/beta.task.md`:

```markdown
---
id: beta
---
Say beta.
```

Create `src/eval/golden/__fixtures__/run/beta.oracle.mjs`:

```javascript
export const oracle = () => ({ pass: false, reason: 'beta always fails' });
```

Create `src/eval/golden/__fixtures__/run/broken.task.md` (no id — parse-fail row):

```markdown
---
maxTurns: 1
---
Body.
```

Create `src/eval/golden/__fixtures__/dup/one.task.md` and `src/eval/golden/__fixtures__/dup/two.task.md`, both with `id: same-id` in frontmatter and body `Body.` — duplicate-id run-level fixture. Also `src/eval/golden/__fixtures__/dup/one.oracle.mjs` and `two.oracle.mjs` each containing `export const oracle = () => ({ pass: true });`

Create `src/eval/golden/__fixtures__/empty/.gitkeep` (empty dir — zero-tasks fixture):

```bash
mkdir -p src/eval/golden/__fixtures__/empty && touch src/eval/golden/__fixtures__/empty/.gitkeep
```

- [ ] **Step 2: Write the failing test**

Create `src/eval/golden/runner.test.ts`:

```typescript
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Session, SessionResult } from '../../session/index.js';
import { createGoldenRunner, EvalUsageError } from './runner.js';
import type { TaskSessionConfig } from './runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = (name: string) => join(here, '__fixtures__', name);

function fakeResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    resultText: 'alpha and beta',
    resultSubtype: 'success',
    sessionId: 's-1',
    modelChoice: { model: 'claude-sonnet-4-6', rule_id: 'r1', reason: 'test' },
    usage: null,
    costUsd: 0.01,
    numTurns: 2,
    denied: [],
    memoryEntryId: null,
    skillErrors: [],
    ...overrides,
  };
}

function fakeSessionFactory(
  results: SessionResult | ((config: TaskSessionConfig) => SessionResult),
  calls: TaskSessionConfig[] = [],
) {
  return (config: TaskSessionConfig): Session => {
    calls.push(config);
    return {
      run: () =>
        Promise.resolve(typeof results === 'function' ? results(config) : results),
    };
  };
}

// A deterministic fake clock: each call advances 100ms.
function fakeNow(): () => number {
  let t = 1_750_000_000_000;
  return () => (t += 100);
}

describe('createGoldenRunner run-level errors (exit-2 class)', () => {
  const deps = { createTaskSession: fakeSessionFactory(fakeResult()), now: fakeNow() };

  it('throws EvalUsageError for a missing task dir', async () => {
    const runner = createGoldenRunner(deps);
    await expect(runner.run(fixtures('nope'))).rejects.toThrow(EvalUsageError);
  });

  it('throws EvalUsageError when the dir has zero *.task.md files', async () => {
    const runner = createGoldenRunner(deps);
    await expect(runner.run(fixtures('empty'))).rejects.toThrow(/no \*\.task\.md/);
  });

  it('throws EvalUsageError on duplicate ids across files — before any session runs', async () => {
    const calls: TaskSessionConfig[] = [];
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult(), calls),
      now: fakeNow(),
    });
    await expect(runner.run(fixtures('dup'))).rejects.toThrow(/duplicate task id/);
    expect(calls).toHaveLength(0); // no spend before the dup check
  });
});

describe('createGoldenRunner rows', () => {
  it('scores pass/fail/parse-fail rows and keeps going (per-task isolation)', async () => {
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      now: fakeNow(),
      harnessVersion: '0.1.0-test',
    });
    const scorecard = await runner.run(fixtures('run'));

    expect(scorecard.schemaVersion).toBe(1);
    expect(scorecard.rows.map((r) => r.id)).toEqual(['alpha', 'beta', 'broken.task.md']);

    const alpha = scorecard.rows[0];
    expect(alpha?.pass).toBe(true);
    expect(alpha?.failureKind).toBeNull();
    expect(alpha?.volatile.costUsd).toBe(0.01);
    expect(alpha?.volatile.durationMs).not.toBeNull();

    const beta = scorecard.rows[1];
    expect(beta?.pass).toBe(false);
    expect(beta?.failureKind).toBe('oracle-fail');
    expect(beta?.reason).toBe('beta always fails');

    const broken = scorecard.rows[2];
    expect(broken?.pass).toBe(false);
    expect(broken?.failureKind).toBe('task-parse');
    expect(broken?.volatile.costUsd).toBeNull();

    expect(scorecard.totals).toEqual({
      tasks: 3,
      passed: 1,
      failed: 2,
      byFailureKind: {
        'task-parse': 1,
        'oracle-load': 0,
        'session-error': 0,
        'oracle-error': 0,
        'oracle-fail': 1,
      },
      passRate: 1 / 3,
      totalCostUsd: 0.02,
      unpricedTasks: 1,
    });
    expect(scorecard.meta.harnessVersion).toBe('0.1.0-test');
    expect(scorecard.meta.models).toEqual(['claude-sonnet-4-6']);
  });

  it('threads task config into the session factory', async () => {
    const calls: TaskSessionConfig[] = [];
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult(), calls),
      now: fakeNow(),
    });
    await runner.run(fixtures('run'));
    expect(calls[0]?.maxTurns).toBe(2); // alpha's frontmatter
    expect(calls[1]?.maxTurns).toBe(10); // beta defaults
    expect(calls[0]?.skillsDir).toBe(join(fixtures('run'), 'skills'));
  });

  it('turns a session throw into a session-error row and keeps going', async () => {
    const runner = createGoldenRunner({
      createTaskSession: () => ({
        run: () => Promise.reject(new Error('SDK exploded')),
      }),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    const alpha = scorecard.rows.find((r) => r.id === 'alpha');
    expect(alpha?.failureKind).toBe('session-error');
    expect(alpha?.reason).toContain('SDK exploded');
    expect(scorecard.rows).toHaveLength(3);
  });

  it('turns an oracle throw into an oracle-error row', async () => {
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      loadOracle: () => Promise.resolve(() => {
        throw new Error('oracle bug');
      }),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    const alpha = scorecard.rows.find((r) => r.id === 'alpha');
    expect(alpha?.failureKind).toBe('oracle-error');
    expect(alpha?.reason).toContain('oracle bug');
  });

  it('turns a truthy-but-not-boolean verdict into an oracle-error row', async () => {
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      loadOracle: () =>
        Promise.resolve((() => ({ pass: 1 })) as unknown as () => { pass: boolean }),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    const alpha = scorecard.rows.find((r) => r.id === 'alpha');
    expect(alpha?.failureKind).toBe('oracle-error');
  });

  it('turns an unloadable oracle into an oracle-load row WITHOUT running a session', async () => {
    const calls: TaskSessionConfig[] = [];
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult(), calls),
      loadOracle: () => Promise.reject(new Error('no such oracle')),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    expect(scorecard.rows.find((r) => r.id === 'alpha')?.failureKind).toBe('oracle-load');
    expect(calls).toHaveLength(0); // oracle load precedes spend
  });

  it('redacts reasons through the injected redactor', async () => {
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      loadOracle: () =>
        Promise.resolve(() => ({ pass: false, reason: 'leaked sk-secret' })),
      redactSecrets: (t) => ({ redacted: t.replace('sk-secret', '[REDACTED]'), findings: [] }),
      now: fakeNow(),
    });
    const scorecard = await runner.run(fixtures('run'));
    const alpha = scorecard.rows.find((r) => r.id === 'alpha');
    expect(alpha?.reason).toBe('leaked [REDACTED]');
  });

  it('emits progress lines: discovery first, then one per task', async () => {
    const lines: string[] = [];
    const runner = createGoldenRunner({
      createTaskSession: fakeSessionFactory(fakeResult()),
      now: fakeNow(),
    });
    await runner.run(fixtures('run'), { onProgress: (l) => lines.push(l) });
    expect(lines[0]).toMatch(/discovered 3 tasks/);
    expect(lines[1]).toMatch(/^\[1\/3\] alpha … pass/);
    expect(lines[2]).toMatch(/^\[2\/3\] beta … fail \(oracle-fail\)/);
    expect(lines[3]).toMatch(/^\[3\/3\] broken\.task\.md … fail \(task-parse\)/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/eval/golden/runner.test.ts`
Expected: FAIL — `Cannot find module './runner.js'`

- [ ] **Step 4: Write `src/eval/golden/runner.ts`**

```typescript
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TaskDescriptor } from '../../router/index.js';
import type { RedactResult } from '../../security/index.js';
import type { Session, SessionResult } from '../../session/index.js';
import type {
  FailureKind,
  Scorecard,
  ScorecardRow,
  ScorecardTotals,
} from '../scorecard/index.js';
import { cleanForScorecard, FAILURE_KINDS } from '../scorecard/index.js';
import type { LoadOracleFn } from './oracle.js';
import { loadOracle as defaultLoadOracle, validateVerdict } from './oracle.js';
import type { TaskParseResult } from './task.js';
import { parseTaskFile } from './task.js';

/** Run-level usage/config errors (spec: arbiter condition 1) — CLI exit 2. */
export class EvalUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalUsageError';
  }
}

export interface TaskSessionConfig {
  skillsDir: string;
  descriptor?: TaskDescriptor;
  maxTurns: number;
}

export interface GoldenRunnerDeps {
  /** Composition root wires the real createSession; tests inject fakes. */
  createTaskSession: (config: TaskSessionConfig) => Session;
  /** Every string entering a scorecard row passes through this (spec decision #1). */
  redactSecrets?: (text: string) => RedactResult;
  /** Injectable for error-path tests; defaults to the real dynamic import. */
  loadOracle?: LoadOracleFn;
  /** Injected clock (epoch ms) for deterministic tests. */
  now?: () => number;
  harnessVersion?: string;
}

export interface RunOptions {
  /** Per-task progress hook (the CLI writes these to stderr). */
  onProgress?: (line: string) => void;
}

export interface GoldenRunner {
  run(taskDir: string, opts?: RunOptions): Promise<Scorecard>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function emptyVolatile(): ScorecardRow['volatile'] {
  return { costUsd: null, numTurns: null, durationMs: null, resultSubtype: null };
}

function discoverTaskFiles(root: string): string[] {
  let entries;
  try {
    if (!statSync(root).isDirectory()) {
      throw new EvalUsageError(`not a directory: ${root}`);
    }
    entries = readdirSync(root, { withFileTypes: true });
  } catch (cause: unknown) {
    if (cause instanceof EvalUsageError) throw cause;
    throw new EvalUsageError(`cannot read task directory ${root}: ${errorMessage(cause)}`);
  }
  // Non-recursive in v1; ordinal sort for platform-independent row order.
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.task.md'))
    .map((e) => join(root, e.name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (files.length === 0) {
    throw new EvalUsageError(`no *.task.md files found in ${root}`);
  }
  return files;
}

/** Duplicate row ids make the scorecard ambiguous — run-level, before any spend. */
function assertUniqueIds(parses: TaskParseResult[]): void {
  const seen = new Set<string>();
  for (const parse of parses) {
    const id = parse.ok ? parse.value.id : parse.rowId;
    if (seen.has(id)) {
      throw new EvalUsageError(`duplicate task id '${id}' across task files`);
    }
    seen.add(id);
  }
}

function computeTotals(rows: ScorecardRow[]): ScorecardTotals {
  const byFailureKind = Object.fromEntries(
    FAILURE_KINDS.map((kind) => [kind, rows.filter((r) => r.failureKind === kind).length]),
  ) as Record<FailureKind, number>;
  const passed = rows.filter((r) => r.pass).length;
  const priced = rows.filter((r) => r.volatile.costUsd !== null);
  return {
    tasks: rows.length,
    passed,
    failed: rows.length - passed,
    byFailureKind,
    passRate: passed / rows.length,
    totalCostUsd: priced.reduce((sum, r) => sum + (r.volatile.costUsd ?? 0), 0),
    unpricedTasks: rows.length - priced.length,
  };
}

export function createGoldenRunner(deps: GoldenRunnerDeps): GoldenRunner {
  const loadOracle = deps.loadOracle ?? defaultLoadOracle;
  const now = deps.now ?? Date.now;
  const harnessVersion = deps.harnessVersion ?? '0.0.0-unknown';
  const clean = (text: string): string => cleanForScorecard(text, deps.redactSecrets);

  const failRow = (id: string, kind: FailureKind, reason: string): ScorecardRow => ({
    id,
    pass: false,
    failureKind: kind,
    reason: clean(reason),
    volatile: emptyVolatile(),
  });

  // Sequential per-task execution with error isolation: any catchable failure
  // becomes a row with the right failureKind and the run continues.
  const scoreTask = async (parse: TaskParseResult): Promise<ScorecardRow> => {
    if (!parse.ok) return failRow(parse.rowId, 'task-parse', parse.message);
    const task = parse.value;

    // Oracle load precedes the session run: a broken oracle must not spend.
    let oracle;
    try {
      oracle = await loadOracle(task.oraclePath);
    } catch (cause: unknown) {
      return failRow(task.id, 'oracle-load', errorMessage(cause));
    }

    const startedAt = now();
    let result: SessionResult;
    try {
      const session = deps.createTaskSession({
        skillsDir: task.skillsDir,
        ...(task.descriptor !== undefined && { descriptor: task.descriptor }),
        maxTurns: task.maxTurns,
      });
      result = await session.run(task.prompt);
    } catch (cause: unknown) {
      const row = failRow(task.id, 'session-error', errorMessage(cause));
      return { ...row, volatile: { ...row.volatile, durationMs: now() - startedAt } };
    }
    const volatile = {
      costUsd: result.costUsd,
      numTurns: result.numTurns,
      durationMs: now() - startedAt,
      resultSubtype: result.resultSubtype,
    };

    try {
      const verdict = validateVerdict(await oracle(result));
      return {
        id: task.id,
        pass: verdict.pass,
        failureKind: verdict.pass ? null : 'oracle-fail',
        reason: verdict.reason === undefined ? null : clean(verdict.reason),
        volatile,
      };
    } catch (cause: unknown) {
      const row = failRow(task.id, 'oracle-error', errorMessage(cause));
      return { ...row, volatile };
    }
  };

  return {
    async run(taskDir: string, opts: RunOptions = {}): Promise<Scorecard> {
      if (typeof taskDir !== 'string' || taskDir.length === 0) {
        throw new EvalUsageError('taskDir must be a non-empty string');
      }
      const root = resolve(taskDir);
      const files = discoverTaskFiles(root);
      const parses = files.map(parseTaskFile);
      assertUniqueIds(parses);
      opts.onProgress?.(
        `discovered ${parses.length} task${parses.length === 1 ? '' : 's'} in ${root}`,
      );

      const rows: ScorecardRow[] = [];
      const models = new Set<string>();
      const createdAt = new Date(now()).toISOString();
      for (const [index, parse] of parses.entries()) {
        const row = await scoreTask(parse);
        rows.push(row);
        const cost =
          row.volatile.costUsd === null ? '' : ` ($${row.volatile.costUsd.toFixed(4)})`;
        const outcome = row.pass ? `pass${cost}` : `fail (${row.failureKind ?? 'unknown'})${cost}`;
        opts.onProgress?.(`[${index + 1}/${parses.length}] ${row.id} … ${outcome}`);
      }
      // meta.models: collected from rows via resultSubtype presence is not
      // enough — the session factory owns model choice, so collect from the
      // scoreTask closure would leak; instead the volatile partition carries
      // no model per row, and meta.models is filled by the CLI? No — keep it
      // simple: models are volatile meta; see note below.
      void models;

      const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        schemaVersion: 1,
        meta: { createdAt, harnessVersion, taskDir: root, models: [] },
        rows: sorted,
        totals: computeTotals(sorted),
      };
    },
  };
}
```

**Correction to fold in while implementing (the spec requires `meta.models` — model choices):** capture models inside `scoreTask` by returning `{ row, model }` — the session result's `modelChoice.model` when the session ran, else `null` — and build `models: [...new Set(nonNull)].sort()`. Delete the `void models` placeholder and the dead comment above it; the test in Step 2 asserts `meta.models` equals `['claude-sonnet-4-6']`, so the placeholder version FAILS that assertion — this correction is not optional. Concretely: change `scoreTask` to `async (parse): Promise<{ row: ScorecardRow; model: string | null }>` where the success path returns `{ row, model: result.modelChoice.model }` and every failure path returns `{ row, model: null }` (session-error ran a session but has no result — `null`).

- [ ] **Step 5: Run tests until green**

Run: `npx vitest run src/eval/golden/runner.test.ts`
Expected: PASS (11 tests). If `meta.models` fails, apply the Step 4 correction.

- [ ] **Step 6: Create the barrels and package export**

Create `src/eval/golden/index.ts`:

```typescript
export { loadOracle, validateVerdict } from './oracle.js';
export type { LoadOracleFn, OracleFn, OracleVerdict } from './oracle.js';
export {
  createGoldenRunner,
  EvalUsageError,
} from './runner.js';
export type {
  GoldenRunner,
  GoldenRunnerDeps,
  RunOptions,
  TaskSessionConfig,
} from './runner.js';
export { DEFAULT_MAX_TURNS, parseTaskFile } from './task.js';
export type { GoldenTask, TaskParseResult } from './task.js';
```

Create `src/eval/index.ts`:

```typescript
export * from './golden/index.js';
export * from './scorecard/index.js';
```

Modify `src/index.ts` — add the eval layer to the public API:

```typescript
export * from './router/index.js';
export * from './skills/index.js';
export * from './hooks/index.js';
export * from './memory/index.js';
export * from './session/index.js';
export * from './eval/index.js';
```

- [ ] **Step 7: Full suite, lint, typecheck, commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS

```bash
git add src/eval src/index.ts
git commit -m "feat: golden task runner — per-task isolation, failureKind rows, deterministic totals (E-1)"
```

---

### Task 8: Layering enforcement (eslint globstar + tests)

**Files:**
- Modify: `eslint.config.js`
- Modify: `src/layering.test.ts`

**Interfaces:**
- Consumes: existing eslint block structure.
- Produces: `**/eval/**` + `**/eval` bans in every non-eval block; a new `src/session/**` block; `src/cli.ts` remains uncovered (composition-root exemption).

- [ ] **Step 1: Write the failing layering tests**

Append to the `describe('eslint layering rules', ...)` block in `src/layering.test.ts`:

```typescript
  it('blocks a leaf module importing the eval layer via a NESTED path (globstar)', async () => {
    const violations = await lintViolations(
      'src/telemetry/bad-import.ts',
      "import { createGoldenRunner } from '../eval/golden/runner.js';\ncreateGoldenRunner;\n",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('blocks the session orchestrator importing eval', async () => {
    const violations = await lintViolations(
      'src/session/bad-import.ts',
      "import { createGoldenRunner } from '../eval/golden/runner.js';\ncreateGoldenRunner;\n",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('blocks security importing eval via a nested path', async () => {
    const violations = await lintViolations(
      'src/security/injection/bad-import.ts',
      "import { toCanonicalJson } from '../../eval/scorecard/canonical.js';\ntoCanonicalJson;\n",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('allows eval importing session and security (top of the dependency order)', async () => {
    const violations = await lintViolations(
      'src/eval/golden/good-import.ts',
      "import { createSession } from '../../session/index.js';\nimport { redact } from '../../security/index.js';\ncreateSession;\nredact;\n",
    );
    expect(violations).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run src/layering.test.ts`
Expected: the three `blocks ...` tests FAIL (no eval patterns configured yet); the `allows eval` test passes.

- [ ] **Step 3: Update `eslint.config.js`**

Add `'**/eval/**', '**/eval',` to the `patterns` array of ALL FOUR existing `no-restricted-imports` blocks (leaf modules, internal, telemetry, security — for security, replace its existing `'**/eval/*'` with `'**/eval/**'`). Then add a new block after the security block:

```javascript
  // Session is the harness orchestrator: below eval, above the leaves. It
  // must not import the eval layer (which drives IT) or the CLI. The CLI
  // (src/cli.ts) is the composition root and is deliberately exempt from all
  // layering blocks — it wires every layer together.
  {
    files: ['src/session/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['**/eval/**', '**/eval', '**/cli', '**/cli.js'] },
      ],
    },
  },
```

- [ ] **Step 4: Run layering tests + full lint to verify**

Run: `npx vitest run src/layering.test.ts && npm run lint`
Expected: all layering tests PASS; lint clean (proves `src/eval/**` and `src/cli.ts` themselves violate nothing).

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js src/layering.test.ts
git commit -m "feat: eval-layer layering enforcement — globstar bans + session block + nested-path tests (E-1)"
```

---

### Task 9: CLI `eval` command

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli.test.ts` (append)

**Interfaces:**
- Consumes: `createGoldenRunner`, `EvalUsageError`, `TaskSessionConfig` (Task 7); `toCanonicalJson`, `toMarkdown` (Tasks 3–4); existing `composeSecurity`, `hookRecordToTelemetryInput`, `sanitizeForTerminal`, `openTelemetryDatabase`, `createMemoryStore`, `createHookRuntime`, `createSession`, `route`, `loadSkills`, `scan`, `redact`, permission/sandbox factories.
- Produces:
  - `EvalArgs { command: 'eval'; taskDir: string }` added to `CliArgs`
  - `parseEvalArgs(argv: string[]): ParseResult` (exported for tests)
  - `scorecardFilename(nowMs: number): string` (exported for tests) → `scorecard-YYYY-MM-DDTHH-mm-ssZ.json`
  - `refuseSymlinkedDir(path: string): void` (exported for tests) — throws `EvalUsageError`
  - `runEval(args: EvalArgs): Promise<number>` wired into `main()`

- [ ] **Step 1: Write the failing tests**

Append to `src/cli.test.ts` (match its existing import style — add `parseEvalArgs`, `refuseSymlinkedDir`, `scorecardFilename` to the imports from `./cli.js`; add `import { EvalUsageError } from './eval/index.js';` and `import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';` if not present):

```typescript
describe('parseEvalArgs', () => {
  it('defaults taskDir to ./eval/golden (README quick-start contract)', () => {
    const result = parseEvalArgs([]);
    expect(result).toEqual({ ok: true, value: { command: 'eval', taskDir: './eval/golden' } });
  });

  it('accepts a positional task directory', () => {
    const result = parseEvalArgs(['./my-tasks']);
    expect(result).toEqual({ ok: true, value: { command: 'eval', taskDir: './my-tasks' } });
  });

  it('rejects unknown flags (no --max-tasks in v1)', () => {
    const result = parseEvalArgs(['--max-tasks', '5']);
    expect(result.ok).toBe(false);
  });

  it('rejects extra positional arguments', () => {
    const result = parseEvalArgs(['a', 'b']);
    expect(result.ok).toBe(false);
  });

  it('is reachable through parseArgs', () => {
    const result = parseArgs(['eval', './tasks']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.command).toBe('eval');
  });
});

describe('scorecardFilename', () => {
  it('is filesystem-safe: no colons, second precision, Z-suffixed', () => {
    // 2026-07-09T03:12:45.678Z
    expect(scorecardFilename(1783307565678)).toBe('scorecard-2026-07-09T03-12-45Z.json');
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
```

Note: verify the epoch in the `scorecardFilename` test with `node -e "console.log(new Date(1783307565678).toISOString())"` — if it does not print `2026-07-09T03:12:45.678Z`, compute the correct epoch for that ISO string with `node -e "console.log(Date.parse('2026-07-09T03:12:45.678Z'))"` and use it.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/cli.test.ts`
Expected: FAIL — `parseEvalArgs` etc. are not exported.

- [ ] **Step 3: Implement in `src/cli.ts`**

Add imports:

```typescript
import { lstatSync, mkdirSync } from 'node:fs';   // merge into the existing node:fs import
import { createGoldenRunner, EvalUsageError, toCanonicalJson, toMarkdown } from './eval/index.js';
import type { TaskSessionConfig } from './eval/index.js';
```

Add the args type and extend the unions:

```typescript
export interface EvalArgs {
  command: 'eval';
  taskDir: string;
}

export type CliArgs = RunArgs | TelemetryExportArgs | EvalArgs;
```

Update `USAGE`:

```typescript
const USAGE =
  'Usage: agent-harness-ja run "<prompt>" [--skills-dir <dir>] [--db <path>] [--max-turns <n>]\n' +
  '       agent-harness-ja eval [taskDir]\n' +
  '       agent-harness-ja telemetry export [--db <path>] [--out <file>] [--session <id>] [--type <t>]';
```

Route in `parseArgs`:

```typescript
export function parseArgs(argv: string[]): ParseResult {
  if (argv[0] === 'telemetry') {
    return parseTelemetryArgs(argv.slice(1));
  }
  if (argv[0] === 'eval') {
    return parseEvalArgs(argv.slice(1));
  }
  return parseRunArgs(argv);
}

export function parseEvalArgs(argv: string[]): ParseResult {
  let taskDir = './eval/golden';
  let positionalSeen = false;
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      return { ok: false, error: `Unknown flag '${arg}'. ${USAGE}` };
    }
    if (positionalSeen) {
      return { ok: false, error: `Unexpected extra argument '${arg}'. ${USAGE}` };
    }
    taskDir = arg;
    positionalSeen = true;
  }
  return { ok: true, value: { command: 'eval', taskDir } };
}
```

Add the helpers:

```typescript
/** Filesystem-safe scorecard timestamp (spec: arbiter condition 2 — no colons). */
export function scorecardFilename(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `scorecard-${stamp}.json`;
}

/**
 * A malicious repo must not redirect the scorecard write (spec decision #21):
 * refuse a symlink at the output-dir path. Missing is fine (we mkdir it).
 */
export function refuseSymlinkedDir(path: string): void {
  let isSymlink: boolean;
  try {
    isSymlink = lstatSync(path).isSymbolicLink();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (isSymlink) {
    throw new EvalUsageError(`refusing to write scorecards: ${path} is a symlink`);
  }
}

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}
```

Add `runEval` (mirrors `main()`'s run-path composition; read that block first — the pieces below are the same factories in the same order):

```typescript
const EVAL_OUT_DIR = join('.harness', 'eval');

async function runEval(args: EvalArgs): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('ANTHROPIC_API_KEY is not set. Export it before running eval.\n');
    return 2;
  }

  let security: SecurityComposition;
  try {
    security = composeSecurity({
      readFile: (p) => readFileSync(p, 'utf8'),
      userDir: homedir(),
      projectDir: process.cwd(),
    });
  } catch (error: unknown) {
    if (error instanceof SettingsLoadError) {
      process.stderr.write(`${sanitizeForTerminal(error.message)}\n`);
      return 2;
    }
    throw error;
  }
  for (const warning of security.warnings) {
    process.stderr.write(`warning: ${sanitizeForTerminal(warning)}\n`);
  }

  // Pre-flight, before any spend: the write path must be trustworthy.
  try {
    refuseSymlinkedDir('.harness');
    refuseSymlinkedDir(EVAL_OUT_DIR);
  } catch (error: unknown) {
    if (error instanceof EvalUsageError) {
      process.stderr.write(`${sanitizeForTerminal(error.message)}\n`);
      return 2;
    }
    throw error;
  }

  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as { query: unknown };
  if (typeof sdk.query !== 'function') {
    process.stderr.write(
      'The installed @anthropic-ai/claude-agent-sdk does not export query(); check the SDK version.\n',
    );
    return 2;
  }
  const query = sdk.query as QueryFn;

  // Oracle execution is arbitrary in-process code from the task directory
  // (docs/security-model.md R-10) — say so before the first import.
  process.stderr.write(
    'warning: golden-eval oracles are arbitrary code from the task directory, executed in-process — only run eval on repos you trust (security-model R-10)\n',
  );

  // In-memory DB per eval run: never contaminates the operator's real
  // .harness/telemetry.db (spec decision #15).
  const db = openTelemetryDatabase({ path: ':memory:' });
  try {
    const telemetry = createTelemetryStore(db);
    const memory = createMemoryStore(db);

    const createTaskSession = (config: TaskSessionConfig) => {
      const sessionId = randomUUID();
      const turnId = randomUUID();
      const hooks = createHookRuntime({
        onEvent: (record) => {
          const result = telemetry.record(
            hookRecordToTelemetryInput(record, { sessionId, turnId }),
          );
          if (!result.ok) {
            process.stderr.write(
              `warning: telemetry hook-event record failed: ${sanitizeForTerminal(result.error.message)}\n`,
            );
          }
        },
      });
      hooks.register('pre-tool', permissionHook(createPermissionEvaluator(security.permissions)));
      hooks.register('pre-tool', sandboxHook(createSandbox(security.sandbox)));
      return createSession(
        {
          query,
          hooks,
          memory,
          loadSkills,
          route,
          telemetry,
          scanInjection: (text) => scan(text),
          redactSecrets: (text) => redact(text),
        },
        {
          skillsDir: config.skillsDir,
          maxTurns: config.maxTurns,
          ...(config.descriptor !== undefined && { descriptor: config.descriptor }),
          generateId: () => sessionId,
          turnId,
          // No onText: eval's stdout is the scorecard, nothing else.
          onWarning: (message) =>
            process.stderr.write(`warning: ${sanitizeForTerminal(message)}\n`),
        },
      );
    };

    const runner = createGoldenRunner({
      createTaskSession,
      redactSecrets: (text) => redact(text),
      harnessVersion: readPackageVersion(),
    });

    let scorecard;
    try {
      scorecard = await runner.run(args.taskDir, {
        onProgress: (line) => process.stderr.write(`${sanitizeForTerminal(line)}\n`),
      });
    } catch (error: unknown) {
      if (error instanceof EvalUsageError) {
        process.stderr.write(`${sanitizeForTerminal(error.message)}\n`);
        return 2;
      }
      throw error;
    }

    process.stdout.write(sanitizeForTerminal(toMarkdown(scorecard)));

    mkdirSync(EVAL_OUT_DIR, { recursive: true });
    refuseSymlinkedDir(EVAL_OUT_DIR); // re-check after mkdir (TOCTOU narrowing)
    const outPath = join(EVAL_OUT_DIR, scorecardFilename(Date.now()));
    writeFileSync(outPath, toCanonicalJson(scorecard));
    process.stderr.write(`scorecard written to ${outPath}\n`);

    return scorecard.totals.failed === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}
```

Wire into `main()` right after the telemetry-export branch:

```typescript
  if (parsed.value.command === 'eval') {
    return runEval(parsed.value);
  }
```

(`sanitizeForTerminal` keeps `\n`? **No — check:** TERMINAL_UNSAFE strips `\x00-\x08`, `\x0B-\x1F` — `\n` is `\x0A`, excluded from the ranges, so newlines survive. Verified against `src/cli.ts:65`.)

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `npx vitest run src/cli.test.ts && npm test && npm run lint && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: cli eval command — in-memory DB, pre-flight symlink/oracle warnings, 0/1/2 exit contract (E-1)"
```

---

### Task 10: Repo starter golden tasks

**Files:**
- Create: `eval/golden/hello-world.task.md`, `eval/golden/hello-world.oracle.mjs`
- Create: `eval/golden/no-tools-needed.task.md`, `eval/golden/no-tools-needed.oracle.mjs`

Top-level `eval/golden/` (NOT `src/` — tsc emits no `.md`/`.mjs`; npm ships no tasks; matches the CLI default `./eval/golden`). These are data files exercised by the live Week-3 checkpoint smoke, not by unit tests.

- [ ] **Step 1: Create `eval/golden/hello-world.task.md`**

```markdown
---
id: hello-world
descriptor:
  shape: lookup
  sensitivity: low
  expected_tokens: 200
maxTurns: 3
---
Reply with exactly the single word: pong
```

- [ ] **Step 2: Create `eval/golden/hello-world.oracle.mjs`**

```javascript
/** @type {import('agent-harness-ja').OracleFn} */
export const oracle = (result) => {
  if (result.resultSubtype !== 'success') {
    return { pass: false, reason: `expected subtype success, got ${result.resultSubtype}` };
  }
  const text = (result.resultText ?? '').trim().toLowerCase();
  return text.includes('pong')
    ? { pass: true }
    : { pass: false, reason: 'expected "pong" in the reply' };
};
```

- [ ] **Step 3: Create `eval/golden/no-tools-needed.task.md`**

```markdown
---
id: no-tools-needed
descriptor:
  shape: lookup
  sensitivity: low
  expected_tokens: 300
maxTurns: 3
---
Without using any tools, reply with one sentence describing what an agent harness is.
```

- [ ] **Step 4: Create `eval/golden/no-tools-needed.oracle.mjs`** (shows the `denied[]` surface — the harness-differentiating oracle case)

```javascript
/** @type {import('agent-harness-ja').OracleFn} */
export const oracle = (result) => {
  if (result.resultSubtype !== 'success') {
    return { pass: false, reason: `expected subtype success, got ${result.resultSubtype}` };
  }
  if (result.denied.length > 0) {
    return { pass: false, reason: `expected no denied tool calls, got ${result.denied.length}` };
  }
  const text = (result.resultText ?? '').trim();
  return text.length > 0
    ? { pass: true }
    : { pass: false, reason: 'expected a non-empty reply' };
};
```

- [ ] **Step 5: Sanity-parse the repo tasks with the unit-tested parser**

Run:
```bash
npx vitest run src/eval/golden/task.test.ts && node --input-type=module -e "
import { parseTaskFile } from './dist/eval/golden/task.js';
" 2>/dev/null || npm run build && node --input-type=module -e "
import { parseTaskFile } from './dist/eval/golden/task.js';
for (const f of ['eval/golden/hello-world.task.md', 'eval/golden/no-tools-needed.task.md']) {
  const r = parseTaskFile(f);
  if (!r.ok) { console.error(f, r.message); process.exit(1); }
  console.log(f, '→', r.value.id, 'maxTurns', r.value.maxTurns);
}
console.log('repo tasks parse clean');
"
```
Expected: both tasks parse with their ids; `repo tasks parse clean`.

- [ ] **Step 6: Commit**

```bash
git add eval/golden
git commit -m "feat: starter golden tasks — hello-world + no-tools-needed (denied[] oracle surface) (E-1)"
```

---

### Task 11: Documentation (ADR-0017 + amendments)

**Files:**
- Create: `docs/decisions/0017-golden-runner.md`
- Modify: `docs/architecture.md`, `docs/security-model.md`, `process/05-week-plan.md`, `README.md`

- [ ] **Step 1: Write `docs/decisions/0017-golden-runner.md`** (follow the house ADR format — read `docs/decisions/0016-llm-judge-design-deferred.md` first and match its header/section style). Content requirements (all from the spec, §Documentation amendments):

  - **Decision:** task format (`*.task.md` frontmatter: `id` `^[a-z0-9][a-z0-9-]{0,63}$`, optional `descriptor`/`maxTurns`/`skillsDir`; body = prompt; same anti-code-execution guards as skills via `src/internal/frontmatter.ts`); oracle contract (sibling `.mjs`, named `oracle` export, strict `{pass: boolean, reason?: string}`, truthy coercion = oracle-error); scorecard schema v1 with deterministic (`{id, pass, failureKind, reason}`, sorted by id) vs volatile partitions; exit codes 0/1/2 with the row-vs-run rule; sequential execution, per-task error isolation.
  - **Security stance:** oracles are arbitrary in-process code (R-10); runtime stderr warning; **golden eval never in per-PR CI** (fork PR + `ANTHROPIC_API_KEY` secret = exfiltration primitive; the only every-PR eval gate is E-3's keyless deterministic heuristic arm, ADR-0016 §7); scorecard strings redacted via injected `redactSecrets`, fail-closed sentinel; symlinked-output-dir refusal.
  - **Determinism honesty:** golden scorecards are informational artifacts from live runs, never re-derivable byte-for-byte, never CI baselines.
  - **Named limitations:** oracles judge the `SessionResult` self-report only (gating tasks via `denied[]` are first-class; side-effect inspection = designed-for future increment); no per-task wall-clock timeout (`QueryFn` has no abort channel; mitigated by default `maxTurns` 10); process-hostile oracles uncontainable in-process; interrupted run writes no partial scorecard (spend lost, documented).
  - **Deviations from spec:** `generateId` runner dep omitted (nothing consumes an id in v1); `harnessVersion` injected rather than imported.
  - **Revisit-ifs:** settings fingerprint in `meta`; `--max-tasks`/budget flag; abort/timeout support when the SDK grows one; partial-scorecard-on-SIGINT (with E-3); workspace handle for side-effect oracles; `failingField` extraction at a third copy site.

- [ ] **Step 2: Amend `docs/architecture.md`**

In the "Eval layer" section (starts `docs/architecture.md:139`), insert a new `#### eval/scorecard` subsection BEFORE `#### eval/golden`:

```markdown
#### `eval/scorecard`

- **Owns:** producer-agnostic scoring machinery — the scorecard schema (deterministic vs volatile partitions), canonical JSON, Markdown rendering, row-text sanitization.
- **Public API:** `toCanonicalJson(scorecard): string`; `toMarkdown(scorecard): string`; `cleanForScorecard(text, redactSecrets?): string`; the `Scorecard` / `ScorecardRow` / `FailureKind` types.
- **Depends on:** `internal/sanitize`; security types only.
- **Design notes:** Only the deterministic partition (`{id, pass, failureKind, reason}`, rows sorted by id) may ever be baseline-diffed (E-3); cost/turns/duration and `meta` are volatile and informational ([ADR-0017](../../docs/decisions/0017-golden-runner.md)).
```

Replace the `#### eval/golden` subsection body with:

```markdown
- **Owns:** running a set of golden tasks and scoring them.
- **Public API:** `createGoldenRunner(deps)`; `runner.run(taskDir: string, opts?): Promise<Scorecard>`.
- **Depends on:** the full harness — runs real agents through it; `eval/scorecard` for output.
- **Design notes:** Each task is Markdown frontmatter + body (the prompt) with a sibling `<name>.oracle.mjs` module (JSDoc-typed via the exported `OracleFn`). Oracles judge the `SessionResult` self-report; per-task failures become rows with a `failureKind`; failure reasons are redacted and truncated before entering the scorecard. Shipped ([ADR-0017](../../docs/decisions/0017-golden-runner.md)).
```

In `#### eval/red-team`, change the "Depends on" line to:

```markdown
- **Depends on:** `eval/scorecard` for the scoring machinery; `security/injection-scanner` for verdict comparison.
```

At `docs/architecture.md:238`, replace "The eval layer treats any uncaught exception in a task as a hard fail and reports the stack in the scorecard." with:

```markdown
- The eval layer treats any uncaught per-task exception as a failed row with a `failureKind` (infra flakes distinguishable from capability regressions) and reports a redacted, truncated failure reason in the scorecard — never a raw stack.
```

- [ ] **Step 3: Amend `docs/security-model.md`**

Append to the §6 residual-risks table:

```markdown
| R-10 | Golden-eval oracles are arbitrary in-process code from the (in-scope) cloned repo, executed with no gate | High (targeted) | Eval is operator-invoked with a runtime stderr warning; golden eval never runs in per-PR CI (a fork PR plus a CI key secret is an exfiltration primitive) — the every-PR gate is E-3's keyless deterministic arm | ADR-0017 |
```

In §2 (attacker model), add to the in-scope wording: running `agent-harness-ja eval` against a cloned repo executes that repo's oracle modules in-process — for the eval command specifically, cloning a malicious repo and running eval IS code execution, and the harness says so at runtime rather than pretending a gate exists.

- [ ] **Step 4: Amend `process/05-week-plan.md`**

Tick line 77: `- [x] **Golden task runner** (E-1) — Markdown task definitions, oracle functions, scorecard output.`

On line 83, change "CI runs eval on every PR." to: "CI runs eval on every PR (the deterministic red-team arm only — golden eval needs a live key and executes repo oracle code, so it never runs in per-PR CI; ADR-0016 §7, ADR-0017)."

- [ ] **Step 5: Verify README quick-start**

`README.md:51-52` says `# Run the eval suite (golden + red-team)` / `npx agent-harness-ja eval`. The command now works but red-team lands in E-2 — change the comment line to:

```markdown
# Run the golden eval suite (red-team corpus lands in E-2)
```

- [ ] **Step 6: Commit**

```bash
git add docs process/05-week-plan.md README.md
git commit -m "docs: ADR-0017 golden runner + architecture/security-model/week-plan/README amendments (E-1)"
```

---

### Task 12: Final verification, review gates, PR

- [ ] **Step 1: Full local gate**

```bash
npm run lint && npm run typecheck && npm run build && npm test && npm run test:coverage
```

Expected: all green; coverage on `src/eval/**` ≥ 80% lines. Total test count ≥ 585 + ~55 new.

- [ ] **Step 2: Offline CLI smoke (no API key needed — exercises exit-2 paths)**

```bash
node dist/cli.js eval ./does-not-exist; echo "exit=$?"        # expect usage error, exit=2
node dist/cli.js eval --bogus; echo "exit=$?"                  # expect Unknown flag, exit=2
```

- [ ] **Step 3: House review gates (NOT optional — Stop hook enforces them)**

Run the 3-agent review (`/review3`: code-reviewer + security-reviewer + architect) on the branch diff; route security/architecture reviewers to Fable (inherit — omit `model`), code review to sonnet. Fix findings, re-run until clean, then run `/differential-review` on the whole branch vs main (milestone gate). Add the report to `process/reviews/differential-review-eval-e1.md` and commit fixes with clear messages.

- [ ] **Step 4: Push and open the PR (Jackson merges — never self-merge)**

```bash
git push -u origin feat/eval-e1-golden-runner
gh pr create --title "feat: E-1 golden task runner — tasks, oracles, scorecards (ADR-0017)" --body "$(cat <<'EOF'
## Summary
- `npx agent-harness-ja eval [taskDir]`: runs `*.task.md` golden tasks through the real harness, scores them with sibling `*.oracle.mjs` oracles, emits a Markdown scorecard (stdout) + canonical JSON (`.harness/eval/`, gitignored scratch)
- `src/eval/scorecard/`: producer-agnostic schema (deterministic vs volatile partitions), canonical JSON, Markdown renderer — E-2's red-team arm builds on this
- `src/eval/golden/`: hardened task parser (shared frontmatter guards hoisted to `src/internal/frontmatter.ts` — pure move, skills tests unmodified), strict oracle boundary validation, per-task error isolation with `failureKind` rows
- CLI: in-memory DB per eval run, pre-flight symlink/oracle warnings, exit contract 0/1/2
- Layering: `**/eval/**` globstar bans + new session block + nested-path lint proofs
- Docs: ADR-0017, security-model R-10 (oracles are in-process code; golden eval never in per-PR CI), architecture/week-plan/README amendments

Design: `process/designs/2026-07-08-e1-golden-runner.md` (33-finding panel + arbiter). Plan: `process/plans/2026-07-09-e1-golden-runner-implementation.md`.

## Test plan
- [ ] CI green Node 20/22 (lint, typecheck incl. tests, build, test)
- [ ] Live smoke (Jackson, needs ANTHROPIC_API_KEY): `npm run build && node dist/cli.js eval` → 2 starter tasks pass, scorecard JSON written, exit 0

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Post-PR session close** — update `process/devlog/week-3.md` (E-1 entry), project memory (`project_agent_harness.md`: branch, PR number, test count, next entry point = live smoke + Jackson merge, then E-2).
