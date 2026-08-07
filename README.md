# agent-harness-JA

> Most repos show the artefact; this one shows the thinking.
> A local-first agent harness on the Claude Agent SDK (model routing, security guardrails, adversarial evals) with every non-trivial decision recorded: 30 ADRs, a threat model mapped to the OWASP Agentic Top 10, and a red-team gate on every PR.

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
| **Harness** | Multi-model routing (Haiku/Sonnet/Opus by task shape, with Fable targetable from a custom table — [ADR-0024](./docs/decisions/0024-router-model-tiers.md)), skill loading, hook runtime, telemetry, memory. **A custom table can downgrade `sensitivity: 'high'`**: routing is first-match-wins and the table is fully replaceable, so a catch-all rule at the top silently sends sensitive work to a weaker model. The router imposes no safety floor by design ([ADR-0007](./docs/decisions/0007-task-descriptor-schema.md)) |
| **Security** | Prompt-injection scanner on tool results (observe-only) and on skill content (enforced when a scanner is wired, as the CLI does: a flagged skill is kept out of the system prompt), secret redaction, permission model, sandbox boundaries |
| **Evaluation** | Golden-task regression suite, red-team corpus (≥50 cases), two-pass adversarial verification |

## What this is not

- Not a new agent framework. It wraps the Claude Agent SDK; it does not replace it.
- Not provider-agnostic in v1. Claude only. See [ADR-0003](./docs/decisions/0003-claude-sdk-first.md).
- Not hosted SaaS. Local-first, single-user, run-it-yourself.
- Not a UI. CLI + library.

For the longer rationale see [process/00-problem-framing.md](./process/00-problem-framing.md).

---

## Quick start

> Everything below is implemented and CI-gated. Requires Node ≥ 20.10. Progress: [process/devlog/](./process/devlog/).
>
> Publishing to npm as `agent-harness-ja` (v0.1.0) via OIDC trusted publishing with build provenance ([ADR-0022](./docs/decisions/0022-npm-publish.md)); the first release is cut from [Releases](https://github.com/jacksonanstee/agent-harness-JA/releases). It runs from a clone today, and via `npx` / `npm i` once that release lands.

Run from a clone (works today):

```bash
git clone https://github.com/jacksonanstee/agent-harness-JA && cd agent-harness-JA
npm ci && npm run build

# Configure (needed for run/eval; the red-team gate is keyless)
export ANTHROPIC_API_KEY=sk-ant-...

node dist/cli.js run "your prompt"
node dist/cli.js eval                  # golden eval suite
node dist/cli.js eval --challenge      # report-only second-pass adversarial challenge
npm run redteam                        # keyless drift gate (see docs/decisions/0019)
node dist/cli.js telemetry export      # JSONL; filter by --session / --type
node dist/cli.js init my-agent         # scaffold a starter project
```

Once the v0.1.0 release is published, the same commands run without a clone: `npx agent-harness-ja init my-agent`, or `npm i -g agent-harness-ja` and then `agent-harness-ja <command>` in place of `node dist/cli.js <command>`.

`init` refuses to overwrite anything it would create (scaffold into a fresh directory), prints the exact next-step commands for a from-clone install, and the starter it produces passes its own eval in one turn. The scaffolded policy denies the network tools and its README explains the Bash route-around it deliberately leaves open, and how to close it.

---

## How to read this repo (for evaluators)

If you are evaluating this repo as a portfolio piece or code sample, the recommended reading order is:

1. **[process/00-problem-framing.md](./process/00-problem-framing.md)**: Why this project exists and who it is for.
2. **[process/01-requirements.md](./process/01-requirements.md)**: Functional and non-functional requirements with traceable IDs.
3. **[docs/decisions/](./docs/decisions/)**: Thirty ADRs (0001–0030) covering harness positioning, licence, SDK target, telemetry storage, injection scanning, secret redaction, permissions and sandboxing, the deliberately-deferred LLM judge, the golden runner, the red-team corpus, the fail-on-any-drift regression gate, the adversarial verifier, the init scaffolder, the npm publish path, the locked public API surface, the router's model tiers, refusal handling, block-on-flag enforcement for the skill channel, cleartext paths in retained sinks, the nonce-authenticated skill-section delimiter, why the documentation gate checks structure rather than claims, and the scorecard task directory that suppresses an escaping path rather than leaking it.
4. **[docs/architecture.md](./docs/architecture.md)**: System design and module boundaries.
5. **[docs/security-model.md](./docs/security-model.md)**: Threat model and mitigations.
6. **[docs/eval-methodology.md](./docs/eval-methodology.md)**: How the harness measures itself: gates vs. reported metrics, regression semantics, case authoring.
7. **[src/](./src)**: The implementation. Requirement IDs from `process/01-requirements.md` are cited in code comments where they are verified.
8. **[process/devlog/](./process/devlog/)**: Weekly retros, including what went wrong.
9. **[docs/blog/](./docs/blog/)**: Three essays on the judgement behind the design: [harness ≠ framework](./docs/blog/harness-not-framework.md), [adversarial evaluation](./docs/blog/adversarial-evaluation.md), and [the pragmatic security model](./docs/blog/pragmatic-security-model.md). Start here if you want the reasoning without the file-by-file tour; there is also a runnable, evaluated example agent in [examples/repo-qa/](./examples/repo-qa/README.md).

The `process/` folder is the differentiator. If you only read one thing, start there.

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

As of 2026-08-04:

| Milestone | Status |
|---|---|
| Problem framing + requirements | Complete |
| Repo scaffold + CI (Node 20/22 matrix, keyless red-team gate on every PR) | Complete |
| Harness layer (router, skills, hooks, telemetry) | Complete (Weeks 1–2) |
| Security layer (injection, secrets, permissions, sandbox) | Complete (Week 2; hardened Week 4) |
| Eval layer (golden, red-team gate, adversarial verify) | Complete (Week 3) |
| ADRs | 0001–0030 |
| Tests | 1170 at the 2026-08-04 snapshot ([live status: CI](https://github.com/jacksonanstee/agent-harness-JA/actions/workflows/ci.yml)) |
| Docs polish + blog series | Complete (Week 4) |
| npm publish (OIDC trusted publishing + provenance, [ADR-0022](./docs/decisions/0022-npm-publish.md)) | Publish path shipped; v0.1.0 releases on the next tagged GitHub Release |

Shipping plan: [process/05-week-plan.md](./process/05-week-plan.md).

---

## Telemetry & privacy

Everything stays on your machine. Sessions and eval runs persist to a local SQLite file (`.harness/telemetry.db`, gitignored); there is no network telemetry, no phone-home, and no external endpoint anywhere in the codebase. Secrets are redacted before anything is retained (fail-closed: if redaction errors, the write is dropped, not passed through), and findings store rule IDs and offsets, never secret bytes. Export is operator-invoked only (`telemetry export` → JSONL). There is currently no retention TTL: delete `.harness/telemetry.db` to erase history (a `telemetry purge` subcommand is on the roadmap).

### Worked example: why did a skill not load?

A skill can be dropped from the system prompt because the injection scanner blocked it, or because it did not fit the prompt budget. Either way the drop is recorded durably, so a stale incident is still answerable after the run is gone:

```bash
node dist/cli.js telemetry export --type skill-drop
```

Each row carries the skill's `name` and `path`, the `reason` (`injection-block` or `prompt-budget`), the scanned `channels` that blocked it (empty for a budget drop), and the `ruleIds` that fired.

Two fields on that row need a word of explanation, because without it a correctly recorded path reads as corruption:

- **`path` is escaped, not raw.** Skill paths come from a cloned repo, so they are attacker-authored. Control, bidi and invisible characters are rewritten as `\u{...}` before storage rather than deleted, which keeps a hostile `/skills/he\u{200B}lper.md` from reading back byte-identical to a benign `/skills/helper.md`. `pathHasEscapes` tells you whether the *original* path carried any such character. It is a property of that original, so it stays true even if truncation later removes the escape sequence itself: do not re-derive it by scanning the stored string.
- **`pathTruncated`** marks a path bounded to 1024 units, keeping the tail, because the filename is the part that disambiguates. The flag is separate from the value on purpose. `…` is a legal filename character, so an in-band ellipsis could be forged in either direction by a hostile skill pack. `name` has no equivalent flag: it is a display label, not the disambiguator.
- **`pathDigest`** appears only on truncated rows, and is how you tell two of them apart. Keeping the tail discards everything before it, so two skills whose paths differ only in an early directory store an identical `path`. The digest covers the full **raw** path, the real filename on disk rather than the escaped form stored in `path`, so the rows stay distinguishable. That means you can check a digest against a candidate file directly: `printf '%s' "$path" | sha256sum` and compare the leading characters. Hashing the raw path rather than the escaped one is deliberate, because the escape charset tracks a Unicode property and would otherwise silently re-key every stored digest on a Node upgrade. Older rows predate the field and simply omit it.

Literal backslashes in a path are doubled, so a file *named* `\u{202E}` cannot forge a real escape sequence. That doubling on its own does not set `pathHasEscapes`. The reasoning behind both fields, and the residuals the record still carries, is in the [ADR-0011 amendment](./docs/decisions/0011-telemetry-store-and-migrations.md); the field-by-field contract sits with the payload definition in [src/telemetry/types.ts](./src/telemetry/types.ts).

Recording is best-effort: a harness embedded without a `telemetry` dependency records nothing, and a failed write is downgraded to a warning rather than aborting the run.

---

## License

[MIT](./LICENSE). See [ADR-0002](./docs/decisions/0002-mit-license.md) for the reasoning.

---

## Author

Jackson Anstee: [github.com/jacksonanstee](https://github.com/jacksonanstee) · [linkedin.com/in/jackson-anstee](https://www.linkedin.com/in/jackson-anstee-73738263/)

If you are hiring for AI engineering, agent infrastructure, or LLM-app security roles, this repo represents how I scope, design, and ship. Reach out; I would welcome the conversation.
