# 4-Week Shipping Plan

> Committed schedule for v1.0. Dates are anchored to the project start (2026-05-14) and assume evening/weekend work — not a full-time effort. Each week ends with a checkpoint that must pass before the next week starts.
>
> This is a *contract with future-me*. The [devlog](./devlog/) entries will be written against it. Slippage is documented honestly, not hidden.

## Ground rules

- **Docs and tests gate features.** A feature with no doc and no test does not count as shipped.
- **Cut features, not docs.** If a week slips, the cut comes from `SHOULD`/`COULD` requirements, never from documentation or eval coverage.
- **End-of-week checkpoint is binary.** Either the checkpoint passes or the week is extended. No "mostly done."
- **One devlog entry per week.** Written on the Sunday evening that closes the week. Includes: what shipped, what slipped, what I learned, and what changes for next week.

## Timeline

| Week | Dates | Theme |
|---|---|---|
| 0 | 2026-05-14 → 2026-05-17 | Foundation: docs done, repo public |
| 1 | 2026-05-18 → 2026-05-24 | Harness layer |
| 2 | 2026-05-25 → 2026-05-31 | Security layer + telemetry |
| 3 | 2026-06-01 → 2026-06-07 | Eval layer |
| 4 | 2026-06-08 → 2026-06-14 | Docs polish + launch |

## Week 0 — Foundation (2026-05-14 → 2026-05-17)

This is the current week. Most of it is already complete.

- [x] Problem framing ([process/00](./00-problem-framing.md))
- [x] Requirements with traceable IDs ([process/01](./01-requirements.md))
- [x] Brainstorm transcript ([process/02](./02-brainstorm-transcript.md))
- [x] ADRs 0001–0006
- [x] README
- [x] LICENSE
- [ ] `docs/architecture.md` — system design + module boundaries
- [ ] `process/03-scope-cuts.md` (only if substantively new content vs requirements doc)
- [ ] `package.json`, `tsconfig.json`, `.gitignore`, basic project scaffold
- [ ] Public GitHub repo created, initial commit pushed
- [ ] GitHub Pages enabled, README rendering

**Checkpoint:** Repo is public. A stranger can clone it, read the docs, and understand what is being built and why — without reading any code.

## Week 1 — Harness layer (2026-05-18 → 2026-05-24)

Build the four core harness modules. SDK integration last.

- [ ] **Model router** (H-2) — declarative task descriptor → model selection. Unit tests.
- [ ] **Skill loader** (H-3) — recursive scan, frontmatter validation, schema enforcement. Tests for valid + invalid skills.
- [ ] **Hook runtime** (H-4) — `pre-tool`, `post-tool`, `session-start`, `stop`. Contract documented. Integration tests.
- [ ] **Memory store** (H-5) — typed CRUD + retrieval-by-type. SQLite-backed.
- [ ] **SDK integration** (H-1) — wire the above into a Claude Agent SDK session. `harness run` works end-to-end.
- [ ] CI on every push: lint, typecheck, unit tests.

**Checkpoint:** `npx agent-harness-ja run` executes a hello-world agent with at least one skill loaded, at least one hook firing, and at least one memory entry persisted. All four modules have ≥70% test coverage.

## Week 2 — Security layer + telemetry (2026-05-25 → 2026-05-31)

The most security-sensitive work in the project. Bias toward conservative defaults.

- [ ] **Telemetry module** — SQLite schema, migration runner, per-turn cost + cache + tool-trace events. Export to JSONL.
- [ ] **Injection scanner** (S-1) — heuristic pass with confidence-scored rules.
- [ ] **LLM-judge** (S-5) — optional second-stage scanner for suspicious cases. Off by default.
- [ ] **Secret scanner** (S-2) — ≥20 patterns (API keys, tokens, private keys). Redact + log.
- [ ] **Permission model** (S-3) — allow / ask / deny, inheritable from settings files.
- [ ] **Sandbox boundaries** (S-4) — path allowlist for file tools, command allowlist for bash.
- [ ] `docs/security-model.md` — STRIDE-style threat model, anchored to the modules built this week.

**Checkpoint:** A test agent with `security` enabled blocks ≥10 deliberately-malicious inputs from a starter red-team set. No regressions on the harness-layer test suite. `docs/security-model.md` reads as a senior engineer's threat analysis, not a checklist.

## Week 3 — Eval layer (2026-06-01 → 2026-06-07)

Where this project earns its differentiation. Most portfolio repos skip eval entirely.

- [ ] **Golden task runner** (E-1) — Markdown task definitions, oracle functions, scorecard output.
- [ ] **Red-team corpus** (E-2) — ≥50 cases across direct injection, indirect injection, jailbreak, exfil. Each with a pass/fail oracle. Sources cited (Greshake, Willison, OWASP LLM Top 10).
- [ ] **Regression detection** (E-3) — SQL diff between latest and baseline scorecards. CI fails on regression.
- [ ] **Adversarial verification** (E-4) — second-pass model challenges primary output. Pluggable adversary model.
- [ ] `docs/eval-methodology.md` — how scoring works, what counts as a regression, how to author new cases.

**Checkpoint:** `npx agent-harness-ja eval` produces a Markdown scorecard. Red-team pass rate is ≥90% with default security on; falls to <50% with security off (proves the security layer is doing real work). CI runs eval on every PR.

## Week 4 — Docs polish + launch (2026-06-08 → 2026-06-14)

The work that turns a working repo into a portfolio piece.

- [ ] README pass: tighten the pitch, verify all links, add screenshots/diagrams.
- [ ] `docs/architecture.md` final pass against the actual implementation.
- [ ] Three blog posts drafted in `docs/blog/`:
  - *Designing an agent harness: harness ≠ framework*
  - *Adversarial evaluation for LLM agents: golden + red-team + two-pass*
  - *A pragmatic security model for tool-using agents*
- [ ] `harness init` scaffolder — generates a working starter project.
- [ ] npm package published.
- [ ] GitHub Pages site live and linked from README.
- [ ] Launch:
  - Show HN post
  - r/LocalLLaMA + r/MachineLearning post
  - LinkedIn post anchored to the career goal
  - X/Twitter thread walking through one ADR
  - Cold email to ≥5 AI hiring managers with the repo link
- [ ] Update CV and LinkedIn to link the repo.

**Checkpoint:** Repo is launched. At least one inbound conversation initiated within 7 days of launch. Author can hand the URL to a hiring manager without caveats.

## Slippage protocol

If a checkpoint fails:

1. Stop. Do not start the next week's work.
2. Write a devlog entry naming what slipped and why.
3. Decide explicitly: extend the week, cut scope, or both.
4. Update this file with the new dates and any cut requirements (mark them `DEFERRED-v1.x` in `01-requirements.md`).
5. Tell future-me what changed in the devlog so the audit trail stays honest.

The goal is not to hit every date. The goal is to ship v1.0 with the documentation, eval coverage, and security posture promised — even if it takes 5 or 6 weeks instead of 4.

## What this plan deliberately does not include

- Beta testing with external users. v1.0 is "launched," not "battle-tested."
- Provider abstraction (OpenAI/Gemini). Deferred to v2.
- Web UI / dashboard. CLI + library only.
- Multi-tenant or hosted deployment.
- A custom DSL for skill authoring.

These are tracked in [01-requirements.md](./01-requirements.md) under "Out of scope for v1.0."
