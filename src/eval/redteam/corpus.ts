// Red-team corpus. PAYLOAD DEFANG CONVENTION (ADR-0018): credential-shaped
// literals are assembled from fragments, assignment shapes (token=..,
// key: ..) avoided or split, exfil URLs use non-resolving .example/.invalid
// domains — so authoring a faithful payload never trips secret-scan.sh
// --staged or GitHub push protection.
import { STARTER_CORPUS, type RedTeamCase, type RuleFamily } from '../../security/index.js';
import type { Category, CorpusCase } from './types.js';

const FAMILY_TO_CATEGORY: Record<RuleFamily | 'benign', Category> = {
  'direct-instruction': 'direct',
  'encoded-blob': 'direct',
  'hidden-unicode': 'direct',
  'role-impersonation': 'jailbreak',
  exfil: 'exfil',
  benign: 'benign',
};

const fromStarter = (c: RedTeamCase): CorpusCase => ({
  id: c.id,
  category: FAMILY_TO_CATEGORY[c.family],
  text: c.text,
  expected: c.expectedVerdict,
  source: c.source ?? 'starter-corpus (S-1)',
});

const NEW_CASES: readonly CorpusCase[] = [
  // filled in Task 3b
];

export const CORPUS: readonly CorpusCase[] = [
  ...STARTER_CORPUS.map(fromStarter),
  ...NEW_CASES,
];
