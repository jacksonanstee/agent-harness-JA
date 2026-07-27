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

The harness never sets `fallbackModel` itself, but it is not the only party who can. Three channels outside the harness's control set it, and the security review of this change corrected an earlier, narrower claim here that named only the first:

1. The operator's own ambient `~/.claude` configuration, which the SDK's bundled CLI reads (residual risk R-11, observed live twice).
2. A `fallbackModel` in **managed settings**. The SDK's settings schema carries the field, and describes that schema as typically administered by enterprise administrators, so the party who enables a swap need not be the party running the harness.
3. A `--fallback-model` CLI flag, which the SDK documents as taking precedence over both.

The SDK additionally refers to server-side gating of the fallback path (a banner is "Not emitted when a fallback existed but was declined or gate-failed", and the category may come from a "server-gated trigger"), and does not document what that gating depends on. So this list is not claimed to be exhaustive, and R-15 says so rather than asserting a mechanism the evidence does not establish.

What the SDK's own docs *do* pin is that a swap requires a fallback to have been configured somewhere: the no-fallback banner is emitted precisely "when the model ends the stream with `stop_reason` 'refusal' and **no fallback model is configured**". A refusal with nothing configured ends the turn as an error rather than silently substituting a model.

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

**3. The category and the fallback model are cleaned and bounded at capture.**

Not at each sink. Both are vendor-supplied strings that reach the result, the memory summary, the telemetry payload, and the terminal, so cleaning once at the point of capture means no sink can be added later that forgets. The telemetry store sanitizes again on write, because it is a public factory and a direct writer need not have come through the session layer.

The charset contract is the same one `cleanSkillText` applies to skill text: control chars, bidi overrides, and invisible smuggling chars. The first cut of this change stripped control chars only, and the security review demonstrated empirically that a U+202E override survived capture *and* `sanitizeForTerminal` all the way to the stderr line, which is the one line whose job is to tell an operator that a different model answered. A bidi override that visually reorders a model name defeats exactly that guarantee, so the narrower charset was the wrong contract for this sink.

Both values are also **bounded** (100 chars). The SDK calls the category an open string whose values "ship on the wire ahead of schema updates", so nothing in the contract bounds it, and every other persisted string in the session module is capped. An unbounded open string reaching two retained sinks was an inconsistency, not a considered exception.

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
- The golden eval scorecard does not carry refusal information. A refusal already fails a golden oracle through its non-`success` subtype, and widening a committed artefact shape is a separate decision.

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
- **The eval layer needs refusal in the scorecard.** It would widen a committed artefact shape and change baseline bytes, so it belongs with a scorecard-shape decision rather than being bolted on.
- **Fallback swaps stop being a configuration accident.** If the harness ever sets `fallbackModel` itself, the swap becomes an intended feature and needs a routing-level decision about whether `ModelChoice` should record the model that answered rather than the model chosen.
- **Persistence is gated on the answering model.** Raised by the security review and deliberately not built here: when `refusal.fallbackModel !== null`, the model that answered may have a different data-retention posture from the one ADR-0024 decision 1 vetted for the routed model, so that turn's retained `resultText` arguably deserves stronger redaction or a shorter TTL than the standard 30 days. It is a real lever, and it is the only one in this area the harness actually controls. It is out of scope for issue #38 because it changes retention behaviour for a whole class of turn, which is its own decision with its own blast radius, not a rider on a detection fix.
