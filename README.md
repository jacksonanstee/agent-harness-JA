# agent-harness-JA

> A production-grade harness for LLM agents — multi-model routing, security guardrails, and adversarial evaluation. Built on the Claude Agent SDK.

This repo is **both a working tool and a documented build process.**

- The [`src/`](./src) folder contains the harness itself.
- The [`process/`](./process) folder shows how it was scoped, what was cut, and what went wrong along the way.
- The [`docs/decisions/`](./docs/decisions) folder records every non-trivial architectural choice as an ADR.

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

> v1.0 is in active development. The commands below describe the target surface, not the current state. Track progress in [process/devlog/](./process/devlog/).

```bash
# Scaffold a new agent project
npx agent-harness-ja init my-agent
cd my-agent

# Configure
export ANTHROPIC_API_KEY=sk-ant-...

# Run the agent
npx agent-harness-ja run

# Run the golden eval suite
npx agent-harness-ja eval

# Add a second-pass adversarial challenge over passed tasks (report-only; adds one model call per passed task)
npx agent-harness-ja eval --challenge

# Run the keyless red-team gate (fails on ANY drift vs the committed baseline — see docs/decisions/0019)
npm run redteam

# Export telemetry as JSONL (filter by --session / --type)
npx agent-harness-ja telemetry export
```

---

## How to read this repo (for evaluators)

If you are evaluating this repo as a portfolio piece or code sample, the recommended reading order is:

1. **[process/00-problem-framing.md](./process/00-problem-framing.md)** — Why this project exists and who it is for.
2. **[process/01-requirements.md](./process/01-requirements.md)** — Functional and non-functional requirements with traceable IDs.
3. **[docs/decisions/](./docs/decisions/)** — Six-plus ADRs covering harness positioning, license, SDK target, telemetry storage, injection-scanner approach, and skill schema.
4. **[docs/architecture.md](./docs/architecture.md)** — System design and module boundaries.
5. **[docs/security-model.md](./docs/security-model.md)** — Threat model and mitigations.
6. **[docs/eval-methodology.md](./docs/eval-methodology.md)** — How the harness measures itself: gates vs. reported metrics, regression semantics, case authoring.
7. **[src/](./src)** — The implementation. Requirement IDs from `process/01-requirements.md` are cited in code comments where they are verified.
8. **[process/devlog/](./process/devlog/)** — Weekly retros, including what went wrong.

The `process/` folder is the differentiator. Most repos show the artefact; this one shows the thinking.

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

| Milestone | Status |
|---|---|
| Problem framing + requirements | Complete |
| ADRs 0001–0003 | Complete |
| Repo scaffold | In progress |
| Harness layer (router, skills, hooks, telemetry) | Week 1–2 |
| Security layer (injection, secrets, permissions, sandbox) | Week 2 |
| Eval layer (golden, red-team, adversarial verify) | Week 3 |
| Docs + launch | Week 4 |

Shipping plan: [process/05-week-plan.md](./process/05-week-plan.md).

---

## License

[MIT](./LICENSE). See [ADR-0002](./docs/decisions/0002-mit-license.md) for the reasoning.

---

## Author

Jackson Anstee — [github.com/...](https://github.com/) · [linkedin.com/in/...](https://linkedin.com/)

If you are hiring for AI engineering, agent infrastructure, or LLM-app security roles, this repo represents how I scope, design, and ship. Reach out — I would welcome the conversation.
