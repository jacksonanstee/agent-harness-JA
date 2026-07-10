import { Ajv2020 } from 'ajv/dist/2020.js';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

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
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    // ALL load failures throw BaselineError (design contract): readFileSync
    // can throw raw past the stat guards (EISDIR when path is a directory,
    // EACCES on permission loss between stat and read).
    throw new BaselineError(
      `cannot read baseline ${path} (${(error as NodeJS.ErrnoException).code ?? 'read error'})`,
    );
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
  return { raw, parsed: parsed as unknown as BaselineScorecard };
}
