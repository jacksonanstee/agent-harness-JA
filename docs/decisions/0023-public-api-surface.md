# ADR-0023: Public API surface: complete the root barrel, lock it with an exports map

- **Status:** Accepted
- **Date:** 2026-07-24
- **Requirements:** Pre-publish audit findings V15/V25 (root barrel omits security/telemetry/verifier factories its own signatures reference) and V16 (no `exports` map; entire dist tree deep-importable)
- **Relates to:** ADR-0022 (first publish freezes whatever surface exists; this must land before the v0.1.0 release tag), ADR-0009/ADR-0011 (the memory/telemetry `DEFAULT_DB_PATH` twins this resolves by alias), the eval barrel's named-exports house rule (E-3 review LOW)

## Context

The root barrel exported router/skills/hooks/memory/session/eval but not security or telemetry, even though exported types reference them: `SessionDeps.scanInjection`/`redactSecrets`/`telemetry` and `GoldenRunnerDeps.verifier` are all typed against factories a consumer could not import from the package entry. Meanwhile package.json had no `exports` map, so the entire dist tree was deep-importable. The first npm publish would therefore have frozen an accidental API (every internal module path) while omitting the intended one (the security layer the package description leads with).

Publish makes both mistakes semver-expensive: adding exports later is additive, but *removing* accidental deep-import paths after consumers exist is a breaking change. So the surface had to be corrected while the consumer count is still zero.

## Decisions

1. **Security and telemetry are re-exported from the root barrel by NAME, never `export *`.** ESM ambiguous-star semantics silently exclude any name two barrels both export; memory and telemetry both export `DEFAULT_DB_PATH`, so a star re-export would have vanished the constant with no error anywhere. Named re-exports turn any future collision into a compile error and keep `src/index.ts` an audited surface (the same house rule the eval barrel adopted after the E-3 review).

2. **Telemetry's `DEFAULT_DB_PATH` ships aliased as `TELEMETRY_DEFAULT_DB_PATH`.** Memory's keeps the unprefixed name because it already shipped via the memory star export; renaming it would change existing surface for no gain. The values are identical today (shared substrate, ADR-0009), but the constants are owned by different modules and may diverge. The alias preserves both identities.

3. **The eval barrel exports the verifier's full type closure, not just `createVerifier`.** `GoldenRunnerDeps.verifier?: Verifier` was already public; `Verifier`, `AdversaryFn`, `AdversaryResult`, `ChallengeInput`, and the enum types behind `ChallengeFinding` (`ChallengeStatus`/`ChallengeCategory`/`ChallengeErrorKind`) now travel with it. Exporting a type whose referenced types are unreachable is the same defect class this ADR exists to close. The CLI's deep import of `eval/verifier/` moves to the barrel accordingly.

4. **`exports` restricts the package to `.` and `./package.json`.** The root barrel is the only supported entry; `dist/cli.js` stays reachable via `bin` (bin paths are exempt from `exports`), and `./package.json` stays visible for tooling. `main`/`types` remain as fallbacks for legacy resolvers that predate `exports`. A single `default` condition suffices because the package ships one ESM build; there is no CJS artefact to condition on.

5. **The map is regression-pinned by Node's own resolver, not by reading package.json.** Package self-reference is only legal when `exports` exists, so `src/exports-map.test.ts` resolves `agent-harness-ja` (must hit the root barrel), a deep dist path (must fail with `ERR_PACKAGE_PATH_NOT_EXPORTED` specifically), and `./package.json` (must resolve) through `createRequire`: plain Node resolution, immune to the test runner's resolver, exercising the exact mechanism npm consumers will hit. This matters beyond the library surface, because `init`-scaffolded oracles carry `@type {import('agent-harness-ja').OracleFn}` JSDoc, which resolves through this map.

## Consequences

- Consumers can adopt the security layer alone from the package entry (`import { scan, redact, createSandbox } from 'agent-harness-ja'`), which docs/architecture.md has advertised since Week 2.
- Deep imports (`agent-harness-ja/dist/...`) fail at resolution. Nothing inside the repo used them (verified: CLI, examples, and CI all run `dist/cli.js` by file path), and pre-publish there are no external consumers to break.
- `SECRET_CORPUS` remains unexported (test-only fixture, ADR-0022); completing the barrel deliberately did not widen that decision.

## Revisit if

- A second build format (CJS, or a browser condition) is added; the `exports` conditions are where it lands.
- Subpath entries (e.g. `agent-harness-ja/security`) are requested by real consumers; add them to `exports` deliberately rather than reopening deep imports.
