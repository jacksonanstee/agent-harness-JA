import type { Verdict } from '../../security/index.js';

export const CATEGORIES = ['direct', 'indirect', 'jailbreak', 'exfil', 'benign'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Single source of truth for the redteam arm label (design SK5): the CLI,
 *  the baseline e2e, and the drift diagnostic all derive from this constant
 *  so the committed baseline can never split-brain against the live run. */
export const REDTEAM_ARM_LABEL = 'security-on';

/** Eval-native case (named CorpusCase, NOT RedTeamCase — avoids colliding
 *  with the security barrel's type in the one layer that imports it;
 *  decision log CG10). `category` is the eval taxonomy, distinct from the
 *  scanner's RuleFamily. */
export interface CorpusCase {
  id: string;
  category: Category;
  text: string;
  expected: Verdict;
  source?: string;
}
