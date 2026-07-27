# ADR-0022: npm publish via OIDC trusted publishing, with provenance and a pack allowlist

- **Status:** Accepted
- **Date:** 2026-07-14
- **Requirements:** Week-4 S4 (the last item; irreversible, hard-gated)
- **Relates to:** ADR-0018 (defang convention for the red-team payloads that now ship publicly), ADR-0019 §7 (resolves its recorded publish decision point: report-only for external `redteam`), ADR-0021 (the `init` command that becomes the primary no-clone entry point once published), security-model R-10 (publishing widens who can invoke oracle code)

## Context

Publishing to npm is a one-way door: a version number cannot be reused, the package name is claimed, and unpublish is only allowed within 72 hours and never re-usable. It is also the step tied most directly to the job search, so the failure mode is not a broken build but a permanently public mistake: a half-built tarball, a leaked fixture, an un-audited README, or a version that advertises unbuilt features. The plan sequenced this last, after the docs and blog, for exactly that reason.

The decision here is not "should we publish" but "publish in a way where the irreversible action is the last, smallest, most-verified step, and where the supply-chain provenance is real rather than asserted."

## Decisions

1. **Publish from CI via OIDC trusted publishing, not a local `npm publish`.** The publish runs in `.github/workflows/publish.yml`, triggered by publishing a GitHub Release. No long-lived npm token exists anywhere: the workflow exchanges a short-lived GitHub OIDC token for a scoped publish token at run time. `permissions` is `contents: read` + `id-token: write` and nothing more (since the 2026-07-24 amendment below, `id-token: write` is confined to a dedicated publish job). The runner's bundled npm is upgraded to a pinned version (currently 11.11.0) first, because trusted publishing needs npm >= 11.5.1; the pin gets the same discipline as the SHA-pinned actions, since it is a network pull inside the job holding the publish capability.
   - **One-time manual precondition (operator):** link the trusted publisher on npm (package settings -> Trusted Publisher -> GitHub Actions -> this repo + `publish.yml`). Until that link exists the workflow's publish step fails closed, which is the desired direction.

2. **Build provenance is emitted (`npm publish --provenance`).** The public repo plus OIDC context lets npm attach a verifiable provenance attestation tying the tarball to the exact commit and workflow that built it. The currency review flagged 2026 supply-chain attacks (Phantom-Gyp, Miasma-style forged provenance) as real; provenance is the direct countermeasure, and it is why publishing from a token-in-CI setup was rejected in favour of OIDC.

3. **Actions are pinned by full commit SHA.** `actions/checkout` and `actions/setup-node` are pinned to immutable SHAs (with the version in a trailing comment), so a moved tag cannot swap the action out from under a publish. This is the workflow-hardening half the currency review required.

4. **The workflow re-runs every gate, and a version guard fails loud.** Lint, typecheck, build, test, and the keyless `redteam` gate run as visible steps. This is a superset of `prepublishOnly`, which runs build, test and redteam but not lint or typecheck; the workflow is the stricter of the two, and the direction of that mismatch is the safe one. A dedicated step asserts `package.json` version equals the release tag (`vX.Y.Z`), so a forgotten bump fails before publish rather than shipping a mislabelled tarball.

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
- **Manual approval gate is optional, and inert until configured.** The workflow references an `npm-publish` environment, but GitHub auto-creates a referenced environment with no protection rules, so until required reviewers are added in repo settings the gate exists in name only. This matters more than it looks: with trusted publishing there is no npm credential to steal, so "can cut a release on this repo" *is* the entire publish authority, and the environment reviewer is the only independent check on it. An attacker who compromises the maintainer's GitHub session, or a future collaborator with write access, can ship a provenance-bearing release with no second control. Recommended operator setup before the first publish: create the environment with a required reviewer, and set the same environment name in npm's Trusted Publisher configuration so the registry enforces the environment claim in the OIDC token rather than trusting the workflow's side alone.
- **A local `npm publish` bypasses provenance and the version guard.** `prepublishOnly` re-runs build/test/redteam even locally, but the version-equals-tag check and the OIDC provenance attestation live only in the workflow. A logged-in maintainer who runs `npm publish` by hand ships a package with no provenance and no tag check. OIDC removes the standing token, not a human with an active npm session; the mitigation is discipline (publish only via a release) plus the pre-release skip below, not a hard block.
- **Pre-releases are skipped, not tagged.** `npm publish` carries no `--tag`, so a GitHub pre-release would land on npm's `latest`. The workflow guards this with `if: ${{ !github.event.release.prerelease }}`; shipping a real `next`/`beta` channel would need explicit `--tag` handling (deferred, YAGNI).

## Alternatives considered

- **Local `npm publish` with a granular automation token.** Rejected: a long-lived token is a standing secret, and it cannot produce real provenance. OIDC removes both problems.
- **Publish on tag push rather than release.** Rejected: a GitHub Release is a more deliberate human gate than a tag, and it pairs naturally with release notes.
- **Ship the baseline for a fully-gating external `redteam`.** Deferred (ADR-0019 §7): needs package-relative resolution that no external consumer has asked for.
- **Keep source maps, exclude via `.npmignore`.** Rejected as fragile: `files` + `.npmignore` interaction is version-dependent, and for an irreversible publish the deterministic choice (don't emit the maps) wins.

## Amendment (2026-07-24): id-token confined to a dedicated publish job (audit V20)

The original workflow held `id-token: write` at the workflow level, which meant GitHub injected OIDC-minting credentials (`ACTIONS_ID_TOKEN_REQUEST_TOKEN`/`_URL`) into every step of the single job, including `npm ci`, build, and test. Any compromised dependency executing during those steps could have minted an OIDC token and exchanged it for a trusted-publish token before the legitimate publish step ran. That undercut the point of decision 1: the standing-secret problem was solved, but the capability was still ambient across untrusted code execution.

The workflow is now two jobs:

- **`build`** (`contents: read` only): checkout, `npm ci`, lint, typecheck, build, test, red-team gate, version-tag guard, then uploads `dist/` as a short-lived artifact. All third-party code execution happens here, token-free.
- **`publish`** (`contents: read` + `id-token: write`, gated by the `npm-publish` environment): checks out this repo's own release commit, installs pinned npm, downloads the `dist/` artifact, loud-fail-verifies the artifact landed (a missing `dist/` would otherwise pack a broken tarball, because the `files` allowlist skips absent entries silently), and runs `npm publish --provenance --access public --ignore-scripts`. `--ignore-scripts` keeps `prepublishOnly` (whose gates the build job already ran as visible steps) from pulling devDependency execution back into token scope. No `npm ci` ever runs in this job.

Directory publish was kept (rather than packing in the build job and publishing the tarball) because npm's provenance generation is documented and widely exercised for directory publishes; publishing a pre-built tarball with `--provenance` is not a clearly documented path, and the publish flow is the wrong place to pioneer one.

That choice has a cost worth naming. With a directory publish the *pack* happens at publish time, inside the token-holding job, assembled from two sources: the git checkout supplies `package.json`, README and LICENCE, while the artifact supplies `dist/`. So the bytes that ship are not byte-verified against anything the build job gated; only the two entry points are checked (`test -s`). Packing in the build job and publishing that exact tarball would have made the gated artefact and the shipped artefact identical by construction. The realistic divergence window is small (both jobs check out the same immutable commit SHA, and `dist/` travels intact through a same-run, immutable artifact), which is why the trade was taken, but it is a real difference and not merely a stylistic one.

Two further residuals of the split:

- **The npm self-upgrade is version-pinned, not integrity-pinned.** `npm install -g npm@11.11.0` is the one network pull inside token scope. The pinned version declares no install lifecycle scripts, but that is not the protection it appears to be: the next steps execute the installed binary, so a substituted tarball is code execution in token scope regardless. npm's integrity check is against the registry-supplied packument, which is self-referential, so the residual attacker is one who controls the registry response (registry compromise or CA-level interception). That attacker class can do worse ecosystem-wide; the marginal gain here is a *valid-provenance* poisoned release, which is exactly what provenance consumers trust.
- **The gate sequence is duplicated, not shared.** `ci.yml`, the publish `build` job, and `prepublishOnly` each define their own version of "the gates", and they are not identical (CI runs a Node 20 and 22 matrix plus a docs-links job; the publish build job runs Node 22 only). The publish path is therefore not a strict superset of CI. In practice the release commit sits on `main`, where full CI already ran, but nothing in the workflow asserts "CI was green on this SHA": the invariant is held by convention. Extracting a reusable `workflow_call` gate is the fix if this drifts again; until then the rule is that a gate added to `ci.yml` is added to the publish `build` job in the same PR.

## Revisit if

- **R1:** the first release completes: verify the provenance badge renders on npm and that `npx agent-harness-ja init` works from a clean machine.
- **R2:** an external consumer needs a gating `redteam`: build package-relative baseline resolution and ship the baseline.
- **R3:** a second SDK or provider lands: the `0.1.0` "Claude-only" honesty in the README and description must move in lockstep with the version.
- **R4:** npm documents provenance for tarball specs: switch to packing in the `build` job and publishing that byte-identical tarball, which closes the publish-time-pack residual named in the 2026-07-24 amendment.
- **R5:** the pinned `npm@11.11.0` ages out (a security release lands, or npm's trusted-publishing floor moves above it): bump the pin deliberately. Dependabot updates SHA-pinned actions but will not touch a version in a `run:` line, so nothing fires automatically. If a future `setup-node` image bundles npm >= 11.5.1, dropping the upgrade step removes the network pull from token scope entirely, which is the better fix.
- **R6:** a gate is added to `ci.yml` without being added to the publish `build` job, or a second package or build matrix lands: extract the gate sequence into a reusable `workflow_call` workflow so there is one definition rather than three.
