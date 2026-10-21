import { sep } from 'node:path';

import {
  CASE_INSENSITIVE_PLATFORM,
  canonicalizePath,
  TOOL_TARGET_FIELDS,
} from '../../internal/tool-targets.js';
import { PRE_TOOL_GRANT_KIND, type PreToolGrant } from '../../internal/pre-tool-grant.js';
import type { PreToolLike } from '../pre-tool-like.js';
import { collapseBlanks, firstShellWord, trimWordSeparators } from '../shell-words.js';
import type {
  Evaluation,
  EvaluatorOptions,
  GrantPolicy,
  LayeredRule,
  PermissionDecision,
  PermissionEvaluator,
  Prompter,
} from './types.js';

/** Higher wins at equal specificity — fail closed on conflicting rules. */
const SEVERITY: Readonly<Record<PermissionDecision, number>> = {
  deny: 3,
  ask: 2,
  allow: 1,
};

/**
 * Exact match, or prefix match when the pattern ends with '*'. A '*' anywhere
 * else is a literal character — the grammar is deliberately this small
 * (ADR-0014 §1).
 */
export function matchesGlob(pattern: string, value: string): boolean {
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

/**
 * Path-target variant of matchesGlob with inclusive directory boundaries: a
 * `dir/*` pattern matches the bare `dir` too, mirroring the sandbox's
 * `isUnder`. Without this a `{match:'/secrets/*'}` deny rule would miss
 * `Glob(path='/secrets')`, which still enumerates the whole directory
 * (verify-pass finding). `pattern` is already canonicalised.
 */
export function matchesPathGlob(pattern: string, value: string): boolean {
  if (pattern.endsWith(sep + '*')) {
    const base = pattern.slice(0, -2); // drop trailing sep + '*'
    return value === base || value.startsWith(base + sep);
  }
  return matchesGlob(pattern, value);
}

/**
 * Canonical string a rule's `match` glob is tested against. The tool→field
 * table is shared with the sandbox (src/internal/tool-targets.ts — review
 * finding: two hand-copied tables drifted and Glob/Grep/NotebookEdit/
 * MultiEdit bypassed both gates). File paths are canonicalised (lexical
 * resolve + case folding on case-insensitive platforms) so `/etc/*` cannot
 * be dodged with `/tmp/../etc/passwd` OR `/ETC/passwd` on APFS. A missing
 * path on Glob/Grep means cwd per the SDK contract. Falls back to the JSON
 * of the args for unknown tools — a caller-shaped surface, so match rules
 * on arbitrary tools are best-effort only (ADR-0014 §1).
 */
/**
 * Normalizes a command string for rule matching: trims spaces, tabs and
 * newlines at the ends, collapses runs of spaces and tabs (the shell's blanks;
 * NOT JS `\s`, which also eats NBSP, U+2028, VT, FF and the other Unicode
 * spaces that bash keeps inside a word, issue #161; word grammar in
 * `../shell-words.ts`, shared with the sandbox gate), and folds
 * case on the argv0 token ONLY, on case-insensitive platforms (where `RM`
 * executes /bin/rm — the same bypass class canonicalizePath closes for
 * paths; Week-2 milestone differential review F-1). The fold deliberately
 * stops at the first shell separator: the filesystem rationale covers which *program*
 * resolves, not its arguments — folding the whole string would WIDEN allow
 * rules to case-variants of URLs/flags/literals the author never permitted
 * (review round on the F-1 fix). Match *patterns* for command targets go
 * through the same function so both sides share one identity grammar.
 */
export function canonicalizeCommand(
  value: string,
  caseInsensitive: boolean = CASE_INSENSITIVE_PLATFORM,
): string {
  const collapsed = collapseBlanks(trimWordSeparators(value));
  if (!caseInsensitive || collapsed === '') return collapsed;
  const argv0 = firstShellWord(collapsed);
  return argv0.toLowerCase() + collapsed.slice(argv0.length);
}

export function extractMatchTarget(tool: string, args: unknown): string {
  const spec = TOOL_TARGET_FIELDS[tool];
  if (spec !== undefined && typeof args === 'object' && args !== null) {
    const raw = (args as Record<string, unknown>)[spec.field];
    const value =
      raw === undefined && spec.missingMeansCwd === true ? process.cwd() : raw;
    if (typeof value === 'string') {
      if (spec.kind === 'path') return canonicalizePath(value);
      if (spec.kind === 'command') return canonicalizeCommand(value);
      return value;
    }
  }
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    // Circular args: nothing sensible to match against; empty string only
    // matches the bare '*' pattern.
    return '';
  }
}

/**
 * Canonicalizes a `match` pattern for path-target tools so a relative
 * pattern like `secrets/*` still fires against the resolved absolute target
 * (fail-open regression caught by the review verify pass). Trailing
 * separator semantics are preserved: resolve() drops a trailing '/', so
 * `/etc/*` is rebuilt as `/etc/` + `*` and cannot false-match `/etcetera`.
 * A bare `*` stays `*`.
 */
export function canonicalizePathPattern(pattern: string): string {
  if (pattern === '*') return pattern;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    const keepSep = prefix.endsWith('/') || prefix.endsWith(sep);
    return `${canonicalizePath(prefix)}${keepSep ? sep : ''}*`;
  }
  return canonicalizePath(pattern);
}

/**
 * Lexicographic (named tool, has match): an exact tool name always beats a
 * wildcard tool, even when the wildcard rule carries a `match` — a
 * `{tool:'*', match}` rule must never outrank `{tool:'Bash'}`.
 */
function specificity(rule: LayeredRule): number {
  const toolRank = rule.tool.endsWith('*') ? 0 : 2;
  return toolRank + (rule.match === undefined ? 0 : 1);
}

/**
 * Human-readable identity of the winning rule for deny reasons. The `match`
 * glob is deliberately ABSENT: reasons reach two retained sinks (telemetry
 * hook-event rows and the memory summary's denied[]), and match globs are
 * routinely absolute paths under the operator's home directory (issue #59,
 * R-17 channels c/d — ADR-0031). `index` is the rule's position within its
 * OWN layer's settings file, so `[rule 0, project]` means "the first rule in
 * your project settings.json" — the one file the layer tag points at.
 */
function describeRule(rule: LayeredRule, index: number): string {
  return `${rule.decision} ${rule.tool} [rule ${index}, ${rule.layer}]`;
}

interface Winner {
  rule: LayeredRule;
  index: number;
}

/**
 * Specificity-then-severity winner among one layer's matching rules. Within a
 * layer the author trusts themselves, so a more specific allow may carve out
 * their own broader deny.
 */
function layerWinner(
  rules: readonly LayeredRule[],
  tool: string,
  target: string,
  targetKind: 'path' | 'command' | undefined,
): Winner | null {
  let winner: Winner | null = null;
  for (const [index, rule] of rules.entries()) {
    if (!matchesGlob(rule.tool, tool)) continue;
    if (rule.match !== undefined) {
      if (targetKind === 'path') {
        if (!matchesPathGlob(canonicalizePathPattern(rule.match), target)) continue;
      } else if (targetKind === 'command') {
        if (!matchesGlob(canonicalizeCommand(rule.match), target)) continue;
      } else if (!matchesGlob(rule.match, target)) continue;
    }
    if (
      winner === null ||
      specificity(rule) > specificity(winner.rule) ||
      (specificity(rule) === specificity(winner.rule) &&
        SEVERITY[rule.decision] > SEVERITY[winner.rule.decision])
    ) {
      winner = { rule, index };
    }
  }
  return winner;
}

export function createPermissionEvaluator(opts: EvaluatorOptions = {}): PermissionEvaluator {
  const rules = opts.rules ?? [];
  const defaultDecision = opts.defaultDecision ?? 'allow';
  // The winner is resolved PER LAYER and then combined by MAX SEVERITY across
  // layers: a project layer can tighten the user's policy but can never
  // loosen it, no matter how specific its rules are (ADR-0014 §5 — sticky
  // deny is cross-layer, specificity is intra-layer only). The filters
  // preserve each settings file's own order, so a layer winner's index IS the
  // rule's position in that file — the identity the reason string reports,
  // because a combined-list index shifts by however many user rules exist and
  // an operator cannot compute it from the one file `[rule N, <layer>]` names
  // (issue #59 round-2 panel, executed counterexample; ADR-0031).
  const userRules = rules.filter((rule) => rule.layer === 'user');
  const projectRules = rules.filter((rule) => rule.layer === 'project');

  return {
    evaluate(tool: string, args: unknown): Evaluation {
      const target = extractMatchTarget(tool, args);
      const targetKind = TOOL_TARGET_FIELDS[tool]?.kind;
      const winners = [
        layerWinner(userRules, tool, target, targetKind),
        layerWinner(projectRules, tool, target, targetKind),
      ].filter((winner): winner is Winner => winner !== null);

      let winner: Winner | null = null;
      for (const candidate of winners) {
        if (winner === null || SEVERITY[candidate.rule.decision] > SEVERITY[winner.rule.decision]) {
          winner = candidate;
        }
      }

      if (winner === null) {
        return {
          decision: defaultDecision,
          ruleIndex: null,
          layer: null,
          reason: `permission: default ${defaultDecision} (no matching rule)`,
        };
      }
      return {
        decision: winner.rule.decision,
        ruleIndex: winner.index,
        layer: winner.rule.layer,
        reason: `permission: ${describeRule(winner.rule, winner.index)}`,
      };
    },
  };
}

/**
 * Thrown by permissionHook to deny a tool call. Deliberately NOT the hook
 * runtime's HookDenial — security and hooks are import-free peers, and the
 * runtime denies on ANY pre-tool throw, extracting `message` as the reason
 * (runtime.ts reasonOf). Same contract, no layering violation.
 */
export class PermissionDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDenied';
  }
}

/**
 * The one place that decides "a rule allow is an SDK grant" (#140, D-7, D-8;
 * reused by #105 and #189). Only a USER-layer RULE allow qualifies: a project
 * allow and a defaultDecision allow (layer null) are not grants. A tool the
 * policy lists as ungrantable never is. The reason is the ADR-0031 shape (no
 * glob) and reaches telemetry only, never the SDK. Evaluation stays the
 * list/telemetry read model; it does not carry a grant.
 */
export function grantFor(
  tool: string,
  evaluation: Evaluation,
  policy: GrantPolicy,
): PreToolGrant | undefined {
  if (evaluation.decision !== 'allow' || evaluation.layer !== 'user') return undefined;
  if (policy.ungrantableTools.has(tool)) return undefined;
  return { grant: PRE_TOOL_GRANT_KIND, reason: evaluation.reason };
}

/**
 * Pre-tool hook enforcing the permission model. Throws PermissionDenied on
 * deny; 'ask' resolves via the prompter and fails closed without one, or when
 * the prompter throws/rejects (ADR-0014 §4).
 *
 * An allow resolves through grantFor: a USER-layer rule allow is the SDK grant
 * (ADR-0040 D3, D-7) unless the policy withholds it for that tool (D-8);
 * anything else resolves void, which the session maps to `{}` so the CLI's own
 * floor decides. Deny and ask are unchanged, and an approved ask is not a
 * grant. The policy is REQUIRED so a caller cannot forget it.
 */
export function permissionHook(
  evaluator: PermissionEvaluator,
  prompter: Prompter | undefined,
  grantPolicy: GrantPolicy,
): (payload: PreToolLike) => Promise<void | PreToolGrant> {
  return async (payload) => {
    const result = evaluator.evaluate(payload.tool, payload.args);
    if (result.decision === 'allow') return grantFor(payload.tool, result, grantPolicy);
    if (result.decision === 'deny') {
      throw new PermissionDenied(result.reason);
    }
    if (prompter === undefined) {
      throw new PermissionDenied(`${result.reason} — 'ask' with no prompter configured`);
    }
    let approved: boolean;
    try {
      approved = await prompter({ tool: payload.tool, args: payload.args, reason: result.reason });
    } catch {
      throw new PermissionDenied(`${result.reason} — prompter failed`);
    }
    if (!approved) {
      throw new PermissionDenied(`${result.reason} — declined by prompter`);
    }
    return undefined;
  };
}
