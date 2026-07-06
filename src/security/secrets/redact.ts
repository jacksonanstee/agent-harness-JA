import { DEFAULT_SECRET_RULES } from './rules.js';
import type {
  RedactorOptions,
  RedactResult,
  SecretFinding,
  SecretRedactor,
  SecretRule,
} from './types.js';

const DEFAULT_MAX_FINDINGS = 50;

/**
 * Hard cap on the text `redact()` scans (128 KiB). Beyond this the tail is
 * dropped and replaced with a marker — NEVER emitted raw. Bounds the
 * synchronous cost of the private-key rule's lazy body on attacker-sized tool
 * output (a >256 KB blob of unterminated `-----BEGIN … PRIVATE KEY-----`
 * headers is otherwise O(len · cap); see ADR-0013). 128 KB dwarfs any real
 * secret-bearing snippet, and the only consumer of the redacted text is a
 * 200-char telemetry summary.
 */
const MAX_INPUT = 131_072;
const OVERSIZED_MARKER = '[REDACTED:oversized-input]';

/**
 * Shannon entropy in bits/char. Used to gate heuristic rules: a real 40-char
 * vendor credential scores ~4+ bits/char, while a repeated-char placeholder
 * scores low.
 */
function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

interface RawMatch {
  ruleId: string;
  ruleIndex: number;
  start: number;
  end: number;
}

/**
 * The token whose entropy is gated: a rule with a capture group gates on group
 * 1 (the secret inside `key = "<secret>"`); otherwise on the whole match.
 */
function gatedToken(match: RegExpMatchArray): string {
  return match[1] ?? match[0];
}

function collectMatches(rule: SecretRule, ruleIndex: number, text: string): RawMatch[] {
  const out: RawMatch[] = [];
  try {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const global = new RegExp(rule.pattern.source, flags);
    for (const match of text.matchAll(global)) {
      if (match.index === undefined) continue;
      if (rule.entropy !== undefined && shannonEntropy(gatedToken(match)) < rule.entropy) {
        continue;
      }
      out.push({
        ruleId: rule.id,
        ruleIndex,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  } catch {
    // One malformed rule must never leave the redactor unable to run.
    return [];
  }
  return out;
}

export function createSecretRedactor(opts: RedactorOptions = {}): SecretRedactor {
  const rules = opts.rules ?? DEFAULT_SECRET_RULES;
  const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS;

  function redact(text: string): RedactResult {
    if (typeof text !== 'string') {
      throw new TypeError(`redact() expects a string, got ${String(text)}`);
    }

    // Cap the scanned length. The dropped tail is replaced with a marker, not
    // emitted raw, so this can never leak; it bounds the private-key rule's
    // worst-case scan on oversized attacker input.
    const oversized = text.length > MAX_INPUT;
    const scanned = oversized ? text.slice(0, MAX_INPUT) : text;

    const candidates: RawMatch[] = [];
    rules.forEach((rule, i) => candidates.push(...collectMatches(rule, i, scanned)));

    // Overlap resolution: earliest start wins; at the same start the longer
    // span wins (a private-key block beats a JWT-shaped line inside it); ties
    // break by rule-table order for determinism. Greedy non-overlapping sweep.
    candidates.sort(
      (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.ruleIndex - b.ruleIndex,
    );

    const accepted: RawMatch[] = [];
    let lastEnd = -1;
    for (const m of candidates) {
      if (m.start >= lastEnd) {
        accepted.push(m);
        lastEnd = m.end;
      }
    }

    // Single-pass rebuild. Redaction is NEVER capped — every accepted span is
    // replaced even past maxFindings; only the findings array is capped.
    let out = '';
    let cursor = 0;
    const findings: SecretFinding[] = [];
    for (const m of accepted) {
      out += scanned.slice(cursor, m.start) + `[REDACTED:${m.ruleId}]`;
      cursor = m.end;
      if (findings.length < maxFindings) {
        findings.push({ rule_id: m.ruleId, start: m.start, end: m.end, length: m.end - m.start });
      }
    }
    out += scanned.slice(cursor);
    // Dropped tail replaced with a marker — never emitted raw.
    if (oversized) out += ` ${OVERSIZED_MARKER}`;

    return { redacted: out, findings };
  }

  return { redact };
}

const defaultRedactor = createSecretRedactor();

/** Module-level default (mirrors injection `scan()` / router `route()`). */
export function redact(text: string): RedactResult {
  return defaultRedactor.redact(text);
}
