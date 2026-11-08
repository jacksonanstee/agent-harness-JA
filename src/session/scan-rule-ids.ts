import type { ScanResult } from '../security/index.js';

/**
 * Rule ids from the injected scanner, reduced to identifiers (issue #234
 * review). `scanInjection` is caller-supplied code whose input is the raw tool
 * output or a skill body, and its `rule_ids` reach the warning channel, the
 * skill-drop row, `SessionResult.droppedSkills` and the model-facing note. A
 * scanner that echoes its input into an id would carry a secret into all of
 * them. Every shipped id (the heuristic rules and the judge's) matches
 * RULE_ID; anything else becomes NON_CONFORMING_RULE_ID. The placeholder is
 * not a stripped-before-prompt id, so a block that carried one still blocks.
 */
export const RULE_ID = /^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$/;
export const RULE_ID_MAX = 64;
export const NON_CONFORMING_RULE_ID = 'non-conforming-rule-id';

const isRuleId = (id: unknown): id is string => typeof id === 'string' && id.length <= RULE_ID_MAX && RULE_ID.test(id);

/** A copy of `result` whose rule ids are all identifiers; a malformed result is returned as is, for the caller's own checks. */
export function withIdentifierRuleIds(result: ScanResult): ScanResult {
  if (typeof result !== 'object' || result === null || !Array.isArray(result.rule_ids)) return result;
  // Array.from visits holes too (map skips them): a sparse array must not yield undefined ids.
  const ids = Array.from(result.rule_ids as unknown[], (id) => (isRuleId(id) ? id : NON_CONFORMING_RULE_ID));
  return { ...result, rule_ids: [...new Set(ids)] };
}
