import { Ajv2020 } from 'ajv/dist/2020.js';
import { CHALLENGE_CATEGORIES, MAX_ADVERSARY_RESPONSE_BYTES } from './types.js';
import type { ChallengeCategory } from './types.js';

export type ParsedWire =
  | { ok: true; verdict: 'agree' }
  | { ok: true; verdict: 'challenge'; category: ChallengeCategory }
  | { ok: false; errorKind: 'unparseable' | 'unknown-enum' };

// category validates as STRING in-schema; enum membership is checked after
// validation so out-of-enum is 'unknown-enum', not 'unparseable' (spec
// §Prompt hardening — keeps both errorKinds reachable and distinct).
const WIRE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: { verdict: { const: 'agree' } },
      required: ['verdict'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { verdict: { const: 'challenge' }, category: { type: 'string' } },
      required: ['verdict', 'category'],
      additionalProperties: false,
    },
  ],
} as const;

const ajv = new Ajv2020({ allErrors: false });
const validateWire = ajv.compile<{ verdict: 'agree' } | { verdict: 'challenge'; category: string }>(
  WIRE_SCHEMA as object,
);

export function parseAdversaryResponse(text: string): ParsedWire {
  if (Buffer.byteLength(text, 'utf8') > MAX_ADVERSARY_RESPONSE_BYTES) {
    return { ok: false, errorKind: 'unparseable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return { ok: false, errorKind: 'unparseable' };
  }
  if (!validateWire(parsed)) return { ok: false, errorKind: 'unparseable' };
  if (parsed.verdict === 'agree') return { ok: true, verdict: 'agree' };
  const category = parsed.category;
  if (!(CHALLENGE_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, errorKind: 'unknown-enum' };
  }
  return { ok: true, verdict: 'challenge', category: category as ChallengeCategory };
}
