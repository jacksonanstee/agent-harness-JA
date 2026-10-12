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
