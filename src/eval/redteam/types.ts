import type { Verdict } from '../../security/index.js';

export const CATEGORIES = ['direct', 'indirect', 'jailbreak', 'exfil', 'benign'] as const;
export type Category = (typeof CATEGORIES)[number];

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
