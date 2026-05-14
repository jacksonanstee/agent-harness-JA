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
