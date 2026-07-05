# ADR-0006: Skills as Markdown with YAML frontmatter

- **Date:** 2026-05-14
- **Status:** Accepted
- **Deciders:** Jackson Anstee
- **Related requirements:** H-3

## Context

Skills are reusable units of agent capability — a procedure, methodology, or domain-specific instruction set that the agent can invoke. The harness must define a format for skill files.

Realistic options:

1. **Markdown with YAML frontmatter** — human-readable body, structured metadata header. Familiar from Jekyll, Hugo, Obsidian, the Claude skills ecosystem, and most static-site generators.
2. **Pure YAML** — structured throughout. Better for tooling. Worse for prose-heavy content.
3. **JSON** — universal, machine-friendly. Painful for multi-line prose.
4. **Custom DSL** — maximum control. Maximum maintenance cost. Wrong for v1.0.
5. **TypeScript module** — typed and composable. Couples skills to the harness's runtime; complicates non-developer authoring.

Constraints:

- Skills are mostly prose with a small structured header (name, description, trigger conditions, required tools).
- Authors should be non-developers as well as developers — a designer or domain expert should be able to write a skill.
- Validation must catch malformed skills at load time, not at first invocation.
- The format should be readable when rendered on GitHub or in any Markdown viewer.

## Decision

Skill files are **Markdown with YAML frontmatter**, validated against a JSON Schema at load time.

File shape:

```markdown
---
name: example-skill
description: One-line summary used to decide relevance. Be specific.
version: 1.0.0
trigger:
  keywords: [example, demo]
  conditions: []
requires:
  tools: [Read, Bash]
metadata:
  author: jackson
  tags: [example]
---

# Example skill

Markdown body. This is what the agent reads when the skill is loaded.

Use headings, lists, and code blocks freely.
```

Implementation:

- Loader recursively scans the configured `skills/` directory for `*.md` files.
- Frontmatter parsed with `gray-matter`.
- Validation against `src/skills/schema.json` (JSON Schema draft 2020-12).
- Invalid skills produce a structured error pointing to the file and the failing field; load proceeds with valid skills.

## Consequences

### Positive
- Renders nicely on GitHub. A reviewer can read a skill without running anything.
- Familiar to anyone who has touched Jekyll, Hugo, Obsidian, or the existing Claude skills format.
- Schema validation catches typos and missing fields before runtime.
- Non-developer-authorable. A domain expert can contribute a skill by writing prose.

### Negative
- Two formats in one file (YAML + Markdown) means two parsers and two failure modes.
- YAML's significant whitespace causes occasional author confusion.
- No type-level guarantees for the body content; only frontmatter is schema-validated.

### Mitigations
- Ship a `harness skills validate` command for pre-commit validation.
- Document common YAML pitfalls (booleans, leading whitespace, quoting) in `docs/authoring-skills.md`.
- Provide a starter skill template via `harness skills new`.

## Alternatives considered

1. **TypeScript module per skill.** Typed and composable but couples authoring to the runtime; rules out non-developer authoring. Wrong trade-off for a portable skill format.
2. **Pure YAML / pure JSON.** Painful for prose-heavy bodies. The body is the most important part of a skill; the format must privilege it.
3. **Custom DSL.** Premature; no demonstrated need for primitives Markdown cannot express.
4. **Multiple files per skill** (e.g. `skill.yaml` + `skill.md`). Splits the unit of authorship and complicates discovery. Single-file wins for cognitive simplicity.

## Revisit if

- Skills grow structured logic (conditionals, loops) that Markdown body cannot cleanly express.
- A user community emerges that prefers a typed module format and is willing to maintain it.
- The frontmatter schema becomes large enough (≥30 fields) that authoring without an editor plugin becomes painful.

## Amendment (2026-07-05)

H-3 landed. This records the implementation decisions made while wiring the loader, some of which sharpen or correct what was originally specified above.

**`LoadResult` return shape.** `load(dir)` returns `{ skills: Skill[]; errors: SkillError[] }`, not the bare `Skill[]` this ADR originally specified. Rationale: this ADR already requires partial-failure-non-fatal loading *and* per-file structured errors — a bare `Skill[]` discards the errors, silently. A tagged `{ ok: false }` result is the wrong shape too: a load with some invalid files is not a failure of `load` itself, it's `load` doing its job. A missing or unreadable directory collapses to a single `SkillError` of kind `read` inside that same result. A non-string or empty `dir` throws `TypeError` — a programmer error, consistent with the router's `assertValid` precedent from ADR-0007. `validate(file)` is unaffected and remains a tagged `ValidationResult`, per the cross-cutting convention. `docs/architecture.md`'s spec line has been amended to match.

**Sync API.** `readFileSync` / `readdirSync` throughout — no promises. Loading happens once at session start, and the router precedent (also synchronous) already established this shape for the harness. This choice is coupled to the startup-only assumption: if skills ever load off the startup path (a long-running server, hot reload), revisit with an async variant rather than blocking the event loop across the whole tree.

**No `createRouter`-style factory — deliberately.** The router exposes `createRouter({ table })` because its routing table is user-injectable config. The skill schema is not config — it is locked by this ADR — and the only configurable input, the skills directory, is already a plain argument to `load(dir)`. A `createLoader()` factory would inject nothing today; bare `load`/`validate` on a module-level ajv singleton is the honest v1 shape. Revisit if `harness.config` introduces a custom skill schema or additional file extensions: promote to a `createLoader(opts)` factory mirroring `createRouter`, keeping bare `load`/`validate` as default-instance bindings.

**Schema loading mechanism.** `import skillSchema from './schema.json' with { type: 'json' }` (import attributes) — works under `tsc` with `NodeNext` module resolution and under vitest 1.6, with no separate copy-to-dist step: `tsc` emits the JSON alongside the compiled output.

**Ajv.** Draft 2020-12, via the named import `{ Ajv2020 } from 'ajv/dist/2020.js'` — the default-import form isn't constructable under `NodeNext` typing. Used as a singleton, `allErrors: true`. No `ajv-formats` dependency: semver is validated with the official semver.org regex as a plain `pattern`, which keeps runtime deps at exactly two (`gray-matter`, `ajv`).

**Scan semantics.** `readdirSync(dir, { recursive: true, withFileTypes: true })`. Depth is unbounded. Results are sorted by absolute path for deterministic output. Only lowercase `.md` extensions match. We initially assumed the recursive walker does not follow directory symlinks; the security review disproved that empirically (Node 25 *does* descend into them), which motivated the containment gate below.

**Security hardening (same-day, from the 3-agent review + a differential review).** The differential review caught a **critical remote-code-execution** the earlier passes missed: gray-matter selects its parse engine from a language tag on the opening fence (`---js`), and its built-in `javascript` engine `eval()`s the frontmatter body — arbitrary code execution the instant `load()` walks an untrusted pack, *before* schema validation and unaffected by all the containment work. The earlier "gray-matter uses js-yaml safe-load, so no code execution" conclusion was wrong: safe-load is only the *default* engine, and the per-file fence tag overrides it. Two independent guards close it, both test-locked (a `---js` fixture asserts a sentinel never fires): a fence-language check refuses any frontmatter whose language is not empty/`yaml`/`yml` before `matter()` runs at all, and the `javascript`/`js` engines are replaced with throwing stubs so no `eval` happens even if the first guard is ever bypassed. Only YAML frontmatter is a valid skill, so this loses nothing.

Three further guards landed with the module, all test-locked: (1) *containment* — every scanned file's `realpath` must stay under the skills root, so a skill pack shipping a directory symlink cannot exfiltrate outside `.md` files (private notes, memory files) into agent context (Node's recursive readdir *does* follow directory symlinks — verified empirically, contrary to our initial assumption); (2) *error sanitization* — YAML parse errors embed raw snippets of the offending file, so every `SkillError.message`/`file` is stripped of control characters (same regex as the router's `sanitizeReason`, kept in lockstep) to close log/terminal injection from untrusted packs; (3) *size cap* — files over 1 MB are refused with a `read` error rather than read into memory. Verified non-issues, for the record: `__proto__` frontmatter keys do not pollute prototypes and are rejected by `additionalProperties: false` anyway, and the semver pattern is linear (no ReDoS). Also fixed from review: an unreadable subdirectory mid-scan now yields a structured `read` error instead of crashing the whole load, and gray-matter is always called with an options object because it otherwise caches every parse process-wide, keyed by content, forever.

**Schema stances.** `required: [name, description, version]`; `trigger`, `requires`, `metadata` are optional. `additionalProperties: false` at the root and in every sub-object — this is the typo-catcher this ADR promised (e.g. `naem:` is rejected, not silently ignored). `name` must be kebab-case, ≤64 characters. `trigger.conditions` is a plain string array for v1 — a placeholder, not a design.

**Error field pointers.** For a missing required property, ajv's `instancePath` is empty, which would leave `field` unusable. The loader appends `/` + `missingProperty` to it, so `field` always names a concrete field (e.g. `/name`) rather than the schema root.
