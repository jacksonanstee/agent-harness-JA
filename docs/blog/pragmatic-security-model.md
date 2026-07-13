# A pragmatic security model for tool-using agents

> **Status: Draft — awaiting author voice pass.** 2026-07-14.

The [security model](../security-model.md) for
[agent-harness-JA](../../README.md) opens with a constraint most agent
security writing avoids stating: the harness is a policy layer, not an
execution environment. Every guarantee is a pre-execution gate (deny before
the SDK runs a tool) or a data-plane control (scan/redact what the harness
persists). There is no OS isolation underneath, and
[ADR-0015](../decisions/0015-sandbox-pre-tool-gate.md) carries an explicit
"what this cannot stop" section — because a sandbox that overclaims is worse
than no sandbox: it converts your users' caution into misplaced trust.

This post is about the three ideas that shaped the layer — honest gaps,
tighten-only composition, and reviews as architecture — with live output
where a claim can be demonstrated instead of asserted.

## Name the gap or it will name you

The security model's §6 calls R-4 "the single most important honest
statement in this document": in v1, a tool result the scanner flags **still
reaches the model**, and a secret the redactor catches **is still visible to
the model**. The scanner and redactor protect the *record* (telemetry,
memory, logs) and gate the *next action*; they do not yet rewrite the
model's context, because the SDK exposes no channel for it. Most agent
frameworks have this exact gap. Few write it down in bold.

Why does writing it down matter beyond ethics? Because named gaps compose.
The model's §6 chains R-4 with R-3 (ungated network egress) into the
"critical-shaped scenario" — flagged-but-not-blocked injection steers the
model, the model has seen an unredacted secret, `WebFetch` exfiltrates it.
That composed analysis is only possible because each half was stated
plainly, and it is what promotes two follow-ups above everything else on the
roadmap. Unstated gaps don't get roadmap slots.

This week the R-4 surface *widened*, deliberately: skill bodies now enter
the system prompt whole (PR #28 — the fix that made
[ADR-0006](../decisions/0006-skill-schema-markdown-frontmatter.md)'s
contract true). A hostile skill body is direct system-prompt input,
unconditional, at session start. The same honesty rules applied: the
widening is risk-accepted *in the threat model document*, bounded (raw-body
scanning, charset stripping, an aggregate size budget with whole-skill
drop), and the follow-up is filed — with the observation that unlike tool
output, the harness *owns* prompt assembly, so blocking a flagged skill is
implementable today. Observe-only is a posture, not a fate.

## Tighten-only, demonstrated

The trust model is user > project: your machine's settings are trusted; the
settings of a repo you just cloned are attacker-influenced input. Two merge
rules encode it — permission rules combine with sticky deny (a user deny
survives any project allow,
[ADR-0014](../decisions/0014-declarative-permission-model.md)), sandbox
allowlists combine by intersection
([ADR-0015](../decisions/0015-sandbox-pre-tool-gate.md)). A cloned repo can
make the agent *more* constrained, never less. The one scalar that violates
this (`defaultDecision` is project-overrides-user) is tracked as residual
risk R-8 rather than smoothed over — and it is why the
[repo-qa example](../../examples/repo-qa/README.md)'s committed policy sets
deny *rules* and deliberately omits `defaultDecision`.

That example is the demonstration. Its committed `.harness/settings.json`
denies the mutation tools, and asking the agent to write a file produces
(costs dated/illustrative):

```
DENIED

[harness] model=claude-sonnet-4-6 (rule=shape-build-small) turns=2 cost=$0.0501 denied=1 memory=session-…
```

The telemetry row underneath reads
`denied-by-hook | Write | permission: deny Write [rule 0, project]` — the
audit trail names the rule and the layer that fired.

And building the demo taught the lesson a second time. My first policy
denied `Write` but not `Bash` — and the agent, denied the file tool, went
straight for `echo hello > demo.txt` through the shell. **A deny-list is not
a boundary until the alternate routes are closed.** The repo had already
learned this once at the infrastructure level: the "dual-table gap," where
permissions and sandbox each kept a private tool table and four
exfiltration-shaped tools bypassed both, fixed by a single shared table both
gates consume. Watching the same failure shape reappear at the *policy*
level, live, is exactly why the example ships with `Bash` denied and the
incident written into its README.

## Reviews are load-bearing, including on the fixes

The most instructive defects in this codebase were found by adversarial
review — and a disproportionate number were found *in the fixes*:

- The skills loader's differential review caught a **critical RCE**: the
  frontmatter library selects its parse engine from the fence tag, so
  `---js` frontmatter `eval()`s on load — after an earlier review pass had
  concluded the default safe-loader closed that door. The wrong conclusion
  was already written down; only a second, hostile pass re-derived it.
- The permission model's review caught a project match-rule out-specificing
  a user's blanket deny (a cloned repo defeating global policy) — and the
  *verify pass on that fix* caught the fix's own regression: relative match
  patterns silently failing open (a relative `secrets/*` deny that never
  fired). The same hardening round pinned the boundary case in the other
  direction too, so `/etc/*` cannot false-match `/etcetera`.
- A case-folding hardening was caught folding in the **widening**
  direction — case-insensitive matching applied to allow rules loosens
  policy; the shipped fix folds argv0 only.
- A symlink containment fix was caught normalizing `link/../real` textually
  while the syscall followed the link — lexical path logic and the
  filesystem disagree, so the walk now uses raw components.

One more incident deserves its own paragraph because every security tool
author eventually meets it: **a secret scanner's own test fixtures are
secrets, as far as every *other* scanner is concerned.** The redaction
module's corpus of fake AWS keys and tokens tripped this repo's own
pre-commit secret gate *and* GitHub's push protection. The fix is a small
discipline stack: fixture tokens are assembled from split fragments at
runtime (`'AKIA' + 'IOSF…'`) so no detectable literal exists in any file or
git history, and the feature branch was squashed so no intermediate commit
carries an assembled literal. None of
this is in the threat model — the attacker here is your own tooling — but
it is the kind of friction that separates a security layer someone has
actually operated from one that has only been designed.

The pattern across the four review catches: **the dangerous bug is the one
introduced by the remedy**, because remedies get less scrutiny than
features. The process
here treats review as part of the security architecture — three independent
lanes per change, an adversarial verify pass on the fix round, and the
catches recorded in the ADRs (the [week-2 devlog](../../process/devlog/week-2.md)
narrates the S-1→S-4 sequence). If your security layer's history contains
no sentence of the form "the review caught the fix breaking X," that is
rarely because it didn't happen.

## The stance, compressed

State what you don't enforce, in the same document as what you do. Make
attacker-influenced config only able to tighten. Assume your remedy is wrong
until a hostile pass fails to break it. And keep one runnable example whose
denials you can actually watch fire — a security model you can demo in two
commands is harder to fool yourself about than one that lives entirely in
prose.
