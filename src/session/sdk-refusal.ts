import { sanitizeControlChars, stripBidi, stripInvisibles, truncateWellFormed } from '../internal/sanitize.js';
import type { SdkMessage, SdkModelRefusalMessage, SdkResultMessage } from './types.js';

// The SDK's refusal signals, one home for the session (ADR-0025) and the S-5
// judge (issue #148). Hoisted from session.ts when the judge became the
// second reader: two copies of a security-relevant detector had already
// drifted (different subtype gating, a raw versus a cleaned `stop_reason`),
// so the session and the judge now read the same two channels the same way.

/**
 * The SDK's refusal banners (ADR-0025). Absent from older CLIs, hence the
 * second channel.
 *
 * Declared as an exhaustive record keyed by the message's own `subtype` union,
 * NOT as a `ReadonlySet<...subtype>`. The set form looks like it pins the two
 * declarations together but does not: method-parameter bivariance makes
 * `Set<'a'|'b'>` assignable to `ReadonlySet<'a'|'b'|'c'>`, so widening the union
 * and forgetting the runtime gate compiles clean (verified with tsc), which is
 * precisely the silent-detection-gap direction that matters. A keyed record
 * fails both ways: a new union member is a missing-property error, and a
 * removed one is an excess-property error. The Set is derived from its keys so
 * there is one source of truth and `has()` stays prototype-safe.
 */
const REFUSAL_SUBTYPE_GATE: Record<SdkModelRefusalMessage['subtype'], true> = {
  model_refusal_no_fallback: true,
  model_refusal_fallback: true,
};

const REFUSAL_SUBTYPES: ReadonlySet<string> = new Set(Object.keys(REFUSAL_SUBTYPE_GATE));

export function isModelRefusal(message: SdkMessage): message is SdkModelRefusalMessage {
  return (
    message.type === 'system' &&
    REFUSAL_SUBTYPES.has((message as SdkModelRefusalMessage).subtype)
  );
}

/**
 * Cap on a short SDK-supplied token before it reaches a retained sink. The SDK
 * calls both `api_refusal_category` and `stop_reason` open strings ("new
 * categories ship on the wire ahead of schema updates"), so nothing in the
 * contract bounds either to a short token, and every other persisted string in
 * this module is bounded.
 */
const SDK_TOKEN_LIMIT = 100;

/**
 * Cleans a short SDK token (`api_refusal_category`, `fallback_model`,
 * `stop_reason`). Same charset contract as `cleanSkillText`, for the same
 * reason: these values reach a terminal line whose whole job is to tell an
 * operator that a DIFFERENT model answered their turn, so a bidi override that
 * visually reorders a model name defeats the one guarantee the line makes.
 * Control chars alone are not enough (review finding, empirically
 * demonstrated: U+202E survived `sanitizeControlChars` and
 * `sanitizeForTerminal` all the way to stderr). Bounded too, because an open
 * string reaching two retained sinks needs a cap.
 *
 * NOT for prose: `truncate` (200 chars, redacted first) owns `resultText` and
 * `prompt`. This is for short vendor tokens only.
 */
export function cleanSdkToken(text: string): string {
  // Trimmed because stripping substitutes SPACES: without it, `stop_reason`
  // values like "refusal<U+202E>" clean to "refusal " and silently miss the
  // === 'refusal' comparison, so a single trailing smuggled char disabled the
  // whole second detection channel (verify-pass finding). Also kills the
  // leading-space variant.
  // Internal whitespace collapses to '_': none of these tokens legitimately
  // contains a space ('cyber', 'claude-sonnet-5', 'end_turn'), and the two
  // `[harness]` lines are space-delimited `key=value` pairs, so a space-bearing
  // token could forge a sibling field. Quoting at the sink is belt-and-braces;
  // this closes it even for a naive `grep -o 'fallback=[^ ]*'` (verify-pass
  // finding). Runs after the strip pass, which itself substitutes spaces.
  const clean = stripInvisibles(stripBidi(sanitizeControlChars(text)))
    .trim()
    .replace(/\s+/g, '_');
  // Well-formed: a naive slice can emit a lone surrogate, and these values
  // reach a public API field.
  return truncateWellFormed(clean, SDK_TOKEN_LIMIT);
}

/**
 * The second channel: a result whose cleaned `stop_reason` is `refusal`
 * (ADR-0025). Cleaned first, so an invisible or bidi character the provider
 * appends cannot hide it.
 */
export function isRefusalStopReason(result: SdkResultMessage): boolean {
  return typeof result.stop_reason === 'string' && cleanSdkToken(result.stop_reason) === 'refusal';
}

/**
 * A provider refusal on either channel: a `model_refusal_*` banner, or a
 * result whose `stop_reason` is `refusal`. Both are SDK-stream signals; a
 * model's reply text arrives only in `result.result` and cannot forge them.
 */
export function isProviderRefusal(message: SdkMessage): boolean {
  if (isModelRefusal(message)) return true;
  return message.type === 'result' && isRefusalStopReason(message as SdkResultMessage);
}
