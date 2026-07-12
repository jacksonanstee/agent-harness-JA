import { randomBytes } from 'node:crypto';
import { buildChallengePrompt } from './prompt.js';
import { parseAdversaryResponse } from './parse.js';
import { ADVERSARY_TIMEOUT_MS } from './types.js';
import type { AdversaryFn, AdversaryResult, ChallengeFinding, ChallengeInput, Verifier } from './types.js';

// Adversary failure can never alter the authoritative result (spec
// formulation, shared with ADR-0020): every failure here becomes a
// verifier-error finding; nothing throws out of challenge().
export function createVerifier(deps: {
  adversary: AdversaryFn;
  adversaryModelId: string;
  randomHex?: () => string;
  timeoutMs?: number;
}): Verifier {
  const randomHex = deps.randomHex ?? (() => randomBytes(8).toString('hex'));
  const timeoutMs = deps.timeoutMs ?? ADVERSARY_TIMEOUT_MS;

  const callWithTimeout = (prompt: string): Promise<AdversaryResult> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('adversary call timed out')), timeoutMs);
      // The orphaned call may still settle later; both handlers are attached
      // now, so its settlement is consumed (never an unhandled rejection)
      // and resolve/reject after settlement is a no-op.
      deps.adversary(prompt).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (cause) => { clearTimeout(timer); reject(cause instanceof Error ? cause : new Error(String(cause))); },
      );
    });

  return {
    adversaryModelId: deps.adversaryModelId,
    async challenge(input: ChallengeInput) {
      const errorFinding = (errorKind: ChallengeFinding['errorKind']): ChallengeFinding => ({
        taskId: input.taskId, status: 'verifier-error', category: null, errorKind,
      });
      let result: AdversaryResult;
      try {
        result = await callWithTimeout(buildChallengePrompt(input, randomHex));
      } catch {
        return { finding: errorFinding('call-failed'), costUsd: null };
      }
      const wire = parseAdversaryResponse(result.text);
      if (!wire.ok) return { finding: errorFinding(wire.errorKind), costUsd: result.costUsd };
      const finding: ChallengeFinding =
        wire.verdict === 'agree'
          ? { taskId: input.taskId, status: 'agreed', category: null, errorKind: null }
          : { taskId: input.taskId, status: 'challenged', category: wire.category, errorKind: null };
      return { finding, costUsd: result.costUsd };
    },
  };
}
