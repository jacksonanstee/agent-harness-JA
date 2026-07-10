import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EvalUsageError, toCanonicalJson } from '../eval/index.js';

/** Default scorecard output directory, shared by eval and redteam (both are
 *  scorecard producers writing through the same `writeScorecard` helper). */
export const EVAL_OUT_DIR = join('.harness', 'eval');

export const USAGE =
  'Usage: agent-harness-ja run "<prompt>" [--skills-dir <dir>] [--db <path>] [--max-turns <n>]\n' +
  '       agent-harness-ja eval [taskDir]\n' +
  '       agent-harness-ja redteam [--out <dir>] [--update-baseline] [--baseline <path>]\n' +
  '       agent-harness-ja telemetry export [--db <path>] [--out <file>] [--session <id>] [--type <t>]';

// Deliberately separate from src/internal/sanitize.ts: model output and
// warnings reach the user's terminal, where newline/tab are kept for
// readability while ANSI/OSC escape introducers and C1 controls are stripped.
export const TERMINAL_UNSAFE = /[\x00-\x08\x0B-\x1F\x7F-\x9F\u2028\u2029]/g;

export function sanitizeForTerminal(text: string): string {
  return text.replace(TERMINAL_UNSAFE, ' ');
}

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

/**
 * Write the canonical scorecard under outDir. Every failure maps to a message,
 * never a throw: a failed write means no scorecard was produced, which the
 * caller must surface as exit 2 (ADR-0017 decision #4) — bubbling to the
 * generic exit-1 handler would report it on the code reserved for "ran, at
 * least one row failed". Not just symlink refusals: ENOTDIR (a regular file
 * committed at the output path), EACCES, and ENOSPC all end here too.
 *
 * Generic over any scorecard envelope (golden, redteam, ...): the same
 * constraint `toCanonicalJson` requires, so every scorecard producer writes
 * through this one helper instead of duplicating it.
 */
export function writeScorecard<T extends { rows: ReadonlyArray<{ id: string }> }>(
  scorecard: T,
  outDir: string,
  nowMs: number = Date.now(),
): { ok: true; path: string } | { ok: false; message: string } {
  try {
    mkdirSync(outDir, { recursive: true });
    // Re-checks only the leaf path (outDir); it narrows the TOCTOU window
    // opened by mkdir but does not close it — an in-process oracle can write
    // anywhere regardless (security-model R-10).
    refuseSymlinkedDir(outDir);
    const path = join(outDir, scorecardFilename(nowMs));
    writeFileSync(path, toCanonicalJson(scorecard));
    return { ok: true, path };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}
