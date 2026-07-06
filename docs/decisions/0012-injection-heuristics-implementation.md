# ADR-0012: Injection scanner — heuristic-stage implementation

- **Status:** Accepted
- **Date:** 2026-07-06
- **Requirements:** S-1 (MUST), S-5 (SHOULD — seam only)
- **Refines:** ADR-0005 (hybrid heuristic + LLM-judge)

## Context

ADR-0005 committed the hybrid design; architecture.md committed the API
`scan(text): ScanResult { verdict, rule_ids[], excerpts[] }` and the layering
(security below harness; judge injected). This ADR records the S-1
implementation decisions ADR-0005 left open, and defines the S-5 seam without
building it.

## Decisions

1. **Rule schema: regex-based.** Input is arbitrary text (unlike the router's
   structured descriptor), so regexes are the natural matcher and yield
   excerpts for free. `InjectionRule { id (kebab), family, confidence, pattern,
   description }` in an injectable `DEFAULT_INJECTION_RULES` array (router table
   precedent).
2. **Discrete confidence tiers `'high' | 'medium'`,** not numeric scores —
   matches ADR-0005's language and avoids an uncalibrated scale. Numbers can
   come later from the S-5 judge if data warrants.
3. **Verdict lattice:** evaluate **all** rules (complete `rule_ids` for
   telemetry/eval, no first-match short-circuit); any high hit → `block`, else
   any medium hit → `ask`, else `pass`. Empty/whitespace → `pass`; non-string →
   `TypeError`.
4. **Sync `scan()`; the S-5 judge is a structural seam, not a callback.**
   `ScanResult.suspicious` (true on medium-only `ask`) is the escalation
   trigger; `ScannerOptions.judge` / `InjectionJudge` are typed but unused in
   S-1. S-5 will add an async `scanWithJudge` wrapper that runs the heuristic
   then escalates per `judge: off|suspicious|always`, calling the SDK directly
   via the injected judge. Keeping the primitive sync means hot-path callers
   pay zero async cost; ADR-0005's "pipeline" lives in the wrapper.
5. **Strip-and-rescan for hidden Unicode.** Detect Unicode tag chars
   (U+E0000–E007F; ≥1 = high, essentially no legit use) and zero-width runs
   (≥3 chars = medium; a lone ZWJ is legitimate in emoji/Indic text), then
   strip both and re-scan with the text rules. A rule that fires only
   post-strip is reported alongside the carrier rule — smuggling proven. These
   two detectors live in the scan pipeline (they need occurrence counting), not
   the rule table, but share the id/confidence contract. **No NFKC in v1** —
   compatibility normalization can *create* matches and needs its own
   false-positive analysis; deferred.
6. **Blob thresholds, both medium (`ask`, never `block`).** Base64 run ≥60
   chars (≈45 decoded bytes — above hashes/JWT headers/short tokens); hex ≥80
   chars. Legit tool outputs (images, lockfiles, certs, digests) contain long
   base64/hex, so blocking would blow the false-positive budget; `ask` lets the
   S-5 judge or a human adjudicate.
7. **ReDoS policy.** Every pattern is linear-time (single-level quantifiers,
   bounded repetition over disjoint classes, no backreferences, no lookbehind),
   enforced by a guard test running each rule against ~120 KB pathological
   inputs with a <100 ms bound. `safeMatch` wraps each rule in try/catch so one
   malformed rule can't crash `scan()` (router precedent).
8. **Excerpts** are stripped of hidden Unicode, control-char-sanitized
   (`src/internal/sanitize.ts`), truncated (120 chars), deduped, and capped
   (10) — they reach logs/telemetry and must not carry escapes.
9. **Session wiring observes only.** The scanner runs on the **full** tool
   output (not the truncated telemetry summary) and its `ScanResult` feeds the
   post-tool hook's `scan` field (architecture step 10). Block/ask verdicts
   warn; the run continues. **Enforcement (`on_block` redact/drop/error) is
   deliberately NOT in S-1** — it composes with S-2 redaction and lands with
   the secret scanner. No config-file parsing yet (composition-root work).

## Amends

- ADR-0005 said "logged with … rule ID" (singular); the shipped API uses plural
  `rule_ids[]` / `excerpts[]` (architecture.md `ScanResult`) since a single
  input can trip several rules.

## Alternatives considered

1. **Match-function rules (router style).** Rejected — text input makes regex
   the natural fit and gives excerpts without extra code.
2. **Numeric confidence scores.** Rejected — nothing to calibrate against yet.
3. **Async `scan()` with the judge inline.** Rejected — forces async on every
   hot-path caller for a stage that's off by default; the wrapper seam is
   cheaper.
4. **First-match short-circuit.** Rejected — loses `rule_ids` completeness the
   eval scorecard and telemetry want.

## Revisit if

- Red-team pass rate on the Week-3 corpus drops below 90% → rework rules or
  land S-5 sooner.
- NFKC-based evasion appears in the corpus → add a normalization pass with its
  own FP suite.
- A telemetry event type for scan verdicts is wanted → new `telemetry_events`
  CHECK-constraint migration (currently scan results ride only the hook payload
  + warnings).
- Enforcement is needed before S-2 → revisit the observe-only decision (§9).
