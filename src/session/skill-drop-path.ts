import { isAbsolute, relative, sep } from 'node:path';

/**
 * The `path`/`pathForm` pair for a skill-drop telemetry row (issue #59
 * round 2, ADR-0031 decision 6). A discriminated union so the invalid
 * pairings — a populated path claiming suppression, a null path claiming a
 * relative form — are unrepresentable at the type level, the same defence
 * ADR-0030 gave `TaskDirMeta` and for the same reason: two independently
 * settable fields whose relationship lives in prose cost this codebase a
 * review round once (`pathTruncated`/`pathDigest`, ADR-0011).
 */
export type SkillDropPathMeta =
  | { path: string; pathForm: 'root-relative' }
  | { path: null; pathForm: 'suppressed' };

/**
 * Classifies a dropped skill's path for the telemetry row: root-relative
 * when the path sits at or under the skills root the loader actually
 * scanned, null otherwise (ADR-0031 decision 6, mirroring `portableTaskDir`,
 * ADR-0030 decision 1).
 *
 * Both operands are values the harness held at write time: `root` is the
 * `resolve(dir)` the loader's walk used, captured once and threaded back
 * through `LoadResult.root` — never a fresh ambient `resolve()` at this
 * seam, which would re-open the process.chdir window the runner documents —
 * and `rawPath` is the loader's lexical absolute path for the skill. No
 * `os.homedir()` is consulted anywhere; that ambient keying is what killed
 * all three round-one designs (ADR-0027 decision 3).
 *
 * By construction the loader's join-based walk only ever produces paths
 * under its root, so the suppress arm should be unreachable. "Should be
 * unreachable" is a claim, not a guarantee, so the guard makes the safe
 * direction true regardless: any shape not positively recognised as
 * at-or-under-root stores null, removing information rather than disclosing
 * it. A walk-up form would spell out intervening absolute segments — the
 * operator's home directory included — in a durable, exportable row.
 *
 * The classifier is a segment check, not a prefix check: a directory
 * literally named `..foo` under the root is a legal name and stays
 * populated. `isAbsolute(rel)` covers the Windows cross-drive case, where
 * `relative()` has no relative form (reasoned, not executed: no Windows CI).
 *
 * Precondition, ENFORCED rather than trusted (the ADR-0030 verify round
 * executed the mis-call this guard exists for): with a relative argument,
 * `relative()` silently re-anchors to the AMBIENT process.cwd(), so a
 * non-absolute argument suppresses outright. A null root (the session's
 * no-scan case, where there is no root to be relative to) suppresses the
 * same way.
 *
 * `relative(x, x)` is the empty string, mapped to `'.'` for totality; a
 * real drop is always a file strictly under the root, so this arm is
 * unreachable in practice but a classifier does not get to be partial.
 */
export function relativeSkillDropPath(root: string | null, rawPath: string): SkillDropPathMeta {
  if (root === null || !isAbsolute(root) || !isAbsolute(rawPath)) {
    return { path: null, pathForm: 'suppressed' };
  }
  const rel = relative(root, rawPath);
  if (rel === '') return { path: '.', pathForm: 'root-relative' };
  if (!isAbsolute(rel) && rel.split(sep)[0] !== '..') {
    return { path: rel, pathForm: 'root-relative' };
  }
  return { path: null, pathForm: 'suppressed' };
}
