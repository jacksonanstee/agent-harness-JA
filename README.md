# agent-harness-JA

> Most repos show the artefact; this one shows the thinking.
> A local-first agent harness on the Claude Agent SDK (model routing, security guardrails, adversarial evals) with every non-trivial decision recorded: 34 ADRs, a threat model mapped to the OWASP Agentic Top 10, and a red-team gate on every PR.

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
node dist/cli.js telemetry export      # JSONL; filter by --session / --type; --scrub-prefix to share
node dist/cli.js init my-agent         # scaffold a starter project
```

Once the v0.1.0 release is published, the same commands run without a clone: `npx agent-harness-ja init my-agent`, or `npm i -g agent-harness-ja` and then `agent-harness-ja <command>` in place of `node dist/cli.js <command>`.

`init` refuses to overwrite anything it would create (scaffold into a fresh directory), prints the exact next-step commands for a from-clone install, and the starter it produces passes its own eval in one turn. The scaffolded policy denies the network tools and its README explains the Bash route-around it deliberately leaves open, and how to close it.

---

## How to read this repo (for evaluators)

If you are evaluating this repo as a portfolio piece or code sample, the recommended reading order is:

1. **[process/00-problem-framing.md](./process/00-problem-framing.md)**: Why this project exists and who it is for.
2. **[process/01-requirements.md](./process/01-requirements.md)**: Functional and non-functional requirements with traceable IDs.
3. **[docs/decisions/](./docs/decisions/)**: Thirty-four ADRs (0001–0034) covering harness positioning, licence, SDK target, telemetry storage, injection scanning, secret redaction, permissions and sandboxing, the deliberately-deferred LLM judge, the golden runner, the red-team corpus, the fail-on-any-drift regression gate, the adversarial verifier, the init scaffolder, the npm publish path, the locked public API surface, the router's model tiers, refusal handling, block-on-flag enforcement for the skill channel, cleartext paths in retained sinks, the nonce-authenticated skill-section delimiter, why the documentation gate checks structure rather than claims, the scorecard task directory that suppresses an escaping path rather than leaking it, and the deny reason that names a rule without quoting the operator's glob, and the post-tool hook field-name fix that made the output scan and redactor actually run (the SDK sends `tool_response`, not the `tool_output` the harness read), and the tool table derived from the SDK's own declarations in both directions after five declared path/command tools were found to have never been in it, and the settings file treated as hostile input at every level (unknown keys and command entries the shell would rewrite fail loud, and the loader refuses symlinks and non-files and caps the file, the envelope the red-team baseline already had).
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

As of 2026-08-08:

| Milestone | Status |
|---|---|
| Problem framing + requirements | Complete |
| Repo scaffold + CI (Node 20/22 matrix, keyless red-team gate on every PR) | Complete |
| Harness layer (router, skills, hooks, telemetry) | Complete (Weeks 1–2) |
| Security layer (injection, secrets, permissions, sandbox) | Complete (Week 2; hardened Week 4) |
| Eval layer (golden, red-team gate, adversarial verify) | Complete (Week 3) |
| ADRs | 0001–0034 |
| Tests | 1397 at the 2026-08-30 snapshot ([live status: CI](https://github.com/jacksonanstee/agent-harness-JA/actions/workflows/ci.yml)) |
| Docs polish + blog series | Complete (Week 4) |
| npm publish (OIDC trusted publishing + provenance, [ADR-0022](./docs/decisions/0022-npm-publish.md)) | Publish path shipped; v0.1.0 releases on the next tagged GitHub Release |

Shipping plan: [process/05-week-plan.md](./process/05-week-plan.md).

---

## Telemetry & privacy

Everything stays on your machine. Sessions and eval runs persist to a local SQLite file (`.harness/telemetry.db`, gitignored); there is no network telemetry, no phone-home, and no external endpoint anywhere in the codebase. Secrets are redacted before anything is retained and before assistant text reaches stdout (fail-closed: if redaction errors, a `[REDACTION FAILED]` sentinel is written, never the raw text), and findings store rule IDs and offsets, never secret bytes. Export is operator-invoked only (`telemetry export` → JSONL). There is currently no retention TTL: delete `.harness/telemetry.db` to erase history (a `telemetry purge` subcommand is on the roadmap).

Before sharing an export, `telemetry export --scrub-prefix <path>` (repeatable) replaces occurrences of the named prefix, when followed by a path separator or end-of-string (the separator set follows the prefix's own form: `/` after a POSIX prefix, either separator after a Windows-form one), with `[scrubbed-prefix-N]` in the export copy only; the stored rows are untouched, and this is the one opt-in lossy exception to the otherwise byte-stable export. Every emitted row is stamped `scrub: {applied, count, transform}` so a reader can tell a scrubbed export from a raw one; `count` totals replacements across all prefixes and all string sites (keys included), so marker occurrences of any ordinal beyond `count` were planted by the data, not the transform. `applied: true` means at least one replacement fired, never that the row is clean: an occurrence terminated by prose punctuation (`cd /Users/name && ls`), a case variant on a case-insensitive filesystem, an NFC/NFD spelling difference, and everything below the prefix all survive verbatim (ADR-0031, decision 7). Two stderr nudges keep that visible without touching stdout bytes: an unscrubbed export whose rows look home-directory-shaped gets one line, and a scrubbed export where home-shaped paths REMAIN gets one line saying the prefix did not match the stored bytes. A row that cannot be scrubbed safely (hostile nesting, key collision) refuses the whole scrubbed export loudly; the lossless default export is never affected.

### Worked example: why did a skill not load?

A skill can be dropped from the system prompt because the injection scanner blocked it, or because it did not fit the prompt budget. Either way the drop is recorded durably, so a stale incident is still answerable after the run is gone:

```bash
node dist/cli.js telemetry export --type skill-drop
```

Each row carries the skill's `name` and `path`, the `reason` (`injection-block` or `prompt-budget`), the scanned `channels` that blocked it (empty for a budget drop), and the `ruleIds` that fired.

A few fields on that row need a word of explanation, because without it a correctly recorded path reads as corruption:

- **`path` is root-relative since ADR-0031** (issue #59 round 2): it is recorded relative to the skills directory the loader scanned, so the operator's home directory and everything above the skills root stay out of this durable, exportable row — provided the root sits at or below the home directory, or disjoint from it (a root *equal* to `$HOME` strips the full home prefix). A skills root strictly above `$HOME` (`/`, `/Users`) places home segments *below* the root, where they store in cleartext like any other below-root segment. `pathForm` says which form the pair is in: `'root-relative'` for every new row, `'suppressed'` (with `path: null`) for the defensive arm that refuses any shape not positively under the root, and absent on rows written before the field existed, which carry the old absolute form. Everything *below* the root still stores in cleartext, client-named subdirectories included, so this narrows the disclosure rather than closing it.
- **`path` is escaped, not raw.** Skill paths come from a cloned repo, so they are attacker-authored. Control, bidi and invisible characters are rewritten as `\u{...}` before storage rather than deleted, which keeps a hostile `he\u{200B}lper.md` from reading back byte-identical to a benign `helper.md`. `pathHasEscapes` tells you whether the *original* path carried any such character. It is a property of that original (the loader's raw absolute path), so it stays true even if truncation removes the escape sequence, or the escape-bearing segment sat above the skills root: do not re-derive it by scanning the stored string.
- **`pathTruncated`** marks a path bounded to 1024 units, keeping the tail, because the filename is the part that disambiguates. The flag is separate from the value on purpose. `…` is a legal filename character, so an in-band ellipsis could be forged in either direction by a hostile skill pack. `name` has no equivalent flag: it is a display label, not the disambiguator.
- **`pathDigest`** appears only on truncated rows, and is how you tell two of them apart. Keeping the tail discards everything before it, so two skills whose paths differ only in an early directory store an identical `path` — and since ADR-0031 two untruncated skills at the same relative position under *different* roots also store identically, an accepted cost recorded there (rows still carry `sessionId`). The digest covers the full **raw absolute** path on disk, not the relative escaped form stored in `path`, so truncated rows stay distinguishable. That means you can check a digest against a candidate file directly with its absolute path: `printf '%s' "$path" | sha256sum` and compare the leading characters. Hashing the raw path rather than the escaped one is deliberate, because the escape charset tracks a Unicode property and would otherwise silently re-key every stored digest on a Node upgrade. Older rows predate the field and simply omit it.

Literal backslashes in a path are doubled, so a file *named* `\u{202E}` cannot forge a real escape sequence. That doubling on its own does not set `pathHasEscapes`. The reasoning behind both fields, and the residuals the record still carries, is in the [ADR-0011 amendment](./docs/decisions/0011-telemetry-store-and-migrations.md); the field-by-field contract sits with the payload definition in [src/telemetry/types.ts](./src/telemetry/types.ts).

Recording is best-effort: a harness embedded without a `telemetry` dependency records nothing, and a failed write is downgraded to a warning rather than aborting the run.

---

## License

[MIT](./LICENSE). See [ADR-0002](./docs/decisions/0002-mit-license.md) for the reasoning.

---

## Author

Jackson Anstee: [github.com/jacksonanstee](https://github.com/jacksonanstee) · [linkedin.com/in/jackson-anstee](https://www.linkedin.com/in/jackson-anstee-73738263/)

If you are hiring for AI engineering, agent infrastructure, or LLM-app security roles, this repo represents how I scope, design, and ship. Reach out; I would welcome the conversation.
