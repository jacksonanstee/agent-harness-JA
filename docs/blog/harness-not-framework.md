# Designing an agent harness: harness ≠ framework

> **Status: Draft — awaiting author voice pass.** 2026-07-14.

The most consequential architectural artifact in this repo is not a module.
It is an eslint rule.

This post is about the one decision everything else in
[agent-harness-JA](../../README.md) hangs off — building a *harness* rather
than a *framework* — and what that distinction bought and cost in practice.
The decision record is [ADR-0001](../decisions/0001-why-harness-not-framework.md);
this is the part an ADR doesn't hold: which consequences actually landed,
and which alternatives I still think about.

## The distinction that matters is control flow

"Framework vs library" debates usually collapse into vocabulary. The version
that has teeth is: **who owns the loop?** A framework calls your code — you
write plugins, handlers, subclasses, and the framework decides when they run.
A harness wraps someone else's loop — here, the Claude Agent SDK's agentic
loop — and confines itself to the seams that loop exposes: what goes in
(model choice, system prompt, skills), what gets gated (pre-tool hooks), and
what gets recorded (telemetry, memory, scorecards).

That framing made a surprising number of downstream decisions for me:

- **No plugin system.** Skills are Markdown files with YAML frontmatter
  ([ADR-0006](../decisions/0006-skill-schema-markdown-frontmatter.md)) —
  data, not code. The moment skills can execute, the harness becomes a
  framework with a security problem. (The eval layer's oracles *are* code,
  and the security model says so loudly rather than gating it — see R-10 in
  the [security model](../security-model.md). That asymmetry is deliberate:
  eval is operator-invoked; skills load on every run.)
- **No abstraction over the SDK.** [ADR-0003](../decisions/0003-claude-sdk-first.md)
  targets one SDK in v1. The multi-provider version kept trying to sneak into
  designs as an "adapter layer" — an abstraction tax paid up front to serve a
  second consumer that does not exist yet. The SDK enters the codebase as a
  *structural type* with a single cast at the CLI boundary
  ([ADR-0010](../decisions/0010-sdk-session-adapter.md)); if a second SDK
  ever lands, the seam is already the injected `query` function, not a
  speculative interface hierarchy.
- **Everything injected.** The session takes `query`, hooks, memory,
  telemetry, and both scanners as dependencies. 800+ of the repo's unit
  tests run without a network, an API key, or the SDK installed doing
  anything at all.

The whole shape is visible in one signature:

```ts
createSession(
  { query, hooks, memory, loadSkills, route, telemetry, scanInjection, redactSecrets },
  { skillsDir, maxTurns, onText, onWarning },
)
```

Every capability the harness composes arrives through the front door. The
test suite's "SDK" is a fake `query` that replays scripted messages *and
drives the registered hook callbacks the way the real SDK would* — which is
the detail that makes injected-deps testing honest. A fake that only yields
messages tests your parsing; a fake that exercises the hook bridge tests the
seam you actually ship. When a hook-ordering bug matters (pre-tool deny must
short-circuit so post-tool never fires for that call), the fake catches it
at unit speed, and the live smoke test exists only to confirm the real SDK
honors the same contract.

## Architecture as a falsifiable claim

The three layers — eval → harness → security — have an enforced dependency
direction: security imports nothing above it, harness never imports eval.
The enforcement is not the architecture diagram in
[docs/architecture.md](../architecture.md); it is eslint
`no-restricted-imports` rules plus a layering test that tries the forbidden
imports and asserts they fail. The diagram is a claim; CI is the proof.

This paid for itself in a way I did not design for. When the permission
model (S-3) needed to deny a tool call, the obvious move was to reuse the
hook runtime's `HookDenial` error. The layering rule said no — security
cannot import from harness. The workaround became the better design: the
security layer throws its own `PermissionDenied`, and the hook runtime
denies on *any* pre-tool throw
([ADR-0014](../decisions/0014-declarative-permission-model.md) §7). That is
a fail-closed contract — an unknown exception in a security gate now denies
instead of propagating — and I would not have arrived at it without the
constraint pushing back. Good boundaries don't just prevent bad imports;
they generate better failure semantics.

## What a harness does not control

Wrapping a loop means inheriting the loop's environment, and honesty about
that belongs in the design, not the footnotes. The SDK bundles its own
Claude Code runtime, and that runtime reads ambient user configuration.
While dogfooding the [repo-qa example](../../examples/repo-qa/README.md) I
watched my *personal* machine-level agent config surface verbatim in harness
output — formatting rules I'd written for an entirely different context,
riding along inside the bundled runtime. Nothing in the harness put them
there, and nothing in the harness can take them out.

A framework could pretend to own that surface. A harness has to name it: the
gates are pre-execution and data-plane
(the [security model](../security-model.md) §1 says exactly this), and the
runtime under the loop belongs to the SDK. The alternative — claiming
isolation you don't have — is how sandboxes end up as attack documentation.
[ADR-0015](../decisions/0015-sandbox-pre-tool-gate.md) has an explicit
"what this cannot stop" section for the same reason.

## The road not taken, revisited honestly

Would a framework have been wrong? Not universally. If the goal were an
ecosystem — third-party skills with behavior, community plugins, an
extension marketplace — the framework shape wins, and the security posture
becomes a permissions model for *code*, which is a different (and much
larger) project. The goal here is narrower: make one SDK's agent loop
observable, gateable, and evaluable, with every claim testable. For that,
the harness shape kept the codebase small enough that the
[three-layer diagram](../architecture.md) is the actual truth, not an
aspiration.

The cost is real too. A harness is only as expressive as the seams the SDK
exposes. The security model's most consequential named residual risk — R-4,
the observe-only posture, accepted because no SDK result-rewrite channel
exists yet — is there *because* the loop isn't mine: enforcement that a
framework would implement in a weekend waits on an upstream channel. I have chosen to document that
boundary rather than fork my way around it, and week by week that choice
keeps being tested. So far it has held.

If you read one thing after this, read the
[week-1 devlog](../../process/devlog/week-1.md) — including the six-week
stall it records. The `process/` folder is the differentiator here, and it
only works if it keeps the failures.
