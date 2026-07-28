# ADR-0026: block-on-flag for the skill channel (a scoped exception to R-4)

- **Status:** Accepted
- **Date:** 2026-07-28
- **Requirements:** issue #29 (follow-up named in security-model.md §5, 2026-07-14 risk acceptance)
- **Relates to:** ADR-0006 (skill schema; its 2026-07-14 amendment injected bodies observe-only), ADR-0012 §9 + revisit-if (the observe-only decision this scopes), ADR-0016 (S-5 judge, tighten-only), security-model R-4

## Context

Skill descriptions and bodies enter the system prompt whole, at system-prompt authority, unconditionally at session start, with no tool call required. Since 2026-07-14 they have been scanned raw and warned about, and nothing more. `security-model.md` §5 accepted that for v1 and named the follow-up:

> "unlike arbitrary tool output, a legitimate skill has no reason to contain scanner-flagged override phrasing, and unlike tool output the harness owns this channel, so blocking is implementable without an SDK rewrite channel."

R-4 is the harness's most important honest statement: flagged content still reaches the model. But R-4's *rationale* is specifically that no SDK result-rewrite channel exists. **That rationale does not hold for the system prompt, which the harness assembles itself.** ADR-0012 §9's revisit-if ("Enforcement is needed → revisit the observe-only decision") is precisely this trigger firing.

## Decisions

1. **A high-confidence `block` on a skill's description OR body keeps that whole skill out of the system prompt.** The session still succeeds and the remaining skills still load. Whole-skill granularity mirrors the existing aggregate-budget drop, for the reason already recorded there: a half-injected skill is worse than an absent one.

2. **Description as well as body.** The issue framed this as the "skill-body channel", but enforcing bodies alone is indefensible: the payload simply moves to the description, which lands at identical authority. Both already carry the same "RAW attacker-influenced free text" contract (`src/skills/types.ts`) and were already scanned at the same call site. This is an *enforcement* widening, not a new scan.

3. **`block` only, never `ask`.** `ask` is medium-confidence and far too broad for a channel the operator authored — `base64-blob` alone would drop any skill containing a data URI or a long token in a code fence.

4. **One rule carve-out: a block whose ONLY hit is `unicode-tag-chars` does not drop.** `cleanSkillText` already strips tag characters before this sink, so enforcing there would refuse a skill over characters that could never reach the model: pure false-positive cost for zero marginal benefit. Nothing is lost, because the scanner strips and rescans — tag characters concealing a real payload still fire that payload's plaintext rule, and the block then stands on that rule instead.

5. **Scanner failure fails OPEN, with a warning.** A null result (no scanner injected, or the scanner threw) injects the skill. `scanInjection` is arbitrary caller-supplied code; failing closed would let a scanner that crashes on some input deny every skill. Residual, named: a custom scanner that crashes on attacker-shaped text evades enforcement, having already warned. The shipped `scan()` is throw-hardened (`safeMatch`), so this is narrow in the shipped composition.

6. **No config override.** There is no "load it anyway" switch, in keeping with the repo's posture that a loosening lever is a liability (cf. ADR-0015's refusal of a sandbox `mode: off`, which prevents a *project file* from loosening an *operator's* opt-in). The remedy for a false positive is editing the skill file — which the operator owns, since they chose the directory. **Cost, named:** for a third-party skill pack the remedy degrades to forking the pack. The drop warning therefore carries the skill name, its absolute path, the channel, the rule ids, and the remedy.

7. **Drops are reported structurally**, as `SessionResult.droppedSkills`, not only as a stderr warning, so an eval oracle can assert enforcement without scraping text. The pre-existing budget drop is reported through the same field with `reason: 'prompt-budget'`.

## Honest accounting

**The issue's "near-zero false-positive" premise is wrong, and this ADR does not inherit it.** Adversarial review identified four HIGH rules with genuine false-positive classes on skill-shaped text. Three of them now cause real drops, and are accepted:

- **`markdown-image-exfil`** — any remote image with a query string. A skill derived from a README with a shields.io badge is dropped.
- **`chatml-token` / `llama-inst-token`** — a skill that legitimately *documents* prompt injection (this repo's own dogfooding domain) is indistinguishable from one carrying it. `src/session/session.test.ts` keeps a test that is exactly this case, labelled as the exhibit.
- **`do-not-tell-user`** — skills are instruction-shaped by design, unlike tool output. "Do not tell the user the internal error code; show the friendly message" is a plausible legitimate skill sentence.

The claim that survives is narrower and still worth acting on: for the specific rules that matter most (`ignore-previous`, `disregard-instructions`, `reveal-system-prompt`), a legitimate skill genuinely has no reason to contain that phrasing, and this channel is the one place the harness *can* enforce.

**Enforcement is a property of the composition, not of the session.** `SessionDeps.scanInjection` is optional, and a run without it succeeds with zero enforcement — pinned by test. The shipped CLI and eval paths wire the real scanner; a library consumer who omits it gets warnings and drops from neither. Claiming "always on" would be false.

**The red-team false-block invariant is unaffected.** `falseBlockCount` counts corpus cases of `category: 'benign'` that the *scanner* blocks; a dropped skill is a session-level policy action, is not a corpus case, and never enters that computation. The invariant remains a useful *indirect* instrument, though: the benign corpus set is curated to avoid the shapes the scanner blocks, so adding a benign case shaped like one of the false-positive classes above would fail the gate immediately. That is curation, not proof.

## Alternatives rejected

- **Drop only the flagged text, keep the rest of the skill.** Contradicts the existing, well-argued "a half-injected skill is worse than an absent one".
- **Fail the whole session.** One hostile skill in a pack would deny every task.
- **Enforce in the loader.** Wrong layer: the loader has no scanner dependency, and consumers of `Skill` outside prompt assembly are not the threatened sink.
- **Add a `## Skill:` scanner rule** for the header-spoof case in issue #29. Actively harmful: `buildSystemPrompt` emits that header for every legitimate skill, so under this ADR such a rule would drop any skill documenting the harness's own prompt format. The corpus instead carries a *benign* case containing a quoted `## Skill:` header, which weaponises the absolute false-block gate against exactly that future mistake.

## Revisit if

- **R1:** a real operator hits one of the named false-positive classes. Consider a per-rule enforcement subset (drop on override-phrasing rules only) rather than a config override, keeping the no-loosening-lever posture.
- **R2:** the S-5 judge lands (ADR-0016). Its tighten-only rule composes cleanly here, but a judge-escalated `ask`→`block` would then drop a skill, which widens the false-positive surface and should be a deliberate decision.
- **R3:** issue #45 (skill bodies lose markdown structure, because `cleanSkillText` maps `\n` to a space) is fixed. Today a forged `## Skill:` header cannot reach column 0 *because* of that flattening; preserving newlines makes the spoof a real line-start header. The two changes must be considered together — `src/session/session.test.ts` pins the coupling so it cannot be fixed silently.
- **R4:** a tool-output rewrite channel appears in the SDK. Then R-4's general observe-only stance is revisitable on its own terms, and this ADR's carve-out stops being exceptional.
