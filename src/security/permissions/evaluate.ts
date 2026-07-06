import { resolve, sep } from 'node:path';

import type {
  Evaluation,
  EvaluatorOptions,
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

/** Tools whose canonical match target is a well-known string arg. */
const MATCH_FIELDS: Readonly<Record<string, { field: string; isPath: boolean }>> = {
  Bash: { field: 'command', isPath: false },
  Read: { field: 'file_path', isPath: true },
  Write: { field: 'file_path', isPath: true },
  Edit: { field: 'file_path', isPath: true },
};

/**
 * Canonical string a rule's `match` glob is tested against. File paths are
 * resolved to absolute canonical form first (collapsing `.`/`..`, anchoring
 * relative paths at cwd) so `/etc/*` cannot be dodged with
 * `/tmp/../etc/passwd` and an allow-prefix cannot be escaped with `..`
 * segments. Falls back to the JSON of the args for unknown tools — a
 * caller-shaped surface, so match rules on arbitrary tools are best-effort
 * only (ADR-0014 §1).
 */
export function extractMatchTarget(tool: string, args: unknown): string {
  const spec = MATCH_FIELDS[tool];
  if (spec !== undefined && typeof args === 'object' && args !== null) {
    const value = (args as Record<string, unknown>)[spec.field];
    if (typeof value === 'string') {
      return spec.isPath ? resolve(value) : value;
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
    return `${resolve(prefix)}${keepSep ? sep : ''}*`;
  }
  return resolve(pattern);
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

function describeRule(rule: LayeredRule, index: number): string {
  const scope = rule.match === undefined ? rule.tool : `${rule.tool}(${rule.match})`;
  return `${rule.decision} ${scope} [rule ${index}, ${rule.layer}]`;
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
  targetIsPath: boolean,
): Winner | null {
  let winner: Winner | null = null;
  for (const [index, rule] of rules.entries()) {
    if (!matchesGlob(rule.tool, tool)) continue;
    if (rule.match !== undefined) {
      const pattern = targetIsPath ? canonicalizePathPattern(rule.match) : rule.match;
      if (!matchesGlob(pattern, target)) continue;
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
  // Rule indexes are positions in the combined list, but the winner is
  // resolved PER LAYER and then combined by MAX SEVERITY across layers: a
  // project layer can tighten the user's policy but can never loosen it, no
  // matter how specific its rules are (ADR-0014 §5 — sticky deny is
  // cross-layer, specificity is intra-layer only).
  const userRules = rules.filter((rule) => rule.layer === 'user');
  const projectRules = rules.filter((rule) => rule.layer === 'project');
  const indexOfRule = new Map(rules.map((rule, index) => [rule, index]));

  return {
    evaluate(tool: string, args: unknown): Evaluation {
      const target = extractMatchTarget(tool, args);
      const targetIsPath = MATCH_FIELDS[tool]?.isPath ?? false;
      const winners = [
        layerWinner(userRules, tool, target, targetIsPath),
        layerWinner(projectRules, tool, target, targetIsPath),
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
          reason: `permission: default ${defaultDecision} (no matching rule)`,
        };
      }
      const index = indexOfRule.get(winner.rule) ?? winner.index;
      return {
        decision: winner.rule.decision,
        ruleIndex: index,
        reason: `permission: ${describeRule(winner.rule, index)}`,
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
 * Structural subset of the hooks PreToolPayload — typed locally so security
 * never imports hooks (peer-leaf rule). Assignable to HookHandler<'pre-tool'>
 * at the composition root.
 */
export interface PreToolLike {
  readonly tool: string;
  readonly args: unknown;
}

/**
 * Pre-tool hook enforcing the permission model. Throws PermissionDenied on
 * deny; 'ask' resolves via the prompter and fails closed without one, or when
 * the prompter throws/rejects (ADR-0014 §4).
 */
export function permissionHook(
  evaluator: PermissionEvaluator,
  prompter?: Prompter,
): (payload: PreToolLike) => Promise<void> {
  return async (payload) => {
    const result = evaluator.evaluate(payload.tool, payload.args);
    if (result.decision === 'allow') return;
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
  };
}
