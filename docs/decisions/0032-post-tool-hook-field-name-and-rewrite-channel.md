# ADR-0032: the post-tool hook read the wrong field name; the SDK rewrite channel it said was absent was there all along

- **Status:** Accepted. The field-name repair ships in this PR (issue #83). Adopting the rewrite channel is deferred to its own decision (issue #84).
- **Date:** 2026-08-25
- **Requirements:** issue #83 (the broken seam), issue #84 (the rewrite channel); external review 2026-08-25
- **Relates to:** ADR-0010 (the structural-view decision this hardens), ADR-0012 §9 and ADR-0013 §9 (the observe-only rationale corrected here), ADR-0026 R4 (its revisit-if fires), security-model R-4

## Context

The security layer scans and redacts tool OUTPUT in a PostToolUse hook. The pinned SDK
(`@anthropic-ai/claude-agent-sdk` 0.3.201, pinned at 3dfd598 on 2026-07-06 and never bumped)
delivers the tool result to that hook as `tool_response`. The harness declared a structural view
`SdkHookInput` with an optional `tool_output` field and read `input.tool_output` at every post-tool
site. `tool_output` is a name no SDK version the harness has ever run has used, so on every live run
the field was `undefined`: the output injection scan was handed the empty string, the secret
redactor was skipped, `tool-trace.resultSummary` was stored null, and any custom post-tool hook
received `result: undefined`. The whole post-tool data plane was a no-op, and had been since the pin.

Two properties let it survive to here. First, optionality plus structural typing: the SDK's real
`PostToolUseHookInput` is assignable to the permissive view (an extra `tool_response` field on a
non-literal is not an excess-property error), so nothing failed to compile, while a test literal
using the correct `tool_response` name IS rejected by the view (TS2353). The type therefore steered
the test fake to the wrong field. Second, the fake fabricated `tool_output` and every post-tool test
asserted against that fabricated field, so 107 tests were green against a data plane that never ran.
The suite pinned the bug.

The evidence was not hypothetical. The harness's own `.harness/telemetry.db` held six post-tool
rows from real runs in July and August, `resultSummary` null on all six; the repo-qa dogfood WAL
showed the same on eight; a live smoke on 2026-08-25 reproduced it on the current build.

Separately, the security model stated (R-4, ADR-0012 §9, ADR-0013 §9, ADR-0026 R4's premise) that
model-facing enforcement of tool output was blocked because **no SDK result-rewrite channel exists**.
It does. The pinned SDK ships `updatedToolOutput` on the PostToolUse hook output ("Replaces the tool
output before it is sent to the model") and `updatedInput` on PreToolUse, both runtime-validated
against each tool's declared shape. `updatedInput` has shipped since 0.1.0 and `updatedToolOutput`
since 0.2.140 (2026-05-12), so both were present in the only SDK the harness has ever pinned. The
repo even said so to itself: ADR-0010's known-limitations section, written 2026-07-06 in the same
commit that pinned the SDK, reads "Week 2 must either use the SDK's `updatedToolOutput` hook output
or rework this seam". The "no channel exists" statement was written two days later and contradicted
that from the day it was written. This was an internal contradiction, not SDK drift.

## Decision

1. **Read the field the SDK sends.** `SdkHookInput` becomes a discriminated union of
   `SdkPreToolUseInput` and `SdkPostToolUseInput`, the latter carrying the required `tool_response`;
   `postToolCallback` reads `input.tool_response`. ADR-0010 decision 2 (structural views, no SDK
   import in `src/session`) is kept, not reversed: the fix is to make the view correct and to PIN it.

2. **A compile-time parity pin.** `src/session/sdk-types.test.ts` imports the SDK's own hook-input
   types (a type-only import, in a test) and asserts, at typecheck time, that each SDK event is
   assignable to its harness view and that the view declares no field the SDK does not (which is
   exactly what `tool_output` violated). A future rename fails typecheck here.

3. **A genuine-traffic replay gate, with its reach stated exactly.** `scripts/capture-sdk-hook-fixture.mjs`
   records real SDK hook inputs from one keyed run and freezes them (volatile fields placeholdered,
   the captured pair asserted to be the fixed benign marker before writing) as
   `src/session/fixtures/sdk-hook-events.json`; `src/session/sdk-fixture.test.ts` replays them
   through the session. This gate is a REGRESSION pin (harness code must keep feeding the recorded
   shape into the post-tool path) and a view-staleness detector (a view that requires a field the
   frozen JSON lacks reddens the fixture guard). It replays a snapshot through a fake `query`, so it
   does NOT observe the live SDK: an SDK-side rename is caught by decision 2's compile-time parity
   pin (which reads the installed SDK types), not here. The one thing that would let a stale fixture
   run against a newer SDK is a caret-range bump, so the replay test asserts the fixture's captured
   `sdkVersion` equals the installed one, forcing a re-capture on any bump. CI has no API key, so the
   capture is out-of-band and the replay runs per PR. A hand-written fake of a vendor contract can
   only confirm its author's beliefs; the three legs together (view, parity pin, genuine replay) are
   the structural answer to that, each with a different reach.

4. **Correct the "no channel exists" record, do not adopt the channel here.** R-4, ADR-0012 §9,
   ADR-0013 §9 and ADR-0026 R4 are corrected to say the channel exists and that model-facing
   enforcement is a deferred design decision (issue #84), not an upstream blocker. Adopting
   `updatedToolOutput` means deciding shape-preservation, a false-positive policy, and what "enforce"
   means for an `ask` verdict; that is issue #84's scope, deliberately not folded in here. The
   correction also reopens the INPUT side: ADR-0013 §9 rejected secret-in-input enforcement because
   the only option was deny (over-eager), but `updatedInput` is the redact-in-place middle option it
   lacked. That too is issue #84's scope, not a v1 change; it is named here so the next reader does
   not re-derive it.

## Alternatives considered

- **Import the SDK's `HookCallback` / `PostToolUseHookInput` into `src/session` and delete the
  structural view.** Rejected. It would prevent this exact bug, but it couples a core module's
  compile to a pre-1.0 package whose type surface the repo already treats as dated facts about a pin
  (ADR-0025), so an SDK bump would break the module rather than one test; it forces every session
  fake to construct the SDK's full required field set; and it does nothing about the leg that
  actually failed, since the SDK's declared type is a claim about the wire, not the wire itself
  (only the fixture speaks to that). ADR-0010's revisit-if for depending on the SDK's types has not
  fired: there is no separate versioned type package.
- **A derived view, `type SdkPostToolUseInput = Pick<PostToolUseHookInput, ...>`.** Rejected, but
  close. It makes parity structural by construction (no separate pin to go stale) and makes
  `tool_output` unspellable. But the hand-written views carry deliberate widenings a `Pick` cannot
  express (e.g. `SdkResultMessage.stop_reason?: string | null`, declared optional so drift yields
  null) plus load-bearing doc comments, and the explicit compile-time pin is greppable where a
  `Pick` is not. The pin plus the reverse-direction output checks (`sdk-types.test.ts`) buy the same
  guarantee without losing the widenings.

## Consequences

The observe-only data plane now actually observes: on a flagged tool result the scan warns and the
redactor fires before telemetry, as R-4's "harness data plane (persist/emit) is covered" always
claimed but did not deliver. Model-facing enforcement is unchanged (still deferred), but its stated
reason is now true. The lesson is the sharp one from the external review: the process verified
everything the harness owned and nothing it did not. The one seam a hand-written fake could never
test is the one boundary with a third party, and it is exactly where the bug lived for seven weeks
under a green suite. The parity pin and the replay fixture are the structural fix for the class, not
just the instance.

## Revisit if

- The SDK renames a hook field: the compile-time parity pin fails first; update the views and
  re-capture the fixture. ADDITIVE drift (a new field the harness ought to read) is caught by
  NEITHER gate, by design (`NoExtraKeys` checks view ⊆ SDK, never the reverse); the fixture
  re-capture forced by the version assertion on an SDK bump is the only place it surfaces, so read
  a bump's captured diff.
- Issue #84 adopts `updatedToolOutput`: R-4 moves from "observe-only, deferred" to "enforced", and
  this ADR's decision 4 is superseded on that point.
