import { sanitizeControlChars } from '../../internal/sanitize.js';
import { DEFAULT_INJECTION_RULES } from './rules.js';
import type {
  Confidence,
  InjectionRule,
  InjectionScanner,
  ScannerOptions,
  ScanResult,
} from './types.js';

const DEFAULT_MAX_EXCERPTS = 10;
const DEFAULT_MAX_EXCERPT_LENGTH = 120;

/**
 * Zero-width characters used to smuggle text past pattern matching. The class
 * deliberately includes ZWJ/ZWNJ (`\u200C\u200D`) \u2014 we are hunting them, not
 * rendering text \u2014 so the misleading-character-class lint does not apply.
 */
// eslint-disable-next-line no-misleading-character-class
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/gu;
/** Unicode tag block (U+E0000–U+E007F): no legitimate use in tool output. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
/**
 * Characters an attacker can interleave between letters to defeat plaintext
 * pattern matching while leaving rendered text visually unchanged: zero-width
 * chars, combining marks (U+0300-036F), variation selectors (U+FE00-FE0F,
 * U+E0100-E01EF), bidi format/override + isolate controls (U+202A-202E,
 * U+2066-2069 -- the "Trojan Source" class, CVE-2021-42574), and tag chars.
 * Stripped before the re-scan pass so a smuggled phrase is revealed; stripping
 * (not reporting) keeps false positives low, since combining marks are
 * legitimate in NFD-form accented text.
 */
// eslint-disable-next-line no-misleading-character-class
const SMUGGLING_CHARS = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD\u0300-\u036F\uFE00-\uFE0F\u202A-\u202E\u2066-\u2069\u{E0100}-\u{E01EF}\u{E0000}-\u{E007F}]/gu;
/**
 * Lone joiners are legitimate (emoji ZWJ sequences, Indic scripts); a run of
 * three or more zero-width characters is reported as a `zero-width-run` hit.
 * The re-scan pass triggers on ANY smuggling char, so a two-char interruption
 * is still revealed without inflating false positives.
 */
const ZERO_WIDTH_THRESHOLD = 3;

/** Hidden-unicode detector ids share the rule id/confidence contract. */
const UNICODE_TAG_RULE = { id: 'unicode-tag-chars', confidence: 'high' as Confidence };
const ZERO_WIDTH_RULE = { id: 'zero-width-run', confidence: 'medium' as Confidence };

interface Hit {
  id: string;
  confidence: Confidence;
  excerpt: string;
}

function safeMatch(rule: InjectionRule, text: string): string[] {
  try {
    // matchAll needs a global regex; clone with the g flag preserved/added.
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const global = new RegExp(rule.pattern.source, flags);
    return [...text.matchAll(global)].map((m) => m[0]);
  } catch {
    // One malformed rule must never take the scanner down (router precedent).
    return [];
  }
}

function contextExcerpt(text: string, index: number, span: number): string {
  const start = Math.max(0, index - 20);
  return text.slice(start, index + span + 20);
}

export function createInjectionScanner(opts: ScannerOptions = {}): InjectionScanner {
  const rules = opts.rules ?? DEFAULT_INJECTION_RULES;
  const maxExcerpts = opts.maxExcerpts ?? DEFAULT_MAX_EXCERPTS;
  const maxExcerptLength = opts.maxExcerptLength ?? DEFAULT_MAX_EXCERPT_LENGTH;
  // opts.judge is the S-5 seam: typed and accepted, unused in the heuristic
  // stage (ADR-0012 — the async judge wrapper is additive).

  function cleanExcerpt(raw: string): string {
    // Strip smuggling chars (incl. bidi controls) then C0/C1 controls, so an
    // excerpt reaching a log/terminal can carry neither escapes nor a
    // Trojan-Source visual reorder.
    const clean = sanitizeControlChars(raw.replace(SMUGGLING_CHARS, ''));
    return clean.length > maxExcerptLength ? `${clean.slice(0, maxExcerptLength)}…` : clean;
  }

  function runRules(text: string): Hit[] {
    const hits: Hit[] = [];
    for (const rule of rules) {
      for (const matched of safeMatch(rule, text)) {
        hits.push({ id: rule.id, confidence: rule.confidence, excerpt: cleanExcerpt(matched) });
      }
    }
    return hits;
  }

  function scan(text: string): ScanResult {
    if (typeof text !== 'string') {
      throw new TypeError(`scan() expects a string, got ${String(text)}`);
    }

    const hits: Hit[] = runRules(text);

    // Hidden-unicode detection + strip-and-rescan (ADR-0005: "strip and
    // re-scan"). Rules that only fire on the stripped text prove smuggling.
    const tagMatches = [...text.matchAll(TAG_CHARS)];
    if (tagMatches.length > 0) {
      const first = tagMatches[0];
      hits.push({
        ...UNICODE_TAG_RULE,
        excerpt: cleanExcerpt(contextExcerpt(text, first?.index ?? 0, 1)),
      });
    }
    const zeroWidthMatches = [...text.matchAll(ZERO_WIDTH)];
    if (zeroWidthMatches.length >= ZERO_WIDTH_THRESHOLD) {
      const first = zeroWidthMatches[0];
      hits.push({
        ...ZERO_WIDTH_RULE,
        excerpt: cleanExcerpt(contextExcerpt(text, first?.index ?? 0, 1)),
      });
    }
    // Re-scan on ANY smuggling char (not just a ≥3 zero-width run): a two-char
    // interruption is enough to evade the plaintext rules, so the trigger is
    // decoupled from the reportable `zero-width-run` hit.
    const smuggled = [...text.matchAll(SMUGGLING_CHARS)];
    if (smuggled.length > 0) {
      const stripped = text.replace(SMUGGLING_CHARS, '');
      // Dedup by id AND excerpt: a rule may fire on both raw and stripped text
      // with different excerpts, and the stripped excerpt is the smuggled
      // evidence we want to keep. NUL separator can't appear in a kebab id, so
      // (id, excerpt) pairs never collide across the boundary.
      const seen = new Set(hits.map((h) => `${h.id}\u0000${h.excerpt}`));
      for (const hit of runRules(stripped)) {
        const key = `${hit.id}\u0000${hit.excerpt}`;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push(hit);
        }
      }
    }

    const ruleIds: string[] = [];
    const excerpts: string[] = [];
    let high = false;
    let medium = false;
    for (const hit of hits) {
      if (hit.confidence === 'high') high = true;
      else medium = true;
      // rule_ids is bounded by the rule-table size and is not capped by
      // maxExcerpts (an excerpt budget) — under-reporting which rules fired
      // would mislead audit/telemetry consumers.
      if (!ruleIds.includes(hit.id)) ruleIds.push(hit.id);
      if (excerpts.length < maxExcerpts && !excerpts.includes(hit.excerpt)) {
        excerpts.push(hit.excerpt);
      }
    }

    const verdict = high ? 'block' : medium ? 'ask' : 'pass';
    return { verdict, rule_ids: ruleIds, excerpts, suspicious: verdict === 'ask' };
  }

  return { scan };
}

const defaultScanner = createInjectionScanner();

/** Module-level default (router `route()` precedent). */
export function scan(text: string): ScanResult {
  return defaultScanner.scan(text);
}
