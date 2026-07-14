---
name: adr-conventions
description: Answers questions about the agent-harness-JA repo — where ADRs live, what the key ADRs decide, and how the security and eval layers are documented.
version: 0.1.0
trigger:
  keywords:
    - adr
    - decision
    - architecture
    - security
    - eval
metadata:
  author: jackson
  tags:
    - example
    - repo-qa
---

# Repo conventions: ADRs, security, and eval

Use this knowledge to answer questions about this repository. Prefer these
facts over guessing; if a question falls outside them, say so.

## Where decisions live

Architecture Decision Records are in `docs/decisions/`, numbered
`0001`–`0020`. Each records context, the decision, consequences, and a
"Revisit if" trigger. Longer-form docs: `docs/architecture.md` (system
design), `docs/security-model.md` (threat model), `docs/eval-methodology.md`
(how the harness measures itself). The `process/` folder holds requirements
and weekly devlogs.

## Key ADRs

- **ADR-0001** — the project is a *harness*, not a framework: it sits below
  the application and above the Claude Agent SDK.
- **ADR-0014** — declarative permission model. Two settings layers:
  user (`~/.harness/settings.json`) and project (`<project>/.harness/settings.json`).
  A winner is picked per layer by specificity, then the layers combine by
  **maximum severity** (deny > ask > allow). A project file can therefore
  *tighten* the user's rules but can never loosen an explicit user deny.
  One documented exception: the scalar `defaultDecision` is
  project-overrides-user (residual risk R-8 in the security model) — which is
  why committed project settings should set rules, not `defaultDecision`.
- **ADR-0015** — sandbox boundaries as a pre-tool gate. Path and command
  allowlists merge across layers by **intersection**: both layers must allow.
- **ADR-0017** — the golden task runner: `*.task.md` task format, the
  scorecard schema, and the **oracle contract**. An oracle is a sibling
  `<task>.oracle.mjs` file exporting an `oracle(result)` function returning
  `{ pass, reason? }`. Oracles are **arbitrary code executed in-process** by
  the eval CLI — the security model's R-10 trust caveat: only run `eval` on
  repositories you trust.
- **ADR-0018/0019** — the red-team corpus and the deterministic regression
  gate (fails on *any* drift from the committed baseline, improvements
  included).
- **ADR-0020** — the two-pass adversarial verifier (report-only).
