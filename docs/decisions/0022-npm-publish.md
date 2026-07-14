# ADR-0022: npm publish via OIDC trusted publishing, with provenance and a pack allowlist

- **Status:** Accepted
- **Date:** 2026-07-14
- **Requirements:** Week-4 S4 (the last item; irreversible, hard-gated)
- **Relates to:** ADR-0018 (defang convention for the red-team payloads that now ship publicly), ADR-0019 §7 (resolves its recorded publish decision point: report-only for external `redteam`), ADR-0021 (the `init` command that becomes the primary no-clone entry point once published), security-model R-10 (publishing widens who can invoke oracle code)

## Context

Publishing to npm is a one-way door: a version number cannot be reused, the package name is claimed, and unpublish is only allowed within 72 hours and never re-usable. It is also the step tied most directly to the job search, so the failure mode is not a broken build but a permanently public mistake: a half-built tarball, a leaked fixture, an un-audited README, or a version that advertises unbuilt features. The plan sequenced this last, after the docs and blog, for exactly that reason.

The decision here is not "should we publish" but "publish in a way where the irreversible action is the last, smallest, most-verified step, and where the supply-chain provenance is real rather than asserted."

## Decisions

1. **Publish from CI via OIDC trusted publishing, not a local `npm publish`.** The publish runs in `.github/workflows/publish.yml`, triggered by publishing a GitHub Release. No long-lived npm token exists anywhere: the workflow exchanges a short-lived GitHub OIDC token for a scoped publish token at run time. `permissions` is `contents: read` + `id-token: write` and nothing more. The runner's bundled npm is upgraded to latest first, because trusted publishing needs npm >= 11.5.1.
   - **One-time manual precondition (operator):** link the trusted publisher on npm (package settings -> Trusted Publisher -> GitHub Actions -> this repo + `publish.yml`). Until that link exists the workflow's publish step fails closed, which is the desired direction.

2. **Build provenance is emitted (`npm publish --provenance`).** The public repo plus OIDC context lets npm attach a verifiable provenance attestation tying the tarball to the exact commit and workflow that built it. The currency review flagged 2026 supply-chain attacks (Phantom-Gyp, Miasma-style forged provenance) as real; provenance is the direct countermeasure, and it is why publishing from a token-in-CI setup was rejected in favour of OIDC.

3. **Actions are pinned by full commit SHA.** `actions/checkout` and `actions/setup-node` are pinned to immutable SHAs (with the version in a trailing comment), so a moved tag cannot swap the action out from under a publish. This is the workflow-hardening half the currency review required.

4. **The workflow re-runs every gate, and a version guard fails loud.** Lint, typecheck, build, test, and the keyless `redteam` gate run as visible steps (defence in depth over `prepublishOnly`, which runs the same set). A dedicated step asserts `package.json` version equals the release tag (`vX.Y.Z`), so a forgotten bump fails before publish rather than shipping a mislabelled tarball.

5. **`prepublishOnly` rebuilds from clean and gates.** `rm -rf dist && npm run build && npm test && npm run redteam`. `dist/` is gitignored and built locally, so nothing else guarantees the tarball reflects current source; the clean rebuild does. This also protects a local `npm publish` (which would otherwise skip provenance and the OIDC path) by making it run the full gate first.

6. **Version `0.1.0-pre` -> `0.1.0`.** An honest first release, not `1.0.0`: the README still says "not v1," the SDK target is Claude-only, and provider-agnosticism is deferred. `publishConfig.access` is `public`.

7. **`engines` corrected `>=20.1.0` -> `>=20.10.0`.** The shipped `dist` uses import attributes (`with { type: 'json' }`), which Node supports only from 20.10; 20.1 through 20.9 SyntaxError on load. The CI matrix (`[20, 22]`) resolves to latest minors, so it never caught the overclaim (S3 panel finding). Publishing a package that lies about its Node floor would strand exactly the careful user who pins an old minor.

8. **Pack allowlist audited, not glanced at (`npm pack --dry-run`).** Outcome, all verified in the tarball:
   - **Fake-secret fixtures removed.** `SECRET_CORPUS` is a test-only corpus of credential-shaped strings; it was re-exported through the public barrel but no production module uses it. It is dropped from the `security` and `secrets` barrels and its source file is excluded from the published build, so the tarball carries no fake secrets to trip a downstream installer's secret scanner. Tests still import it directly.
   - **Source maps removed.** `sourceMap` and `declarationMap` are off for the build. The maps referenced `src/`, which is not shipped, so they were dead weight pointing at nothing: they were 152 files and roughly a third of the unpacked size. Removing them (and the fixtures) took the tarball from 309 files / 614 KB unpacked to 155 files / 362 KB.
   - **Kept deliberately:** `STARTER_CORPUS` and the red-team `CORPUS`. Unlike the secret fixtures these are production machinery (the shipped `redteam` command runs `CORPUS`), and they are defanged injection payloads (ADR-0018), not secrets. See residual risk below.
   - **Confirmed absent:** `.env`, `.harness`, the repo-root `eval/` and test dirs, `src/`, `process/`, and every `*.test.*`.

9. **External `redteam` is report-only (resolves ADR-0019 §7).** The baseline file is not shipped. An installed `redteam` runs the corpus and prints a scorecard; without an explicit `--baseline <path>` it exits 2 with the context-neutral message already built for the repo/CI contract. Package-relative baseline resolution stays unbuilt (YAGNI).

## Residual risks (accepted, recorded)

- **R-10 widens.** Before publish, oracle code (`eval` golden tasks) executed in-process was an operator-who-cloned-the-repo concern. Publishing does not ship `eval/` golden runners' task discovery beyond what the CLI needs, but the `init` scaffold ships an oracle template the user runs locally, and any consumer authoring golden tasks runs their own in-process code. The security model's R-10 already states oracles are trusted code; publishing broadens the audience for that statement, it does not change the statement. No mitigation beyond the existing R-10 documentation and the `init` README's trust note.
- **Corpus contamination.** Shipping `STARTER_CORPUS`/`CORPUS` makes the red-team payloads publicly importable, so they can be scraped into training data or used to tune around the scanner. This is inherent to any public security corpus; the payloads are defanged, and the regression gate's value is drift-detection against a committed baseline, not payload secrecy. Recorded, not mitigated.
- **Manual approval gate is optional.** The workflow references an `npm-publish` environment; adding required reviewers to it in repo settings turns the release into a two-person action. Left to the operator.

## Alternatives considered

- **Local `npm publish` with a granular automation token.** Rejected: a long-lived token is a standing secret, and it cannot produce real provenance. OIDC removes both problems.
- **Publish on tag push rather than release.** Rejected: a GitHub Release is a more deliberate human gate than a tag, and it pairs naturally with release notes.
- **Ship the baseline for a fully-gating external `redteam`.** Deferred (ADR-0019 §7): needs package-relative resolution that no external consumer has asked for.
- **Keep source maps, exclude via `.npmignore`.** Rejected as fragile: `files` + `.npmignore` interaction is version-dependent, and for an irreversible publish the deterministic choice (don't emit the maps) wins.

## Revisit if

- **R1:** the first release completes: verify the provenance badge renders on npm and that `npx agent-harness-ja init` works from a clean machine.
- **R2:** an external consumer needs a gating `redteam`: build package-relative baseline resolution and ship the baseline.
- **R3:** a second SDK or provider lands: the `0.1.0` "Claude-only" honesty in the README and description must move in lockstep with the version.
