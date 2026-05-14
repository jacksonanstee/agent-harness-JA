# Week 0 devlog — Foundation

**Dates:** 2026-05-13 → 2026-05-14
**Planned theme:** Foundation: docs done, repo public.

## What shipped

- Problem framing ([00](../00-problem-framing.md))
- Requirements with traceable IDs ([01](../01-requirements.md))
- Brainstorm transcript ([02](../02-brainstorm-transcript.md))
- 4-week shipping plan ([05](../05-week-plan.md))
- ADRs 0001–0006:
  - Harness, not framework
  - MIT license
  - Claude Agent SDK as v1 target
  - SQLite for telemetry
  - Hybrid heuristic + LLM-judge injection scanner
  - Skills as Markdown with YAML frontmatter
- README, LICENSE
- Architecture document ([architecture.md](../../docs/architecture.md))
- Repo scaffold: `package.json`, `tsconfig.json` (strict), `.gitignore`
- `git init` + initial commit

## What slipped

- **Public GitHub repo not yet created.** Pushing to GitHub was deferred pending confirmation of repo name and visibility. Local commits exist; remote push is the next action.
- **GitHub Pages not yet enabled.** Depends on the remote repo existing.
- **`process/03-scope-cuts.md` not written.** On review, the "out of scope" sections in [00-problem-framing.md](../00-problem-framing.md) and [01-requirements.md](../01-requirements.md) cover the same material. Writing a third file would be padding. Marked as deliberately skipped, not deferred.

## What I learned

1. **The reframe from "build a harness" to "document the build of a harness" was the highest-leverage move of the week.** It happened mid-conversation in a single sentence — *"showcase how I build and gather requirements"* — and reshaped the entire project structure. Process visibility is the differentiator; the harness is the substrate that makes the process worth documenting.

2. **Writing the architecture doc surfaced four open questions the requirements doc did not.** They are now named in [architecture.md → Open architectural questions](../../docs/architecture.md). The lesson: requirements describe what must be true; architecture forces you to decide *how*, and the "how" surfaces real unresolved choices. Skipping architecture in favour of jumping to code would have meant deciding those questions implicitly during implementation — the worst time to decide them.

3. **The dependency-direction rule (eval → harness → security → SDK) is doing real work already.** Drafting the injection scanner's interface immediately hit a question: how does the scanner invoke an LLM judge without depending on the harness's router? Answer: call the SDK directly from the security layer. This is the kind of design decision that gets made wrongly when modules are built in isolation and only stitched together later.

## What changes for next week

- **Build order locked:** router → skills → hooks → memory → SDK wiring. Telemetry is a Week 2 deliverable per the plan, but the router needs to log its decisions somewhere — a thin in-memory stub of telemetry's interface will be sufficient for Week 1, with the SQLite-backed implementation arriving in Week 2.
- **Test discipline upfront.** Every module gets its test file in the same commit as its implementation. No "tests later" — they harden as I go.
- **One ADR for the open question on hook mutation** (see [architecture.md → Open architectural questions §3](../../docs/architecture.md)) before writing the hook runtime. Leaning toward observe + accept/deny only.

## Honest assessment

The repo is more polished than most v0.1.0-pre projects, but there is also no working code yet. Three thousand-plus words of documentation against a `dist/` that does not exist. This is intentional — Week 0 is a docs week and the plan permits it — but it would be dishonest not to name the asymmetry. Next week's checkpoint is binary: `npx agent-harness-ja run` either executes a hello-world agent or it does not. That is the right pressure.

## Checkpoint status

Week 0 checkpoint from the plan:

> Repo is public. A stranger can clone it, read the docs, and understand what is being built and why — without reading any code.

**Status: partial pass.** Docs are complete and would let a stranger understand the project. Repo is not yet public — that is the single remaining gate, blocked on a one-line decision (GitHub repo name + visibility) and a `git push`. Calling this "done pending push" rather than re-classifying the checkpoint as failed; the substantive work is complete.
