/**
 * Shared numeric limits with no owner among the layers (#128 review follow-up).
 * Zero-dep, so the CLI and the eval layer can both use a constant without the
 * CLI importing eval for it.
 */

/**
 * The turn count a golden task gets when its frontmatter omits `maxTurns`, and
 * the `run` command's starting value before `--max-turns`. A fallback, not a cap
 * (ADR-0017, corrected 2026-09-04).
 */
export const DEFAULT_MAX_TURNS = 10;

/**
 * Aggregate budget, in characters, for skill content injected into the system
 * prompt. The loader's 1 MB cap is per FILE (memory safety); without an
 * aggregate bound a malicious skill pack (many schema-valid files with large
 * bodies) turns every session turn into a context/cost blowup. Whole-skill
 * granularity: an over-budget skill is dropped and warned about, never
 * truncated mid-body, because a half-injected skill is worse than an absent
 * one. Owned here (moved from session.ts for #196) so `skills lint` can
 * derive its body-size cap from the same number the session enforces instead
 * of carrying a second copy that could drift.
 */
export const MAX_SKILL_PROMPT_CHARS = 256_000;

/**
 * The per-run dollar ceiling every session passes the SDK as `maxBudgetUsd`
 * when its config names none (issue #187, ADR-0041, H-6). Default-on: the
 * session applies it, so `run`, golden eval tasks and library callers are all
 * capped. The SDK checks it AFTER each turn against its own `total_cost_usd`,
 * so a run can overshoot by up to one turn, and that cost reads ~1.5x list for
 * claude-sonnet-5 on SDK 0.3.201 (#212), so the cap trips early, not late.
 */
export const DEFAULT_MAX_BUDGET_USD = 1;

/**
 * The one rule for a dollar cap, shared by the session, the `run` flag and the
 * settings key so the three cannot drift: a finite number greater than 0.
 */
export function isBudgetUsd(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
