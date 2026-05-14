# Problem Framing

> The first artefact in this repo. Written before any code, to force clarity about *what* is being built and *why*.

## The observation

Building production LLM agents involves three problems that the existing ecosystem (LangGraph, CrewAI, Mastra, AutoGen, etc.) addresses unevenly:

1. **Harness concerns** — model routing by task shape, skill/tool loading, hook execution, telemetry, cost tracking — are reinvented in every project.
2. **Security concerns** — prompt injection on tool results, secret leakage, sandbox boundaries, permission models — are typically bolted on after an incident, not designed in.
3. **Evaluation concerns** — most teams ship agents without regression tests, red-team corpora, or adversarial verification. "It worked when I demoed it" is the bar.

The frameworks above optimise for *building* agents. They underweight *operating* and *evaluating* them.

## The problem this repo solves

**For a solo developer or small team that wants to ship an LLM agent and not get paged at 3am because it leaked a secret or regressed on a critical task — there is no off-the-shelf harness that ties routing, security, and evaluation together.**

You either:
- Cobble it together yourself across 6 libraries and 200 lines of glue, OR
- Adopt a heavyweight framework that forces an opinionated agent execution model, OR
- Pay for a hosted observability platform (LangSmith, Braintrust, Helicone) and still build your own security and routing.

This repo is a fourth option: **a thin, local-first, MIT-licensed harness that wraps an existing SDK (Claude first) and provides routing + security + eval as composable modules.**

## Who is this for?

Primary persona: **Solo dev or small AI team shipping their first production agent.**

They:
- Have a working prototype on Claude/OpenAI/Gemini.
- Are about to expose it to users (internal or external).
- Realise they need cost tracking, injection defence, and some way to know if a change breaks things.
- Don't want to refactor onto LangGraph just to get those primitives.

Secondary persona: **AI engineering candidate or hiring manager evaluating one.** This repo doubles as a portfolio piece — every architectural choice is documented in [docs/decisions/](../docs/decisions/) so the *reasoning* is legible, not just the artefact.

## Why now?

- Claude Agent SDK shipped a stable surface in 2025; the harness layer above it is converging on patterns worth codifying.
- Prompt-injection research (Greshake et al., Simon Willison's ongoing catalogue, OWASP LLM Top 10) is mature enough to drive a useful red-team corpus.
- Most public "agent" repos remain demos, not operationally-minded harnesses. There's an open lane.

## What this is not

To prevent scope creep, listing what this repo will deliberately **not** become:

- Not a new agent framework. It wraps SDKs; it does not define execution semantics.
- Not multi-tenant SaaS. Local-first, single-user, run-it-yourself.
- Not a UI. CLI + library. A future GitHub Pages site renders docs only.
- Not provider-agnostic in v1. Claude SDK only. OpenAI/Gemini in v2 if there is demand.
- Not a hosted eval platform. Eval runs locally; results are SQLite + Markdown.

## Success criteria

The project succeeds if, at the 4-week mark:

1. A user can `npx agent-harness-ja init`, point it at a Claude API key, and run a hello-world agent with telemetry, injection scanning, and an eval scorecard — in under 10 minutes.
2. The repo contains, at minimum: 6 ADRs, a complete process/ trail, a working red-team corpus of ≥50 cases, and 3 blog-post-quality docs.
3. The author can hand this URL to an AI hiring manager and have a substantive technical conversation triggered by it.

The project fails if it becomes a half-built framework with no users and no documentation. The cut-line is: **docs and process before features.** Always.

## Open questions surfaced during framing

Tracked here so they are not forgotten as decisions are made:

- How opinionated should the default skill loader be? (Mirror the author's curated-127 system, or ship empty?)
- Should the red-team corpus be MIT-licensed alongside code, or separately licensed (CC-BY) to encourage academic reuse?
- Does "two-pass adversarial verification" (using a second model to challenge the first's output) belong in the eval layer or as a runtime guardrail? Possibly both.
- What is the minimum useful telemetry export format? OpenTelemetry feels right but may be over-engineered for v1.

These are intentionally unresolved at framing time. Each will be answered in an ADR before it is built.
