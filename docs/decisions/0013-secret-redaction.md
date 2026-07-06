# ADR-0013: Secret scanner — pattern set, redaction, and leak-safe findings

- **Status:** Accepted
- **Date:** 2026-07-06
- **Requirements:** S-2 (MUST)
- **Relates to:** ADR-0011 (telemetry retention finding), ADR-0012 (S-1 observe-only precedent)

## Context

S-2 requires: "Secret patterns (API keys, tokens, private keys) are scanned in
tool inputs and outputs; matches are redacted with a logged event," verified by
"≥20 secret patterns drawn from trufflehog/gitleaks." architecture.md commits
`redact(text): { redacted, findings: SecretFinding[] }` and the `[REDACTED:<id>]`
format. This deliverable also closes ADR-0011's retention finding: tool output
reaches the (indefinitely-retained) telemetry store, so secrets must be redacted
before they get there.

## Decisions

1. **Module `src/security/secrets/`** mirrors the S-1 injection module:
   `createSecretRedactor(opts)` factory + module-level `redact()`, injectable
   `DEFAULT_SECRET_RULES`, per-rule `safeMatch`-style isolation, ReDoS-bounded
   patterns + guard test.
2. **25 rules (≥20 distinct testable)** derived from gitleaks/trufflehog:
   structural high-precision tokens (AWS key id, GitHub PAT/fine-grained/OAuth/
   app, GitLab, Slack token+webhook, Stripe live/test, Google, GCP SA, OpenAI
   project+legacy, Anthropic, npm, PyPI, SendGrid, Mailgun, JWT, PEM private-key
   block, basic-auth-in-URL) plus 3 **entropy-gated heuristic**
   rules (AWS secret key, Twilio SK+hex, generic keyword-anchored assignment).
3. **No bare generic-entropy rule.** gitleaks' unanchored `generic-api-key`
   over-matches code-heavy tool output; the keyword-anchored
   `generic-keyword-secret` (with the entropy gate) covers the realistic case.
   Deferred with this note.
4. **Entropy gate.** Heuristic rules fire only when the matched token's Shannon
   entropy ≥ threshold (bits/char), gating on the capture group when present.
   a low-entropy placeholder value is skipped; a real 40-char AWS secret is
   caught.
5. **`SecretFinding { rule_id, start, end, length }` — leak-safe by
   construction.** It carries no content: not the secret, not a masked preview,
   not prefix/suffix chars (any preview leaks bytes into the very logs/telemetry
   we are protecting). Offsets are safe because the surrounding sink text is
   already redacted. A property test asserts the findings JSON contains no
   ≥8-char slice of any planted secret.
6. **Redaction algorithm.** Collect all matches (entropy-gated), resolve
   overlaps by earliest-start-then-longest-span-then-rule-order and greedily
   accept non-overlapping spans (a private-key block beats a JWT-shaped line
   inside it), single-pass rebuild replacing each span with `[REDACTED:<id>]`.
   **Redaction is never capped** — `maxFindings` bounds only the findings array,
   never leaving a secret in the text. Idempotent (markers can't match any rule;
   locked by test). `TypeError` on non-string.
7. **Session integration — redact before telemetry (the retention fix).** In
   `postToolCallback`, redaction runs on the stringified tool output **before**
   the `tool-trace` telemetry record, so a secret never reaches the retained
   store. **Fail-closed for telemetry:** if the redactor throws, the telemetry
   text is the sentinel `[REDACTION FAILED]`, never the raw output; the run
   continues (fail-open for the pipeline). Findings fill the post-tool hook
   `redactions` slot (S-1 left it `null`).
8. **Inputs scanned too (S-2 "inputs and outputs").** `preToolCallback` redacts
   the stringified tool arguments, warns on findings, and passes them into a new
   `redactions` field on `PreToolPayload` (typed `unknown`, like `scan`, to keep
   hooks import-free of security).
9. **Observe-only (documented limitation, shared with S-1).**
   `SdkHookOutput` allows only a PreToolUse `deny`; PostToolUse returns `{}` —
   neither hook can rewrite `tool_input`/`tool_output`. So S-2 redacts
   everything the **harness** persists or emits (telemetry, warnings, hook
   `redactions` payload) — satisfying "redacted with a logged event" for the
   harness data plane — but the **model still sees the raw** tool result and the
   tool still receives the raw input. This is the same SDK constraint that
   deferred S-1's block/drop gating (ADR-0012 §9).
   - **Deliberate exception — the post-tool hook `result`/`scan` fields carry
     RAW bytes** (a hook may need real content to act; injection detection needs
     raw text). These are typed `unknown` with a doc warning that handlers must
     redact before persisting/forwarding. Only the built-in `onEvent` sink
     consumes hooks and it never reads `result`, so nothing leaks today; the
     warning guards future/third-party handlers.
   - **Scope of the combined follow-up:** only the model-facing *output* paths
     (S-1 block/drop + S-2 output rewriting) share the missing SDK capability.
     Secret-in-*input* enforcement is buildable now (`SdkPreToolDenyOutput`
     exists → deny the call), but is deliberately NOT built: a secret in tool
     input is often legitimate, so denial would be over-eager. Redact-and-log
     is the right input-side default for v1.

## Alternatives considered

1. **Masked preview in findings** (`AKIA…MPLE`). Rejected — still leaks bytes of
   the secret into logs/telemetry, defeating the purpose.
2. **Bare high-entropy generic scanning.** Rejected — unacceptable FP rate on
   code/base64-heavy tool output (§3).
3. **First-match / no overlap handling.** Rejected — nested matches (JWT inside
   a key block) would double-redact or leave fragments; longest-span greedy is
   deterministic and clean.
4. **Confidence tiers like S-1.** Rejected — redaction is binary; `precision` +
   `entropy` is all that's needed to separate structural from heuristic rules.

## Review amendments (2026-07-06, 3-agent gate)

- **HIGH (security) — oversized private-key leak fixed.** A key body over the
  old 8192-char lazy cap left the body in cleartext (only the BEGIN fence
  matched). Merged the block + fence rules into one `private-key-block` whose
  bounded lazy body runs to the END fence *or* end-of-input, so terminated,
  unterminated, and oversized blocks are always fully redacted (regression
  tests cover >8192 and unterminated).
- **MEDIUM — memory session-summary now redacted.** `prompt` and `resultText`
  are redacted before the memory write (redact-then-truncate), closing the
  second retained-sink path (the model can echo a tool-read secret into its
  answer; the user can paste one into the prompt).
- **MEDIUM — raw hook `result`/`scan` documented** as a deliberate exception
  (above + type-level warning on `PostToolPayload`).
- **MEDIUM (differential review) — ReDoS/DoS on oversized input fixed.** The
  private-key rule's lazy body over many unterminated `-----BEGIN … -----`
  headers was O(len·cap) — multi-second on ~MB attacker input in the
  synchronous post-tool path. Two guards: `redact()` caps scanned input at
  128 KiB (`MAX_INPUT`), dropping the tail behind an `[REDACTED:oversized-input]`
  marker (never emitted raw), and the private-key body bound is 16 KiB (≫ any
  real PEM key). A >cap many-header ReDoS test now documents the real bound.
- **Code review — double-stringify fixed** (`runSecretRedaction` takes `unknown`
  and stringifies once internally, symmetry with `runInjectionScan`); rule
  ≤1-capture-group invariant now asserted by a test.

## Revisit if

- The model-facing enforcement capability lands (SDK result rewriting or
  tool-wrapping) → gate/redact what the model sees, closing both this §9 and
  ADR-0012 §9 in one change.
- A user-supplied custom-pattern config is wanted → `RedactorOptions.rules`
  already supports injection; add config-file parsing at the composition root.
- FP reports on the heuristic rules → tune entropy thresholds or add
  keyword anchors; the corpus test guards regressions.
