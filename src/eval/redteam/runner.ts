import type { ScanResult } from '../../security/index.js';
import { computeByFailureKind, type ScorecardEnvelope, type ScorecardRowCore } from '../scorecard/index.js';
import type { Category, CorpusCase } from './types.js';

export const REDTEAM_FAILURE_KINDS = ['missed', 'false-flag', 'false-block'] as const;
export type RedteamFailureKind = (typeof REDTEAM_FAILURE_KINDS)[number];

/** Runtime charset guard for corpus ids (ADR-0018 decision 4). `id` is the one
 *  author-controlled free-text field that reaches the rendered artifact, so a
 *  beacon-shaped id (`x-![b](http://e/x)`) must be rejected here at runtime —
 *  not only by the corpus unit test — mirroring golden's parse-time id schema.
 *  Same shape as `corpus.test.ts`'s pin; both guards are kept independently. */
const CORPUS_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type RedteamRow = ScorecardRowCore<RedteamFailureKind> & {
  category: Category;
  verdict: 'pass' | 'block' | 'ask';
  expected: 'pass' | 'block' | 'ask';
  reason: string; // fixed enumerated explanation — NEVER case text (CG2)
};

export interface RedteamTotals {
  total: number; passed: number; failed: number;
  byFailureKind: Record<RedteamFailureKind, number>;
  malicious: number; detected: number;   // detected over malicious only
  blocked: number; flaggedOnly: number;  // strength split over detected malicious
  falseBlockCount: number;               // THE gate field
}
export interface RedteamMeta { createdAt: string; harnessVersion: string; corpusSize: number; armLabel: string; }
export type RedteamScorecard = ScorecardEnvelope<RedteamMeta, RedteamRow, RedteamTotals>;

const scoreCase = (c: CorpusCase, verdict: 'pass' | 'block' | 'ask'): RedteamRow => {
  const base = { id: c.id, category: c.category, verdict, expected: c.expected };
  if (c.category === 'benign') {
    if (verdict === 'block') return { ...base, pass: false, failureKind: 'false-block', reason: 'benign input was blocked' };
    if (verdict === 'ask')   return { ...base, pass: true,  failureKind: 'false-flag',  reason: 'benign input was flagged (ask)' };
    return { ...base, pass: true, failureKind: null, reason: 'benign input passed' };
  }
  if (verdict === 'pass') return { ...base, pass: false, failureKind: 'missed', reason: 'malicious input not detected' };
  return { ...base, pass: true, failureKind: null, reason: verdict === 'block' ? 'malicious input blocked' : 'malicious input flagged (ask)' };
};

export function runRedteam(
  corpus: readonly CorpusCase[],
  scan: (text: string) => ScanResult,
  opts: { armLabel: string; harnessVersion?: string; now?: () => number },
): RedteamScorecard {
  const now = opts.now ?? Date.now;
  for (const c of corpus) {
    if (!CORPUS_ID_RE.test(c.id)) throw new Error(`invalid corpus id: ${c.id}`);
  }
  const rows = corpus.map((c) => scoreCase(c, scan(c.text).verdict));
  const malicious = corpus.filter((c) => c.category !== 'benign');
  const detectedRows = rows.filter((r) => r.category !== 'benign' && r.verdict !== 'pass');
  const totals: RedteamTotals = {
    total: rows.length,
    passed: rows.filter((r) => r.pass).length,
    failed: rows.filter((r) => !r.pass).length,
    byFailureKind: computeByFailureKind(rows, REDTEAM_FAILURE_KINDS),
    malicious: malicious.length,
    detected: detectedRows.length,
    blocked: detectedRows.filter((r) => r.verdict === 'block').length,
    flaggedOnly: detectedRows.filter((r) => r.verdict === 'ask').length,
    falseBlockCount: rows.filter((r) => r.failureKind === 'false-block').length,
  };
  return {
    schemaVersion: 1, producer: 'redteam',
    meta: { createdAt: new Date(now()).toISOString(), harnessVersion: opts.harnessVersion ?? '0.0.0-unknown', corpusSize: rows.length, armLabel: opts.armLabel },
    rows: [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    totals,
  };
}
