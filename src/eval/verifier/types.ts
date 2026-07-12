/**
 * E-4 verifier contract (ADR-0020). Findings are closed enums — no adversary
 * prose ever reaches a scorecard, rendering, or terminal.
 */

export const CHALLENGE_CATEGORIES = [
  'incomplete', 'incorrect', 'unsupported-claim', 'unsafe', 'other',
] as const;
export type ChallengeCategory = (typeof CHALLENGE_CATEGORIES)[number];

export type ChallengeStatus = 'agreed' | 'challenged' | 'verifier-error' | 'no-output';
export type ChallengeErrorKind = 'call-failed' | 'unparseable' | 'unknown-enum' | 'redaction-failed';

export interface ChallengeFinding {
  taskId: string;
  status: ChallengeStatus;
  category: ChallengeCategory | null;   // non-null iff status === 'challenged'
  errorKind: ChallengeErrorKind | null; // non-null iff status === 'verifier-error'
}

export interface AdversaryResult { text: string; costUsd: number | null; }
export type AdversaryFn = (prompt: string) => Promise<AdversaryResult>;

export const ADVERSARY_TIMEOUT_MS = 60_000;
export const MAX_ADVERSARY_RESPONSE_BYTES = 131_072; // redact.ts MAX_INPUT precedent

export interface ChallengeInput {
  taskId: string;
  taskPrompt: string;
  redactedResultText: string;
}

export interface Verifier {
  /** Routed model id — the runner cannot learn it any other way. */
  adversaryModelId: string;
  challenge(input: ChallengeInput): Promise<{ finding: ChallengeFinding; costUsd: number | null }>;
}
