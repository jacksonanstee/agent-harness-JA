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
const MATCH_FIELDS: Readonly<Record<string, string>> = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
};

/**
 * Canonical string a rule's `match` glob is tested against. Falls back to the
 * JSON of the args so match rules stay usable on arbitrary tools.
 */
export function extractMatchTarget(tool: string, args: unknown): string {
  const field = MATCH_FIELDS[tool];
  if (field !== undefined && typeof args === 'object' && args !== null) {
    const value = (args as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    // Circular args: nothing sensible to match against; empty string only
    // matches the bare '*' pattern.
    return '';
  }
}

/** 2 = tool + match, 1 = named tool, 0 = wildcard tool. */
function specificity(rule: LayeredRule): number {
  if (rule.match !== undefined) return 2;
  return rule.tool.endsWith('*') ? 0 : 1;
}

function describeRule(rule: LayeredRule, index: number): string {
  const scope = rule.match === undefined ? rule.tool : `${rule.tool}(${rule.match})`;
  return `${rule.decision} ${scope} [rule ${index}, ${rule.layer}]`;
}

export function createPermissionEvaluator(opts: EvaluatorOptions = {}): PermissionEvaluator {
  const rules = opts.rules ?? [];
  const defaultDecision = opts.defaultDecision ?? 'allow';

  return {
    evaluate(tool: string, args: unknown): Evaluation {
      const target = extractMatchTarget(tool, args);
      let winner: { rule: LayeredRule; index: number } | null = null;

      for (const [index, rule] of rules.entries()) {
        if (!matchesGlob(rule.tool, tool)) continue;
        if (rule.match !== undefined && !matchesGlob(rule.match, target)) continue;
        if (
          winner === null ||
          specificity(rule) > specificity(winner.rule) ||
          (specificity(rule) === specificity(winner.rule) &&
            SEVERITY[rule.decision] > SEVERITY[winner.rule.decision])
        ) {
          winner = { rule, index };
        }
      }

      if (winner === null) {
        return {
          decision: defaultDecision,
          ruleIndex: null,
          reason: `default ${defaultDecision} (no matching rule)`,
        };
      }
      return {
        decision: winner.rule.decision,
        ruleIndex: winner.index,
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
