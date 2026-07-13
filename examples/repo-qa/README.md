# Example: repo Q&A agent

A minimal, self-contained agent built on this harness. It answers questions
about this repository, grounded by one skill
([`skills/adr-conventions.md`](./skills/adr-conventions.md)), runs under a
committed project security policy
([`.harness/settings.json`](./.harness/settings.json)), and ships with its own
golden eval tasks and oracles — so the example is *evaluated*, not just
demonstrated.

Everything here exercises the shipped harness as-is; there is no
example-specific code.

## Run it

Requires `ANTHROPIC_API_KEY` (see the root [README](../../README.md)). From
the repo root, build once, then run **from this directory** so the committed
project settings apply (settings are read from the working directory's
`.harness/settings.json`):

```bash
npm run build
cd examples/repo-qa
node ../../dist/cli.js run "Which ADR covers the permission model, and where do ADRs live?"
```

The skill loads from `./skills` (the default `--skills-dir`), and the trailer
line reports the routed model, turn count, cost, and how many tool calls were
denied. A typical run costs well under a cent.

### See the security policy fire

The committed [`.harness/settings.json`](./.harness/settings.json) denies
`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`, and `WebFetch` — this
agent answers questions; it has no business mutating anything. `Bash` is on
the list because denying `Write` alone is not a boundary: an agent asked to
create a file will happily route around it with `echo > file` (observed live
while building this example — the same lesson as the harness's own
dual-table incident, where tools missing from one gate's table bypassed it).
Ask the agent to do something that needs a denied tool:

```bash
node ../../dist/cli.js run "Try to create a file named demo.txt containing the word hello. If you cannot, reply DENIED and stop."
```

The write is denied by the pre-tool permission gate (ADR-0014) and the trailer
reports `denied=1` (or more). Note what the settings file deliberately does
**not** set: `defaultDecision`. That scalar is project-overrides-user
(security model, residual risk R-8) — a committed example that set it would
be demonstrating the one channel a cloned repo could use to widen a hardened
user's policy. Rules only.

## Evaluate it

The two `*.task.md` files here are real golden tasks (ADR-0017 format) with
sibling `*.oracle.mjs` oracles. From the repo root:

```bash
node dist/cli.js eval examples/repo-qa
```

Expected: 2/2 pass, and a scorecard JSON written under `.harness/eval/`.

> **Trust caveat (R-10):** oracles are arbitrary code executed in-process by
> the eval CLI. Only run `eval` against repositories you trust — including
> this one: read the oracles first. They are each ~15 lines.

## Layout

| Path | What it is |
| --- | --- |
| `skills/adr-conventions.md` | The skill that grounds the agent's answers |
| `.harness/settings.json` | Committed project permission policy (deny rules only) |
| `*.task.md` / `*.oracle.mjs` | Golden tasks + oracles; run with `eval examples/repo-qa` |

The golden runner requires a task's `skillsDir` to stay **inside** the task
directory (a task file cannot point at skills elsewhere in the repo), which is
why this example is self-contained: tasks, oracles, and skills live together
and the tasks pick up `./skills` by default.
