// Issue #145 B2a (ADR-0039): the pure pieces of withholding a judge-flagged
// tool result. No per-run state lives here: session.ts owns the walk, the
// pending entry and the rows; judged-scan.ts owns the predicate over the judge
// record. Nothing in this module is on a barrel (ADR-0023: wire internals).

/** The one token the placeholder carries: the verifier's marker for a withheld result (spec D4). */
export const WITHHELD_MARKER = '[WITHHELD:judge-block]';

/** Cap on the content first lines a withhold adds to its pending entry's span lines (spec D4). */
export const WITHHOLD_SPAN_LINES_MAX = 32;

/**
 * Minimum length of a span line the verifier keys on (#84 D4, S-13; moved
 * here from session.ts so the redaction and withhold oracles share one
 * value). Short spans are too collision-prone to key an alarm on.
 */
export const MIN_SPAN_LINE = 8;

/**
 * The placeholder every non-empty string leaf of a withheld result becomes
 * (spec D1), except a leaf holding a literal the SDK declares for the tool's output (`isShapeLeaf`, issue #203), and, on an MCP tool, a content-block `type` (`isMcpBlockTypeLeaf`, review3 H2). `tool` is
 * the cleaned, bounded tool name the notice uses; no rule id, no excerpt and no attacker byte enters it. Pinned to scan
 * `pass` on the shipped heuristic (W9).
 */
export function withholdPlaceholder(tool: string): string {
  return (
    `${WITHHELD_MARKER} The harness withheld this ${tool} result: its prompt-injection judge ` +
    'classified the content as an attack. Continue the task without it; repeating the call will not return it.'
  );
}

/**
 * The `additionalContext` note for a withheld result (spec D1); today's note
 * says "shown to you unchanged", which would be false. `idText` is the bounded
 * rule-id list today's notice uses (`boundNoticeRuleIds`).
 */
export function withholdNotice(tool: string, idText: string): string {
  return (
    `The harness withheld this ${tool} result (${idText}): its prompt-injection judge classified it as an attack. ` +
    'The placeholder in the result replaced its content.'
  );
}

/**
 * The content span the verifier watches for one withheld leaf (spec D4, S5):
 * the first NON-EMPTY line of at least MIN_SPAN_LINE characters, so a leaf
 * that starts with a blank line, `---` or another short line still records a
 * span (`#!/bin/sh`, 9 chars, is itself a valid span)
 * and a dropped withhold reads `leaked`, not `unobserved`; and never a line
 * the placeholder or the marker CONTAINS, or an applied withhold of such a
 * leaf would read `both-present`. Null when no line qualifies. An attacker who
 * shapes content so that NO span is recorded (every line short, or the marker
 * planted as a line) can force `unobserved` (`no-content-span` when the marker
 * is present, `neither-token` otherwise), never a false `applied`: the verifier
 * refuses `applied` for a withhold entry with no span at all (review3 H1). A
 * blank first line no longer forces it.
 * Held per run only, like secret spans (G-5, G-11).
 */
export function withholdSpanLine(leaf: string, placeholder: string): string | null {
  for (const line of leaf.split('\n')) {
    if (line.trim().length < MIN_SPAN_LINE) continue;
    if (placeholder.includes(line) || WITHHELD_MARKER.includes(line)) continue;
    return line;
  }
  return null;
}
