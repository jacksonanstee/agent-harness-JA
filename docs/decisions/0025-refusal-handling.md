# ADR-0025: A model refusal is a distinguishable outcome, not an empty success

- **Status:** Accepted
- **Date:** 2026-07-28
- **Requirements:** [Issue #38](https://github.com/jacksonanstee/agent-harness-JA/issues/38), raised by the security and architecture reviewers independently during the ADR-0024 review; residual risk R-14 in [docs/security-model.md](../security-model.md) §6
- **Relates to:** [ADR-0010](./0010-sdk-session-adapter.md) (owns the structural SDK view this widens), [ADR-0024](./0024-router-model-tiers.md) (its first "Revisit if" is this work; amended by this ADR), [ADR-0011](./0011-telemetry-store-and-migrations.md) (the turn-cost payload gains three fields), [ADR-0013](./0013-secret-redaction.md) (why no model-authored prose is captured)

## Context

`stop_reason` appeared nowhere in `src/`. A refusal therefore resolved as an ordinary `SessionResult` with empty or partial `resultText`, indistinguishable from an empty success. Every security gate in this harness is pre-tool and none reads result text, so this was never an enforcement bypass. It was an integrity-of-signal defect, and it contradicted the posture the rest of the repo is built on: failure modes are loud.

ADR-0024 made `claude-fable-5` nameable from a custom table, and the sharpener the security reviewer raised is that the only reason to opt into Fable is hard or adversarial work, which is exactly the content most likely to trip a refusal classifier. The gap concentrated on the consumer's most sensitive path.

Reading the pinned SDK (`@anthropic-ai/claude-agent-sdk` 0.3.201) established three facts that changed the shape of the problem. They are dated facts about a pinned version, not standing ones.

1. **`stop_reason` is on both result variants**, `SDKResultSuccess` (`sdk.d.ts:4039`) and `SDKResultError` (`:4009`), as an open `string | null`. It can be read straight off the result message the harness already consumes.
2. **Two refusal banners exist**: `model_refusal_no_fallback` (`:3856`), where the turn ends as an error, and `model_refusal_fallback` (`:3824`), where the turn is retried on a fallback model and the swap is made persistent for the session. Both carry `api_refusal_category` and `api_refusal_explanation`. Both are documented as **"Absent from older CLIs"**.
3. **The fallback case is the one that silently exits 0.** Issue #38 speculated that `run` might exit 0 on a refusal. For the no-fallback case that is wrong: it lands an error subtype, and `src/cli.ts` already maps any non-`success` subtype to 1. The case that genuinely exits 0 is the fallback swap, which the issue does not mention, and it is the worse of the two: the run succeeds with a real answer from a *different model*, while `SessionResult.modelChoice` and the telemetry `model` field both still report the model the router chose, and the `[harness]` line prints that routed model as fact.

The harness never sets `fallbackModel` itself, but it is not the only party who can, and **the reachability of this is the one claim in this ADR that took three attempts to get right.** The history is recorded because the error is instructive:

- The first version said the swap was reachable "only through the ambient-configuration surface of R-11", meaning the operator's own `~/.claude`.
- A security review said a vendor server-side path also exists. I rejected that on the grounds quoted below, and widened the claim to name enterprise-managed settings instead.
- An adversarial verify pass then **refuted my rejection**, from the SDK typings, and it was right.

The reasoning I used to reject it was a converse error. From "no local fallback configured implies the no-fallback banner", it does not follow that "the fallback banner implies a local fallback was configured". The SDK explicitly says the two banners do not partition the space: the no-fallback banner is "Not emitted when a fallback existed but was declined or **gate-failed**".

And the channel is positively documented, not merely unexcluded. `PolicySettingsOrigin` includes `'remote'`; `serverManagedSettings` is "the result of fetching `/api/claude_code/settings`", feeds that `'remote'` sub-source, and is documented as "same trust level as the on-disk cache it replaces, so **non-restrictive keys flow through unfiltered**". `fallbackModel` is a member of `Settings` and is not a restrictive key (the restrictive allowlist is locks, `permissions.deny`/`ask`, and sandbox restrictions; the docs name `model` and `env` as examples of non-restrictive keys that get dropped from the *restrictive* channel). So a server-supplied settings payload can carry `fallbackModel`, cached locally as a cache rather than authored by any human on the machine.

The corrected channel list, with the correction to my second attempt as well:

1. The operator's own ambient `~/.claude` configuration (R-11, observed live twice).
2. A server-supplied settings payload via the `'remote'` policy origin, authored by neither the operator nor an on-machine administrator.
3. An on-disk enterprise managed-settings tier or MDM. Note that the SDK's *`Options.managedSettings`* channel is filtered restrictive-only and would silently drop `fallbackModel`, so it is specifically the on-disk policy tier that applies, not that option.

A `--fallback-model` CLI flag also exists and the SDK documents it as taking precedence over the settings value, but it is **not** reachable through this harness: `createSession` passes only `{model, systemPrompt, maxTurns, hooks}` to `query`, with no `extraArgs`. It is named here only so the list is not mistaken for exhaustive.

R-15 therefore does not claim to bound reachability at all. That is the honest position, and it is stronger than either of my first two attempts.

## Decisions

**1. Three channels are read, and the richer one wins.**

A banner sets the refusal record. `stop_reason === 'refusal'` on the result sets it only if no banner did. Neither channel is sufficient alone: the banners are absent from older CLIs, and `stop_reason` carries neither the category nor the fallback model. Reading both is not redundancy, it is coverage of two different deployment states.

Precedence is pinned by tests, not just described here:

- **Later banner wins.** A turn that falls back and then refuses again reports the terminal truth rather than the intermediate swap.
- **The result-derived record never downgrades a banner record.** A banner carries strictly more information, so a subsequent `stop_reason` must not overwrite it with nulls. This is the same tighten-only direction ADR-0016 §4 requires of the judge: a later stage may sharpen a verdict, never launder it into something weaker.

**2. The surfaced shape is a raw passthrough plus a derived record.**

```ts
stopReason: string | null;          // raw, open string
refusal: {
  source: 'result-stop-reason' | 'system-event';
  category: string | null;          // sanitized at capture
  fallbackModel: string | null;     // non-null means a different model answered
} | null;
```

`stopReason` is a passthrough because the SDK declares it open and new values ship on the wire ahead of schema updates; the harness branches on one known value and records the rest verbatim rather than pretending to an enum it does not control. `refusal` is derived so that "did the model refuse" is answered once, in the layer that read the stream, instead of by every consumer re-deriving it.

**Neither prose field is captured.** Two fields on the banners carry model-authored prose, and both are deliberately unmodelled:

- `api_refusal_explanation`, which the SDK documents as unstable human prose, display only, never parse.
- `content`, which is **required** on both banners, so it is present on every refusal event, unlike the optional explanation. The security review flagged that naming only the explanation made this decision's rationale narrower than what the SDK actually exposes.

Capturing either would open a new untrusted-prose channel into two retained sinks (telemetry and the memory session summary) for diagnostic value the category and the fallback model already largely provide. ADR-0013's whole reason for redacting before persistence is that retained sinks are the expensive place to be wrong. The trade is real: an operator debugging a refusal gets a category, not a sentence.

**3. All three SDK tokens are cleaned and bounded at capture.**

`api_refusal_category`, `fallback_model` and `stop_reason`, not at each sink. All three are vendor-supplied strings that reach the result, the memory summary, the telemetry payload, and the terminal, so cleaning once at the point of capture means no sink can be added later that forgets. The telemetry store sanitizes again on write, because it is a public factory and a direct writer need not have come through the session layer.

`stop_reason` was left raw in the first two cuts of this change, including the cut that fixed the other two after review. It is equally an open string by the SDK's own declaration and reaches exactly the same sinks, so treating it differently was an inconsistency rather than a considered exception. Recorded because the near-miss is the useful part: a fix applied to the two fields a review named, while the third field with identical properties sat untouched two lines away.

The charset contract is the same one `cleanSkillText` applies to skill text: control chars, bidi overrides, and invisible smuggling chars, plus a whitespace collapse and a trim that skill text does not need. The first cut stripped control chars only, and the security review demonstrated empirically that a U+202E override survived capture *and* `sanitizeForTerminal` all the way to the stderr line, which is the one line whose job is to tell an operator that a different model answered.

**This narrows the spoofing channel; it does not close it.** An adversarial verify pass demonstrated four survivors, and they are named rather than implied:

- **Homoglyphs.** `clаude-sonnet-5` with a Cyrillic `а` renders as a legitimate model name. No NFKC or confusable fold is applied anywhere in the harness; ADR-0012 §5 already defers exactly this class, and doing it here alone would be a partial answer in one field while the injection scanner still has the same gap.
- **Invisible characters outside the stripped set**, for example U+2061-2064 and Arabic format marks U+0600-0605, which `stripInvisibles` does not cover.
- **Combining marks**, excluded on purpose (they are legitimate in NFD-form accented text), so a model name can be visually smeared.
- **Truncation semantics.** The 100-char cut is well-formed but is still a cut; a very long token is reported as a prefix.

Two things *are* closed, both demonstrated: control chars and bidi no longer reach the line, and a space-bearing token can no longer forge a sibling field in the space-delimited `key=value` output (whitespace collapses at capture, and the sink quotes the value as well). The residual is a display-fidelity risk on a diagnostic line, not an enforcement gap, and it is the same normalisation debt the scanner carries.

All three are also **bounded** (100 chars). The SDK calls these open strings whose values "ship on the wire ahead of schema updates", so nothing in the contract bounds them, and every other persisted string in the session module is capped.

One deliberate consequence of cleaning `stop_reason` **before** the `=== 'refusal'` comparison: a zero-width-smuggled `refu<ZWSP>sal` collapses to exactly `refusal` and is therefore *detected*. That direction is chosen on purpose. Detecting a refusal that a smuggled character would otherwise have hidden is the fail-loud direction, and the value is vendor-supplied rather than attacker-supplied in the ordinary case. A test pins it so the ordering cannot be flipped by accident.

**4. The exit code stays 1, and a successful fallback still exits 0.**

A refusal with no fallback already exits 1 by virtue of its error subtype, so nothing needed to change to satisfy "it should not be 0". No new exit code was added: 0/1/2 is pinned by ADR-0018 and ADR-0019 and shared with `eval` and `redteam`, and a fourth code would widen a contract three ADRs describe in order to express something the typed surface already expresses better.

A successful fallback exits **0**, deliberately, because there genuinely is an answer and a non-zero exit would be a lie about the run's outcome. What makes it not-silent is `formatRefusalLine` on stderr, which names the model that actually answered.

**The claim and its correction go to the same stream.** The architecture review pointed out that putting the correction only on stderr left `run > out.txt` capturing a file whose single model claim was false, with no trace of the swap. So the stdout summary line now annotates itself: `model=<routed> (answered by <fallback>)`. The stderr line stays, because a refusal is a diagnostic and every other diagnostic in this CLI goes to stderr; what changed is that the stdout claim no longer stands alone as a falsehood.

**5. The telemetry fields are flat, and optional for a read-path reason.**

`stopReason`, `refusalSource`, `refusalCategory` and `refusalFallbackModel` are optional on `TurnCostPayload` even though the session layer always supplies all four. `isTurnCostPayload` validates on the **read** path and throws on mismatch, so required fields would make every turn-cost row written before this change unreadable, including `telemetry export` over an operator's existing database. A present-but-wrong-typed field is still a hard failure. Both directions are pinned by tests.

**Why flat rather than a nested `refusal` object**, which is how the memory summary and `SessionResult` both carry it: this payload is validated by hand-rolled predicates rather than a schema, and it is already flat in six other fields. A nested object would need a composite predicate whose optionality states multiply (absent object, present object with absent fields, present object with null fields), for no gain in what the row can express.

**`refusalSource` exists because of that flatness.** The architecture review caught that the first cut carried the category and the fallback model but not the source, and a nested object would have carried it for free. It matters because `source` is the only field that is non-null whenever a refusal was detected: the SDK documents the category as null "when neither source carried a category (**normal, not an error**)", and a no-fallback banner can arrive on a result whose `stop_reason` is not `'refusal'`. Such a row would have been indistinguishable from a clean success, which is precisely the defect this ADR exists to remove, reintroduced at the sink meant to be the durable honest record. Detecting a refusal in the session layer and then losing it in telemetry would have been the worst of both.

## Consequences

- A consumer can distinguish a refusal from an empty success, and can tell whether the answer came from the routed model. That closes R-14 as a code gap and discharges ADR-0024's first "Revisit if", which removes one of the three grounds for not defaulting high-sensitivity work to Fable. The cost and retention grounds stand untouched.
- `SessionResult` gained two required fields. Additive for consumers who read it; the `SessionResult`-typed fixtures in `src/cli/init-templates.test.ts` and `src/eval/golden/runner.test.ts` failed compilation until updated, which is the ADR-0021 blast-radius guard working as designed. Landing this before the v0.1.0 tag is what makes it cheap.
- An operator whose ambient configuration enables a fallback model now gets a warning and a typed field instead of a quiet substitution. The harness still does not set `fallbackModel` itself.
- **The golden eval scorecard now carries the refusal channel**, reversing an earlier decision in this ADR. The original reasoning was that "a refusal already fails a golden oracle through its non-`success` subtype", and that reasoning is simply false for the fallback case: a swap reports `success` with a real answer, so the oracle passes, the row records `pass`, and `meta.models` names the routed model rather than the one that answered. That is the same defect this ADR exists to remove, at a third durable sink, found by the verify pass. `RowVolatile` gains `refusalSource` and `refusalFallbackModel`; the volatile partition is informational and never baseline-diffed, so no committed artefact shape changes and the red-team baseline is untouched.

## Verification, and its named limit

Split the claim in two, because the two halves have different evidence.

**The `stop_reason` channel is verified live.** A real `cli.js run` against the API on 2026-07-28 captured `stopReason: "end_turn"` from an actual SDK result message, through to both retained sinks (`refusalCategory: null`, `refusalFallbackModel: null`). So the field is really on the wire at this SDK version, the harness really reads it, and it really reaches telemetry and the memory summary. That is the part a scripted fake cannot prove.

**The `'refusal'` value on that channel is not verified live, and neither banner has been observed.** Provoking a real refusal means crafting a prompt designed to trip a bio or cyber safety classifier, which is not something this repo will do to produce a test fixture. Those paths are verified against the SDK's declared contract at a pinned version, plus scripted-stream tests that replay each banner and result shape through the real session code path.

So the honest summary is: the plumbing is observed, the trigger is not. That is a real gap between "tested" and "observed in production", of the same kind ADR-0012 §5 names for Unicode normalisation, and narrower than it would have been without the live run. It is stated here rather than left for a reader to discover, because the alternative to naming it is implying an observation that never happened.

The normal path is also verified unregressed: `examples/repo-qa` eval stayed 2/2 at one turn each and $0.0481 against a $0.0479 baseline, and `telemetry export` over a database containing three turn-cost rows written on 2026-07-06 (none carrying the new keys) exited 0, which is decision 5 demonstrated rather than asserted.

## Revisit if

- **The SDK adds a typed refusal result subtype.** Today the harness reads an open `stop_reason` string plus two system banners. A dedicated subtype would let the CLI exit-code mapping express refusal directly, and would make decision 1's two-channel read redundant.
- **An operator actually needs the explanation string.** The channel exists and is deliberately unread. Reversing decision 2 means routing that prose through redaction and truncation before either retained sink, the way `resultText` already is, and saying so in the security model.
- **A refusal is observed live.** That converts the limitation above into evidence, and should be recorded here with the category the classifier returned, because the category vocabulary is an open set the harness does not control.
- **Normalisation lands anywhere in the harness.** The homoglyph and combining-mark survivors above are the same debt ADR-0012 §5 defers for the injection scanner. Whoever closes it there should close it for these tokens in the same change, rather than this field growing a private confusable fold.
- **Fallback swaps stop being a configuration accident.** If the harness ever sets `fallbackModel` itself, the swap becomes an intended feature and needs a routing-level decision about whether `ModelChoice` should record the model that answered rather than the model chosen.
- **Persistence is gated on the answering model.** Raised by the security review and deliberately not built here: when `refusal.fallbackModel !== null`, the model that answered may have a different data-retention posture from the one ADR-0024 decision 1 vetted for the routed model, so that turn's retained `resultText` arguably deserves stronger redaction or a shorter TTL than the standard 30 days. It is a real lever, and it is the only one in this area the harness actually controls. It is out of scope for issue #38 because it changes retention behaviour for a whole class of turn, which is its own decision with its own blast radius, not a rider on a detection fix.
