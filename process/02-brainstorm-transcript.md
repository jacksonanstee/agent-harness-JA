# Brainstorm transcript

> A sanitised record of the conversation that scoped this project. Included because *how* a project gets scoped is at least as instructive as the scope itself. Real engineering happens in dialogue, not in finished documents.
>
> This is condensed, not verbatim. Names of unrelated projects and personal context have been removed. Decisions made here are tracked forward into [ADRs](../docs/decisions/) and [requirements](./01-requirements.md).

## Setting

The author is exploring a career move into AI engineering and asked a working AI assistant (Claude Opus 4.7, in Claude Code CLI) to help identify a portfolio project that would credibly demonstrate skills in **agent harness design, security, and architecture**.

Prior conversation had ruled out:

- Generic RAG / chatbot demos — saturated, undifferentiated.
- Trading-bot ideas — negative expected value, fails standard idea-promotion tests.
- New agent frameworks — competing against five mature incumbents.
- Pure passive-income plays — distinct goal; this project is hiring signal, not revenue.

## Turn 1 — Recommend a project

**Author:** I want to get into the AI space for work. Recommend something I can build to highlight my skills — focus on harness, security, and architecture.

**Assistant:** You are sitting on a portfolio piece and not seeing it. You already have a curated skills system, a multi-model routing pattern, a two-pass adversarial verification framework, and a hook-based runtime — they are private. Package them as an open-source agent harness with:

- **Harness layer:** routing, skills, hooks, telemetry, memory.
- **Security layer:** prompt-injection scanner, secret redaction, permission model, sandbox boundaries.
- **Eval layer:** golden tasks, red-team corpus, adversarial verification.

The work is extraction and generalisation, not invention. Roughly 70% reuse, 30% new code (mostly eval harness + red-team corpus + docs). Ship in 4 weeks of focused evenings/weekends.

**Author reaction:** Accepted in principle. Wanted to confirm the framing was honest (not flattery) and that it would actually read as credible to an AI hiring manager.

## Turn 2 — Showcase the *process*, not just the artefact

**Author:** Make sure this is accessible from GitHub and can be used as a showcase of *how I build and gather requirements*.

**Assistant:** This reframe is bigger than the harness itself. Most portfolio repos show the artefact. Yours can show the *process* — which is rarer and more valuable for hiring.

Two parallel tracks, both visible, both polished:

1. **The product** — working harness code.
2. **The narrated build** — `process/` folder with problem framing, requirements, scope cuts, weekly devlog. `docs/decisions/` folder with ADRs.

The README's job is to direct evaluators through both. The `process/` folder is the differentiator.

**Decisions locked in this turn:**

| Question | Decision | Captured in |
|---|---|---|
| Repo name | `agent-harness-JA` | README |
| License | MIT | [ADR-0002](../docs/decisions/0002-mit-license.md) |
| SDK target v1 | Claude Agent SDK | [ADR-0003](../docs/decisions/0003-claude-sdk-first.md) |
| Hosting | GitHub + GitHub Pages | Requirement N-6 |

## Turn 3 — Produce the foundation documents

**Author:** Proceed with content first (problem framing, requirements, first ADRs), scaffolding second.

**Assistant rationale:** Content is the hard part; scaffolding is mechanical. Once framing and requirements read well, the directory structure follows naturally.

Produced:

- [`process/00-problem-framing.md`](./00-problem-framing.md) — problem, persona, success criteria, out-of-scope.
- [`process/01-requirements.md`](./01-requirements.md) — MUST/SHOULD/COULD requirements with traceable IDs (H-/S-/E-/N-).
- [`docs/decisions/0001-why-harness-not-framework.md`](../docs/decisions/0001-why-harness-not-framework.md) — positioning.
- [`docs/decisions/0002-mit-license.md`](../docs/decisions/0002-mit-license.md) — license choice.
- [`docs/decisions/0003-claude-sdk-first.md`](../docs/decisions/0003-claude-sdk-first.md) — SDK target.

## Turn 4 — Extend the foundation

**Author:** Continue.

**Assistant:** Produced the README, three more ADRs (telemetry storage, injection scanner, skill schema), and this transcript.

- [README.md](../README.md)
- [`docs/decisions/0004-sqlite-for-telemetry.md`](../docs/decisions/0004-sqlite-for-telemetry.md)
- [`docs/decisions/0005-injection-scanner-hybrid.md`](../docs/decisions/0005-injection-scanner-hybrid.md)
- [`docs/decisions/0006-skill-schema-markdown-frontmatter.md`](../docs/decisions/0006-skill-schema-markdown-frontmatter.md)

## Observations on this process

A few things worth naming about *how* the scope landed where it did:

1. **The hardest move was reframing the existing private work as a portfolio asset.** Before this conversation, the author had treated the skills system, routing rules, and verification framework as personal infrastructure. Recognising they were the product (sanitised and generalised) collapsed weeks of speculative design into a much shorter extraction task.

2. **Several ideas were killed before this one survived.** Trading bots, generic RAG demos, and a new agent framework were considered and rejected on the same axis: low differentiation against incumbents with better resources. Documenting what was rejected and *why* is itself part of the engineering record.

3. **Showcasing process was a late-stage user prompt that materially improved the project.** The repo went from "decent portfolio piece" to "differentiated portfolio piece" on one sentence: *"I want to showcase how I build and gather requirements."* That instinct — to make the build legible, not just the artefact — is worth more than any single technical decision in the repo.

4. **No code has been written yet.** Five thousand words of framing, requirements, and ADRs exist before the first `package.json`. This is deliberate. The cost of writing the wrong code is far higher than the cost of writing the right docs.

## What this transcript exists to demonstrate

For an evaluator reading this file: the point is not that the author had a clever conversation with an AI. The point is that the author:

- Started with a goal (AI-engineering portfolio piece), not a feature.
- Audited existing assets before designing new ones.
- Distinguished hiring signal from revenue early.
- Killed at least three alternatives before committing.
- Insisted on legible process, not just legible output.
- Documented the decisions immediately, while context was fresh.

That sequence is the skill being demonstrated. The harness is the artefact that proves it.
