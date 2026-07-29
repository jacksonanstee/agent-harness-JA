# Week 6: tiers, refusals, and gates that gate themselves (2026-07-27 → 2026-07-29)

Still unpublished, still deliberately so. With the release held pending
reader feedback, this week ran the backlog: the router's model tiers, a
refusal outcome the harness could not distinguish from success, one shared
CI gate definition, enforcement for the skill channel, and a durable record
for the one enforcement action that had never left one.

Five of the six items below were found by review rather than by a failing
test, and three of them were defects in a previous round's fix. That is
the week's actual subject.

## 2026-07-27: a union that was an API argument

The plan was a documentation ADR about when model IDs get refreshed. Reading
the code changed what it was.

`src/session/session.ts` passes the router's chosen `model` straight to the
SDK as `options.model`. The members of that union are not tier labels that
happen to look like model names. They are API arguments. And ADR-0023 had
just locked the `Model` type into the published surface, so the window to
change them without a semver cost was closing.

ADR-0024 settled two things. The union gains the current generation, but the
*default* table keeps the previous ceiling: the most capable tier is
nameable, not defaulted. The reasons are concrete rather than aesthetic,
including a cost multiple on most routing rules and a retention property
that would return an error on every request for organisations with
zero-retention agreements. The union also stays closed, with no escape
hatch for arbitrary strings, so a future refresh remains compiler-enforced
rather than optional.

The model IDs themselves were read from an authoritative source and each
verified live against the models endpoint, not recalled. That is now the
standing rule for this file.

ADR-0007 was amended rather than rewritten. Its original names stay in place
as the record of what was true in May, with markers at each stale point. The
architecture review called that the exemplar for the repo, which is a
useful thing to have had confirmed by something other than the author.

**The review's convergent finding became an issue rather than a fix.** Two
reviewers independently noticed that `stop_reason: "refusal"` is handled
nowhere: a refusal resolves as an ordinary result with empty text,
indistinguishable from an empty success. The sharpener is that the only
reason to name the top tier is hard or sensitive work, which is exactly what
trips a refusal classifier. It was filed as issue #38 and deliberately left
out of the diff, because the guard belongs in the session layer for every
model and this PR was about the router.

**A coverage gap in the live smoke, caught and closed.** The evaluation path
routes lookup-shaped tasks to the cheapest tier and the `run` command has no
descriptor flag, so neither smoke touched the high-sensitivity ceiling. Two
green smokes had proven less than they appeared to. Closed by direct
inference against each remaining union member, so all four are proven to be
accepted by the API rather than merely to typecheck.

## 2026-07-28: a refusal is not an empty success

Issue #38, and the pinned SDK's type definitions reshaped it before any code
was written.

The issue guessed that a refusal might exit 0. That guess is wrong for the
case it describes, which already exits 1 through an error subtype. **The case
that genuinely exits 0 was not in the issue at all, and is worse:** a
fallback swap, where a different model answers, the answer is real, the exit
code is success, and the routing decision, the telemetry and the operator
facing line all still name the model the router chose. A quiet substitution
inside a system whose entire premise is that routing decisions are recorded.

Two of my own claims were refuted during the verify pass. Both are recorded
in ADR-0025 rather than quietly patched.

The first was a converse error. From "no local fallback implies the
no-fallback banner", I had inferred "the fallback banner implies a locally
configured fallback", and used that to reject a reviewer's server-side
channel. The SDK documents that the two banners do not partition the space.
The channel is positively documented, and the rejection was wrong.

The second was a comment claiming a particular widening would fail to
compile. Method parameter bivariance means a narrower `Set` is assignable to
a wider `ReadonlySet`, so the widening compiled cleanly, in the silent
direction the comment promised to catch. Fixed with an exhaustive record
type whose keys derive the runtime set, verified failing in both directions.

**Telemetry gotcha, load-bearing and worth carrying forward:** payload
validation runs on the *read* path and throws. New payload fields must be
optional, or every pre-existing row becomes unreadable, including on an
operator's existing database. Proven against a real one before shipping.

**A named verification limit, in the ADR and the PR rather than buried:** the
plumbing is observed, the trigger is not. A real result message was captured
through to both durable sinks, so the channel is live-proven, but the refusal
value itself is verified only against the pinned SDK contract and scripted
streams. Provoking a genuine refusal means crafting a prompt designed to trip
a safety classifier, which is not a thing to do for a test fixture. Saying so
is more useful than a green tick that means less than it looks like.

**Merge-order gotcha:** two open PRs each appended a row to the same index
table. The merge base had neither row, so git saw a replacement rather than
two additions, and the second PR flipped from clean to conflicting the moment
the first landed. Expect this whenever two branches append to a shared table,
regardless of what the mergeable flag said beforehand.

## 2026-07-28: one gate definition, and a branch-protection migration

The deploy path was running strictly fewer checks than pull-request CI. The
link checker had been added to CI during the week-4 docs pass as its own
*job*, and never to the publish path's gate. The publish ADR had predicted
exactly this and stated the rule that would prevent it. The rule was held in
a comment and lost anyway, **because the gate arrived as a job rather than a
step**, and no amount of script-level unification could have caught a
job-shaped gate. The fix had to be at the workflow level: one callable
workflow, called by both.

**The design review caught the deploy-day landmine before any code existed.**
Branch protection required two named contexts. Jobs in a called workflow
report under a different name, so those contexts would never report again and
every pull request, including the one making the change, would become
unmergeable. It sat blocked exactly as predicted. **Renaming a CI job is a
branch-protection migration, and the cheapest time to do one is when there
are no open PRs.**

Then round 2 on the fix commit found that the new security pins were partly
theatre.

Live bypasses that were green: a permission grant written with two spaces,
and the same grant quoted, both parse identically and both slipped past an
exact-literal match. A quoted cache directive evaded its pattern. A
workflow-level grant was invisible because the check only read job bodies. A
newly added fourth workflow file escaped everything, because the file list
was hardcoded to three names.

**Lesson banked: a security pin matched against one exact spelling
manufactures confidence rather than providing it, which makes it worse than
no pin at all.** Rewritten to be quote and whitespace tolerant, counting
grants across every workflow file enumerated from disk.

Two smaller items from the same round, both in tests I had written to prevent
exactly the thing they failed to prevent. A job-boundary pattern matched
comment lines, silently under-reading the file. And `indexOf` returning `-1`
is less than any real index, so *deleting* the gate being ordered still
passed the ordering assertion. Writing the pins even reproduced the trap they
guard against: the first cut matched the invariant *comments* describing the
rules rather than the configuration implementing them, and went red against a
clean tree.

Thirteen mutations were verified red and then restored. A guard never seen
failing is not a guard.

## 2026-07-28: block-on-flag, and why enumerating a class does not converge

ADR-0026. A high-confidence injection verdict on a skill's description or
body now drops that skill from the system prompt entirely. This is a
deliberate carve-out from the standing observe-only posture, and it is
legitimate because that posture's rationale is the absence of a rewrite
channel, which never applied to a prompt the harness assembles itself.

Three review rounds, each finding a real defect. **The first was a CRITICAL,
and it is the most instructive thing in this repo's history so far: I had
shipped a security control that did not work, with documentation saying it
did.**

The scanner read the skill text raw. The prompt builder injected a cleaned
version. Cleaning maps control and bidi characters to *spaces*. So stripping
did not merely fail to hide a payload from the scanner, **it created one**:
a single control character inside a phrase made the raw text score as clean,
while the cleaned text that actually reached the model read as a fluent
instruction. One byte defeated the entire control, with no warning anywhere.
Two code comments asserted that stripping could not hide anything from the
scanner. True in the hiding direction, which is precisely why nobody checked
the other one. Fixed by making the gate and the builder consume one function
that produces the exact injected string.

Round two found five ranges of invisible characters present in neither the
cleaner's set nor the scanner's. Round three found the best defect of the
three: **I had fixed the proof-of-concept's code points, not the class.** One
more code point sat in the single gap between a range I had just added and
the next one, and the same held around three other additions. Enumerating a
character class one exploit at a time does not converge.

The repair was qualitative rather than another patch: Unicode properties
instead of hand-picked lists. The split between the two sets is the point.
The scanner's set strips transiently, for rescanning only, so it can afford
to be broad. The cleaner's set deletes from content that reaches the model,
so it stays conservative and deliberately excludes combining marks, which are
legitimate in decomposed text. Verified by an exhaustive sweep across the
affected planes rather than by another example.

**The ADR refuses the issue's premise.** "A legitimate skill has no reason to
contain flagged phrasing" is false. A status badge trips an exfiltration
rule, a skill quoting a chat template trips another, and most sharply, **a
skill that documents prompt injection gets dropped for describing the
attack.** Two tests exist purely to hold those false positives visible.

Separately, Dependabot validated itself within an hour of being enabled by
bumping two actions across major versions on the publish critical path. Both
SHAs were verified against the real upstream tags before merging. That
verification is the entire point of pinning to a SHA; skipping it converts
the pin into decoration.

## 2026-07-29: a drop with no record, and a digest that had to be optional

Issue #46 closed the gap the previous item created: dropping a skill was the
only model-facing enforcement action that left no durable trace. It shipped
with a schema migration, and the live smoke ran against a real database with
two dozen rows from genuine runs rather than fixtures, on a copy, with the
original verified byte-identical afterwards.

Issue #50 followed from it. Truncated skill paths keep the tail, so two
skills differing only in an early directory store identically, and the audit
rows cannot be told apart. The fix adds an optional digest of the full path.

**The load-bearing decision was measured, not argued.** The field had to be
optional, because row validation runs on read and throws, so a required new
field makes every pre-existing row unreadable. Removing one required field
from one stored row was tried first: the export exited 1 with zero rows out
of twenty-five. The entire trail, denied by one row.

Three things went wrong in this fix, in sequence, and the sequence is the
lesson.

**First, I gave a false premise inside a question.** Offering the digest width
as a choice, the option text claimed that sixteen hex characters meant an
attacker could not engineer a collision without breaking SHA-256. That is
false. Sixty-four bits has a birthday bound around 2^32, which is minutes of
commodity GPU time, and the attacker authors both paths by construction, so
the very argument used to reject a weak hash also defeated the chosen width.
Review caught it. **When a security parameter is offered as a choice, the
option text is a claim and needs verifying like any other.**

**Second, the fix for that introduced the next defect.** Widening the constant
updated every assertion that derived its length from it, and left two that had
the old width baked in as literals. Against the wider pattern those two began
failing on *length*, so the case and character-set guards they were named for
stopped being exercised entirely. Proven rather than asserted: relaxing the
validator to accept upper case, and then to accept any character at the right
length, left every test in the file green.

**Third, the fix for *that* did it again in miniature.** The commit whose
purpose was removing a hand-copied number from prose added a different
hand-copied number to a test comment.

A constant and the tests written against its old value are one change, not
two. That is now written down.

## Week 6 in one line

Model IDs recognised as API arguments before publishing froze them, a silent
model substitution given a name, one gate definition shared by both paths,
enforcement for the skill channel that took three rounds to actually work,
and a durable record for the drop it performs. The recurring shape, stated
plainly because it has now happened often enough to be the finding: **the
defect is usually in the previous round's fix, and the comment claiming a
gap is closed is the best place to look for it.**

Still unpublished, by choice.
