# External review (Lachie, at 5d8e59b) — verified triage at main 84c4ae0, 2026-08-25

Method: five adversarial verifiers (one per finding group), each briefed to REFUTE by execution against a detached
worktree at 84c4ae0; orchestrator re-derived the P0 from the SDK types, from the repo's own telemetry (real traffic,
July and August) and from one live smoke on today's build ($0.17). Every verdict below rests on an executed run;
scripts are under the session scratchpad (verify-p0, verify-p1a, verify-p1b, verify-p1c, verify-p2).

Scorecard of the reviewer: 13 P1 claims verified: 8 CONFIRMED, 4 PARTIAL, 0 REFUTED outright (7d's stated exploit
was refuted, a narrower variant is real). P0 CONFIRMED three ways. P2 premises: mostly CONFIRMED, with "silently"
refuted twice and two proposals restating already-priced decisions. A high-fidelity review.

## Table

| # | Finding | Verdict | Severity (ours) | What the reviewer got wrong / missed | Recommendation |
|---|---|---|---|---|---|
| P0 | Post-tool path receives nothing (`tool_output` vs SDK `tool_response`) | CONFIRMED: types (SDK requires `tool_response`; harness type REJECTS a literal using it), execution (scan sees `""`, redactor skipped, resultSummary null, custom hook `result` undefined), real telemetry 6/6 null (Jul/Aug) + 8/8 null (repo-qa WAL) + live smoke today null | P0 for the security layer's claims; pre-tool gate, input redaction, memory redaction, skill channel unaffected | Symbol is `SdkHookInput`; the cast is not the enabler (structural supertype is); "redactor never fires" is output-only; custom-hook claim scripted not live; MISSED: ADR-0010:88-92 (2026-07-06) already said "use `updatedToolOutput` or rework this seam", so R-4 was contradicted by the repo's own ADR from day one | INCLUDE, own PR, first after #80. RED first with an SDK-typed literal; import SDK hook types; fix 5 reads; fix fake; type-parity probe; docs parity at 9 sites + ADR-0010 contradiction; ADR-0032; record-replay fixture gate from genuine traffic (CI has no key; keyed smoke stays out-of-band) |
| P0b | R-4 premise stale: `updatedToolOutput` / `updatedInput` exist | CONFIRMED (in the only SDK version ever pinned; runtime-validated per tool output shape) | Design-changing | "Implementable the whole time" is fair, but rewrite must preserve per-tool output shape | SEPARATE design decision (ADR), not bundled with the field fix: shape validation, false-positive policy, what "enforce" means for `ask` results |
| 1.1 | `ask` means `deny` headless, "silently" | PARTIAL: mechanics yes; "silently" REFUTED (startup stderr warning, per-deny reason in telemetry/model/memory, pinned test); documented ADR-0014:28,74, architecture:84, security-model:344 | Low | Cite wrong (cli.ts:451 is the wiring); missed composeSecurity warning | DECLINE as defect. DEFER prompter to interactive mode (ADR-0014's own revisit-if). DO add a README settings section (README has no settings schema at all) |
| 1.2a | Setting typos fail open | CONFIRMED for unknown KEYS inside `permissions`/`sandbox` (composeSecurity warnings=[]; typo'd default -> allow; typo'd sandbox.paths -> Write /etc/passwd allowed). Values/nested keys fail loud | Medium | Permissions unknown-key ignore is BLESSED by settings.test.ts:32-37 + ADR-0014 §5 (root-level meaning); sandbox parser contradicts its own comment (:40-43) | INCLUDE: reject (or warn) unknown keys inside the two dimensions, keep root siblings ignored; flip test; sandbox test; comment; security-model row |
| 1.2b | Composition: project `defaultDecision: allow` beats user `deny` | CONFIRMED behaviour, but it is R-8 (security-model:371, High for hardened users, deliberate ADR-0014 §5) | Known residual | Presented as undiscovered; correct that types.ts:17-21 states tighten-only without the scalar exemption | DECLINE as new; one-line docs fix to types.ts. Reversing R-8 = Jackson's design call |
| 1.3 | Tool table incomplete (R-9 "already happened") | CONFIRMED and understated: never complete at the pinned 0.3.201 (5 path/command tools absent: Projects, Workflow, Monitor, Artifact, EnterWorktree; MultiEdit in table but not in SDK); all pass both gates; `Workflow` PROVEN exposed in headless runs (live smoke tool list) | Medium (R-9's own rating), now with proven exposure | R-9 frames it as a future "new tool"; ADR-0015:22 "covers all" is false | INCLUDE: 5 entries (Projects has 2 fields; optional fields need a ToolTarget shape decision), derived test parsing sdk-tools.d.ts (20-line prototype exists), R-9 "any", ADR-0015 fix, MultiEdit annotate |
| 1.4 | `MemoryStore.delete` ignores limit/order/includeStale | CONFIRMED, understated: `{type,limit:0}` read()=0 rows, delete()=all; unknown field ignored | Low in binary (no caller), Medium as public API (ADR-0023 surface) | week-5 devlog "closes the class" is false (read/delete disagree on 5 of 6 fields) | INCLUDE: narrow delete's filter type or reject fields; tests; ADR-0009 line; week-5 correction |
| 1.5 | Router decorative in CLI | PARTIAL: true for `run` (no flags, fixed descriptor -> sonnet every time); false for the CLI (eval routes per-task; init template routes to haiku); already recorded week-6.md:52-53 | Low-Medium usability, no safety consequence | "Decorative" and "in the shipped CLI" overreach | INCLUDE the flags (`--shape --sensitivity --expected-tokens`) as a small change; independent of P2.4 |
| 1.6 | Stale corpus numbers | CONFIRMED: shipped 53 / 41 malicious / 37 detected (90.2%) since db164e6 (2026-07-28); stale present-tense in eval-methodology.md:63,227, security-model.md:414,436, blog/adversarial-evaluation.md:16; ADR-0018 dated (fine); no gate covers | Low, high parity value | "Four documents" accurate; note 90.2% clears ADR-0018's >=90% by 0.2 | INCLUDE: re-derive prose + a corpus-number gate vs baseline.json (DEC-0016 shape) |
| 7a | PEM >16,384 evades | CONFIRMED + unterminated oversized also leaks; docs FALSE (rules.ts:172, ADR-0013:99-102); bench: `*?` + `|$` is 0.2ms vs bounded 118ms on the ADR's own worst case | Low exploit, Medium honesty | Understated | INCLUDE: fix pattern, boundary test at 16384/16385, ADR-0013 amendment |
| 7b | stdout unredacted | CONFIRMED (AKIA key reaches stdout; memory copy redacted; no doc claims stdout redacted) | Medium-Low (CI log case) | Scope gap, not parity | INCLUDE: redact in onText fail-closed; one doc sentence |
| 7c | Skills root symlink escapes in `run` | CONFIRMED, NOT a residual: loads silently; golden refuses; ADR-0006:111 claim vacuous; no R-row | Medium-Low (payload = skill-shaped files only) | Correct | INCLUDE: contain root vs cwd (two-stage like containSkillsDir) or refuseSymlinkedDir on skillsDir; test; ADR-0006; R-row |
| 7d | Glob chars in command gate | PARTIAL: stated exploit REFUTED (exact argv0 compare; /bin/sh always denied). REAL variant: glob-shaped allowlist ENTRY accepted, passes blocklist, no warning, shell expands to /bin/sh (bash+zsh executed) | Low (operator misconfig, plausible cause) | Exploit chain wrong; ADR-0015:30,32 falsified by the variant | INCLUDE small: reject glob-shaped entries at parse + argv0 check; ADR-0015 wording |
| 7e | Settings loader lacks hostile-input envelope | CONFIRMED gap vs the project's own baseline standard (symlink followed silently; 10 chars of an arbitrary file leak via V8 parse error; 50MB loads) | Low-Medium | Belongs at composeSecurity; baseline.ts:149-152 already anticipates "a third consumer" | INCLUDE: hoist refuseSymlink/ancestor walk to internal; lstat + byte cap; drop V8 snippet |
| 7f | Golden pack bounds | CONFIRMED, but documented v1 revisit-if (ADR-0017:251-253); "default cap" wording overstates | Low-Medium | Framing | INCLUDE small: schema `maximum`, `--max-tasks`, close revisit-if |

## P2 design proposals (decisions, not defects)

| # | Premise fidelity | Repo's recorded position | Recommendation |
|---|---|---|---|
| 2.1 verifier bandwidth | CONFIRMED | Deliberate + priced: prose findings would downgrade E-1's STRUCTURAL no-leak invariant to procedural (ADR-0020:67-76); severity/confidence cut for calibration (:591-595); revisit-if when live runs accumulate | DECLINE prose/evidence offsets (it is the rejected "prose + sanitiser" alternative). CONSIDER closed enums only (severity, failed criterion) later; no consumer today |
| 2.2 semantic judge on `pass` | PARTIAL: design already has `always` mode covering pass; trigger is <90%, live 90.24% | S-5 designed, deferred to trigger (ADR-0016:82-86; week-plan:82) | PROMOTE: implement S-5 next after the P0/P1 batch; the trigger is 0.24 points from firing and the 4 misses are all `pass`. Adopt the structural/contextual split |
| 2.3 catalogue + fetch skills; quarantine override | PARTIAL: "silently" REFUTED (stderr, droppedSkills, telemetry skill-drop); no approval path is decision 8 with revisit R1 | ADR-0026 | FILE as design issue. Trust-model change (body at tool-result authority vs system-prompt authority) worth an ADR; not now |
| 2.4 adaptive routing in envelope | Thresholds CONFIRMED intuition (ADR-0007:60); "untestable" was about model-picks-model routing | Override-by-table is the mechanism; no calibration data yet | DEFER: ship 1.5 flags, collect cost data, then calibrate. File as design issue |
| 2.5 semantic lane | PARTIAL: repo-qa oracles assert facts; verifier is the recorded mechanism | ADR-0017:141-143, ADR-0020:25-31 | DEFER; overlaps 2.1. Fix one parity point: ADR-0017:11-13 "sample suite passing in CI" vs golden not in per-PR CI |
| Product gaps | (i) recorded v1.x; (ii) $ budget H-6 recorded, token/wall-clock/cancel NOT; (iii) retry/timeout NOT; (iv) E-5 recorded; (v) deliberate ADR-0021 | | ADD roadmap lines for (ii) token/wall-clock/cancel and (iii) retry/timeout in process/01-requirements.md; leave the rest |

## Process note / ADR-0032
INCLUDE. The honest account: the process verified everything it owned and nothing it did not; the fake fabricated the
field the type steered it to; ADR-0010 had named `updatedToolOutput` two days before R-4 said no channel existed. The
structural fix: a record-replay fixture captured from genuine SDK traffic that fails when the real event shape and
the harness's expectation diverge, plus SDK-typed hook callbacks so the compiler owns the class. Leaner narration:
take the style note.

## Sequencing (proposed)
0. Merge #80 (ready; the P0 fix rebases onto session.ts +49 lines otherwise).
1. PR A: P0 field fix + tests + docs parity (9 sites + ADR-0010 contradiction) + ADR-0032 + replay-fixture gate.
2. PR B: tool table + derived SDK gate (1.3).
3. PR C: settings hardening (1.2a unknown keys, 7e envelope, 7d glob entries): same files.
4. PR D: secrets/stdout (7a, 7b).
5. PR E: skills-root containment (7c).
6. PR F: memory delete (1.4).
7. PR G: small batch: 1.6 corpus gate + prose, 1.5 run flags, 7f bounds, types.ts sentence, ADR-0017 wording, README settings section, roadmap lines.
8. Design issues: enforcement via updatedToolOutput (R-4 rewrite); S-5 judge (promote); catalogue+fetch; adaptive routing; semantic lane.

## Decisions for Jackson
1. Enforcement (updatedToolOutput) bundled with the P0 fix or its own ADR/PR? (rec: separate)
2. Reverse R-8 (scalar default composition) or docs-fix only? (rec: docs-fix only)
3. Prompter now or with interactive mode? (rec: with interactive mode; README section now)
4. Which P2 to promote? (rec: S-5 judge only; the rest as design issues)
5. Take the style note (leaner correction ADRs)? (rec: yes)
6. File the INCLUDE set as GitHub issues now, and draft the reply to Lachie?
