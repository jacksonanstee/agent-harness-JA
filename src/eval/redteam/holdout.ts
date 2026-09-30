import { Ajv2020 } from 'ajv/dist/2020.js';

import { GuardedReadError, readFileGuarded } from '../../internal/guarded-read.js';
import { MAX_JUDGE_INPUT_BYTES } from '../../security/index.js';
import type { ScanResult, Verdict } from '../../security/index.js';
import { CORPUS } from './corpus.js';
import { CORPUS_ID_RE } from './runner.js';
import { CATEGORIES } from './types.js';
import type { CorpusCase } from './types.js';

// The held-out slice (issue #96 PR-A, ADR-0036 D5): a private JSON file of
// `{ id, category, text, expected }` cases that live OUTSIDE the repository's
// history, loaded as HOSTILE input on the baseline.ts precedent. Every
// failure is a `HoldoutError` that names the case id (charset-pinned by the
// schema, so it is safe to interpolate) and never a byte of case text. The
// loader takes the sync scanner so the shape rules are ENFORCED at load, not
// only asked of the author (U-19).

/** All holdout load/validate failures. The CLI maps every one to exit 2, before the heuristic arm. */
export class HoldoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldoutError';
  }
}

/** Byte cap on the file (the `MAX_BASELINE_BYTES` precedent). */
export const MAX_HOLDOUT_BYTES = 1_000_000;
/** Case cap (the `DEFAULT_MAX_TASKS` precedent, G-3): the file bounds bytes, never calls. */
export const MAX_HOLDOUT_CASES = 100;

const RECOMMENDED_HOME = '~/.harness/redteam-holdout.json';
const ANCESTOR_REMEDY =
  "pass --holdout the link's target path, or move the file out of the symlinked directory";

const VERDICTS: readonly Verdict[] = ['pass', 'ask', 'block'];

/** A holdout case as loaded: the corpus shape without `source` (YAGNI 4). */
export type HoldoutCase = Pick<CorpusCase, 'id' | 'category' | 'text' | 'expected'>;

const holdoutSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'category', 'text', 'expected'],
    properties: {
      id: { type: 'string', pattern: CORPUS_ID_RE.source },
      category: { enum: [...CATEGORIES] },
      text: { type: 'string' },
      expected: { enum: [...VERDICTS] },
    },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true });
const validateHoldout = ajv.compile(holdoutSchema);

/** Maps each guarded-read refusal onto the holdout's own message shapes. */
function toHoldoutError(error: GuardedReadError): HoldoutError {
  switch (error.refusal) {
    case 'symlink':
      return new HoldoutError(`refusing holdout: ${error.message}`);
    case 'ancestor-symlink':
      return new HoldoutError(`refusing holdout: ${error.message}; ${ANCESTOR_REMEDY}`);
    case 'directory':
      return new HoldoutError(`cannot read holdout ${error.path} (EISDIR)`);
    case 'oversize':
      return new HoldoutError(`holdout ${error.message}`);
    case 'not-a-file':
      return new HoldoutError(`cannot read holdout ${error.path} (not a regular file)`);
    case 'unreadable':
      return new HoldoutError(`holdout ${error.path}: ${error.message}`);
  }
}

/**
 * Names the case an ajv error points at WITHOUT echoing input: the id when
 * it is a string in the pinned charset, else its index. A hostile id never
 * reaches the message.
 */
function caseLabel(parsed: unknown, instancePath: string | undefined): string {
  const m = /^\/(\d+)(?:\/|$)/.exec(instancePath ?? '');
  if (m === null || !Array.isArray(parsed)) return 'the file';
  const index = Number(m[1]);
  const item: unknown = parsed[index];
  const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined;
  return typeof id === 'string' && CORPUS_ID_RE.test(id) ? `case '${id}'` : `case at index ${index}`;
}

/** The ordered per-case rules that follow the schema (D5): text non-empty,
 *  the judge input cap in BYTES (ajv `maxLength` counts code points, S-19),
 *  then `expected` against the category (benign means `pass`; malicious
 *  means `block` or `ask`, U-8). */
function checkCase(c: HoldoutCase): void {
  if (c.text.length === 0) {
    throw new HoldoutError(`holdout case '${c.id}' has empty text; every case needs text to judge`);
  }
  const bytes = Buffer.byteLength(c.text, 'utf8');
  if (bytes > MAX_JUDGE_INPUT_BYTES) {
    throw new HoldoutError(
      `holdout case '${c.id}' text is ${bytes} bytes; the judge input cap is ${MAX_JUDGE_INPUT_BYTES} bytes`,
    );
  }
  if (c.category === 'benign' && c.expected !== 'pass') {
    throw new HoldoutError(
      `holdout case '${c.id}' is benign but expected is '${c.expected}'; a benign case must expect 'pass'`,
    );
  }
  if (c.category !== 'benign' && c.expected === 'pass') {
    throw new HoldoutError(
      `holdout case '${c.id}' is ${c.category} but expected is 'pass'; a malicious case must expect 'block' or 'ask'`,
    );
  }
}

/** The shape rules, enforced by running the sync scanner (S-6, U-19): a
 *  malicious case the heuristic catches is not held out from it; a benign
 *  case the heuristic blocks is one the judge never sees. */
function checkShape(c: HoldoutCase, verdict: Verdict): void {
  if (c.category !== 'benign' && verdict !== 'pass') {
    throw new HoldoutError(
      `holdout case '${c.id}' is ${c.category} but the heuristic scanner returns '${verdict}'; ` +
        "a malicious holdout case must be a heuristic 'pass' (it is not held out from the heuristic; it belongs in the corpus)",
    );
  }
  if (c.category === 'benign' && verdict === 'block') {
    throw new HoldoutError(
      `holdout case '${c.id}' is benign but the heuristic scanner returns 'block'; ` +
        'a benign holdout case must be heuristic non-block (or the judge never sees it)',
    );
  }
}

/**
 * Loads the held-out slice: guarded read (symlink refusal at the file and
 * its parent, byte cap, O_NOFOLLOW), ENOENT mapped by name, a non-echoing
 * JSON parse, the exact ajv allowlist, then the ordered rules: per case
 * (`checkCase`), the case cap, non-empty, no duplicate ids, no id present in
 * the committed corpus, and finally the scanner shape rules over every case.
 * Returns the parsed cases unchanged so the CLI hands them to the runner.
 */
export function loadHoldout(path: string, scan: (text: string) => ScanResult): HoldoutCase[] {
  // Two refusals that name their cause instead of a misleading downstream
  // message (code-lens fold, C-10): a `~` the shell did not expand (a quoted
  // path) would otherwise be told to use the notation that just failed.
  if (path.startsWith('~')) {
    throw new HoldoutError(
      `holdout path ${path} starts with '~', which the shell did not expand (a quoted path); pass the absolute path`,
    );
  }
  let raw: string;
  try {
    raw = readFileGuarded(path, MAX_HOLDOUT_BYTES);
  } catch (error: unknown) {
    if (error instanceof GuardedReadError) throw toHoldoutError(error);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HoldoutError(
        `no holdout file at ${path}; the recommended home is ${RECOMMENDED_HOME}, never inside the repository`,
      );
    }
    throw error;
  }
  // A UTF-8 byte-order mark (a common editor artefact on a hand-authored
  // file) would otherwise surface only as "failed to parse as JSON".
  if (raw.charCodeAt(0) === 0xfeff) {
    throw new HoldoutError(`holdout ${path} starts with a UTF-8 byte-order mark; save the file without a BOM`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately NOT String(error): V8 SyntaxError messages embed a
    // verbatim snippet of the input, and this message is terminal-bound.
    throw new HoldoutError(`holdout ${path} failed to parse as JSON`);
  }
  if (!validateHoldout(parsed)) {
    const errors = validateHoldout.errors ?? [];
    throw new HoldoutError(
      `holdout ${path} is invalid at ${caseLabel(parsed, errors[0]?.instancePath)}: ${ajv.errorsText(errors)}`,
    );
  }
  const cases = parsed as unknown as HoldoutCase[];

  for (const c of cases) checkCase(c);
  if (cases.length > MAX_HOLDOUT_CASES) {
    throw new HoldoutError(`holdout ${path} has ${cases.length} cases; at most ${MAX_HOLDOUT_CASES} are accepted`);
  }
  if (cases.length === 0) {
    throw new HoldoutError(`holdout ${path} is empty; at least one case is required`);
  }
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new HoldoutError(`holdout ${path} has duplicate case id '${c.id}'`);
    seen.add(c.id);
  }
  const corpusIds = new Set(CORPUS.map((c) => c.id));
  for (const c of cases) {
    if (corpusIds.has(c.id)) {
      throw new HoldoutError(
        `holdout case '${c.id}' is a committed corpus id; the slice must be held OUT of the corpus`,
      );
    }
  }
  for (const c of cases) checkShape(c, scan(c.text).verdict);
  return cases;
}
