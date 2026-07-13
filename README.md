# agent-harness-JA

> Most repos show the artefact; this one shows the thinking.
> A local-first agent harness on the Claude Agent SDK — model routing, security guardrails, adversarial evals — with every non-trivial decision recorded: 20 ADRs, a threat model mapped to the OWASP Agentic Top 10, and a red-team gate on every PR.

This repo is **both a working tool and a documented build process.**

- The [`src/`](./src) folder contains the harness itself.
- The [`process/`](./process) folder shows how it was scoped, what was cut, and what went wrong along the way.
- The [`docs/decisions/`](./docs/decisions) folder records every non-trivial architectural choice as an ADR.

Docs also render at [jacksonanstee.github.io/agent-harness-JA](https://jacksonanstee.github.io/agent-harness-JA/).

Built by Jackson Anstee as a portfolio project. Feedback, questions, and scrutiny welcome.

---

## What this is

A thin, MIT-licensed, local-first harness that wraps the Claude Agent SDK and provides three things every production agent needs:

| Layer | What it gives you |
|---|---|
| **Harness** | Multi-model routing (Haiku/Sonnet/Opus by task shape), skill loading, hook runtime, telemetry, memory |
| **Security** | Prompt-injection scanner on tool results, secret redaction, permission model, sandbox boundaries |
| **Evaluation** | Golden-task regression suite, red-team corpus (≥50 cases), two-pass adversarial verification |

## What this is not

- Not a new agent framework. It wraps the Claude Agent SDK; it does not replace it.
- Not provider-agnostic in v1. Claude only. See [ADR-0003](./docs/decisions/0003-claude-sdk-first.md).
- Not hosted SaaS. Local-first, single-user, run-it-yourself.
- Not a UI. CLI + library.

For the longer rationale see [process/00-problem-framing.md](./process/00-problem-framing.md).

---

## Quick start

> Everything below is implemented and CI-gated. npm publish is the final Week-4 step, so until then run from a clone (`npx agent-harness-ja …` resolves after publish). Requires Node ≥ 20.1. Progress: [process/devlog/](./process/devlog/).

```bash
git clone https://github.com/jacksonanstee/agent-harness-JA && cd agent-harness-JA
npm ci && npm run build

# Configure (needed for run/eval; the red-team gate is keyless)
export ANTHROPIC_API_KEY=sk-ant-...

# Run the agent
node dist/cli.js run "your prompt"

# Run the golden eval suite
node dist/cli.js eval

# Add a second-pass adversarial challenge over passed tasks (report-only; adds one model call per passed task)
node dist/cli.js eval --challenge

# Run the keyless red-team gate (fails on ANY drift vs the committed baseline — see docs/decisions/0019)
npm run redteam

# Export telemetry as JSONL (filter by --session / --type)
node dist/cli.js telemetry export
```

A `harness init` scaffolder is planned (Week 4) but **not yet implemented** — it is deliberately the first thing cut if the week runs short.

---

## How to read this repo (for evaluators)

If you are evaluating this repo as a portfolio piece or code sample, the recommended reading order is:

1. **[process/00-problem-framing.md](./process/00-problem-framing.md)** — Why this project exists and who it is for.
2. **[process/01-requirements.md](./process/01-requirements.md)** — Functional and non-functional requirements with traceable IDs.
3. **[docs/decisions/](./docs/decisions/)** — Twenty ADRs (0001–0020) covering harness positioning, license, SDK target, telemetry storage, injection scanning, secret redaction, permissions and sandboxing, the deliberately-deferred LLM judge, the golden runner, the red-team corpus, the fail-on-any-drift regression gate, and the adversarial verifier.
4. **[docs/architecture.md](./docs/architecture.md)** — System design and module boundaries.
5. **[docs/security-model.md](./docs/security-model.md)** — Threat model and mitigations.
6. **[docs/eval-methodology.md](./docs/eval-methodology.md)** — How the harness measures itself: gates vs. reported metrics, regression semantics, case authoring.
7. **[src/](./src)** — The implementation. Requirement IDs from `process/01-requirements.md` are cited in code comments where they are verified.
8. **[process/devlog/](./process/devlog/)** — Weekly retros, including what went wrong.
9. **[docs/blog/](./docs/blog/)** — Three essays on the judgment behind the design: [harness ≠ framework](./docs/blog/harness-not-framework.md), [adversarial evaluation](./docs/blog/adversarial-evaluation.md), and [the pragmatic security model](./docs/blog/pragmatic-security-model.md). Start here if you want the reasoning without the file-by-file tour; there is also a runnable, evaluated example agent in [examples/repo-qa/](./examples/repo-qa/README.md).

The `process/` folder is the differentiator — if you only read one thing, start there.

---

## Architecture at a glance

```
┌─────────────────────────────────────────────────────┐
│  EVAL LAYER                                          │
│  Golden tasks · Red-team corpus · Adversarial verify│
├─────────────────────────────────────────────────────┤
│  HARNESS LAYER                                       │
│  Router · Skills · Hooks · Telemetry · Memory       │
├─────────────────────────────────────────────────────┤
│  SECURITY LAYER                                      │
│  Injection scanner · Secret scanner · Permissions   │
│  Sandbox boundaries                                  │
└─────────────────────────────────────────────────────┘
                       │
                       ▼
              Claude Agent SDK
```

Full diagram and module boundaries in [docs/architecture.md](./docs/architecture.md).

---

## Status

As of 2026-07-14:

| Milestone | Status |
|---|---|
| Problem framing + requirements | Complete |
| Repo scaffold + CI (Node 20/22 matrix, keyless red-team gate on every PR) | Complete |
| Harness layer (router, skills, hooks, telemetry) | Complete (Weeks 1–2) |
| Security layer (injection, secrets, permissions, sandbox) | Complete (Week 2; hardened Week 4) |
| Eval layer (golden, red-team gate, adversarial verify) | Complete (Week 3) |
| ADRs | 0001–0020 |
| Tests | 865 at this snapshot — [live status: CI](https://github.com/jacksonanstee/agent-harness-JA/actions/workflows/ci.yml) |
| Docs polish, blog series, npm publish | Week 4 — in progress |

Shipping plan: [process/05-week-plan.md](./process/05-week-plan.md).

---

## Telemetry & privacy

Everything stays on your machine. Sessions and eval runs persist to a local SQLite file (`.harness/telemetry.db`, gitignored); there is no network telemetry, no phone-home, and no external endpoint anywhere in the codebase. Secrets are redacted before anything is retained (fail-closed: if redaction errors, the write is dropped, not passed through), and findings store rule IDs and offsets, never secret bytes. Export is operator-invoked only (`telemetry export` → JSONL). There is currently no retention TTL — delete `.harness/telemetry.db` to erase history (a `telemetry purge` subcommand is on the roadmap).

---

## License

[MIT](./LICENSE). See [ADR-0002](./docs/decisions/0002-mit-license.md) for the reasoning.

---

## Author

Jackson Anstee — [github.com/jacksonanstee](https://github.com/jacksonanstee) · [linkedin.com/in/jackson-anstee](https://www.linkedin.com/in/jackson-anstee-73738263/)

If you are hiring for AI engineering, agent infrastructure, or LLM-app security roles, this repo represents how I scope, design, and ship. Reach out — I would welcome the conversation.
