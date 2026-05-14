# ADR-0002: MIT license

- **Date:** 2026-05-13
- **Status:** Accepted
- **Deciders:** Jackson Anstee
- **Related requirements:** N-5

## Context

The repo needs a license. The realistic options for an MIT-style permissive grant are:

1. **MIT** — short, well-understood, no patent grant.
2. **Apache-2.0** — explicit patent grant, NOTICE file requirement, longer text.
3. **BSD-3-Clause** — similar to MIT with a non-endorsement clause.
4. **Unlicense / 0BSD** — public-domain-equivalent.

The project's goals are:

- Maximise the chance that a curious developer or hiring manager clones the repo with zero friction.
- Allow inclusion in commercial products without legal review overhead.
- Avoid copyleft obligations that would discourage adoption.

The project is **not**:

- Built on patents the author owns.
- Receiving corporate contributions where a patent grant would matter.
- Concerned with non-endorsement (the author is comfortable with the project being used as the basis for derivative work).

## Decision

License the repo under **MIT**.

The `LICENSE` file will contain the standard MIT text with copyright held by Jackson Anstee.

## Consequences

### Positive
- Zero adoption friction. Any developer or company can use the code without legal sign-off.
- Maximises the portfolio-piece value: a hiring manager evaluating the repo cannot be blocked by license concerns.
- Standard and recognisable; no explanation required.

### Negative
- No explicit patent grant. If the project ever incorporates patented techniques, contributors and users have no defence against patent claims by the author or third parties. This is a theoretical risk for a solo portfolio project.
- No requirement for derivative works to credit the original. Reputational compounding is weaker than under attribution-required licenses.

### Mitigations
- The author owns no relevant patents and does not plan to file any related to this project.
- Reputation will compound through the author's name in the README, ADRs, and devlog — not through license-enforced attribution.

## Alternatives considered

1. **Apache-2.0.** Stronger for projects that expect corporate contributors or that touch patented techniques. Neither applies here. The longer license text and NOTICE-file requirement add friction without payoff at this scale.
2. **BSD-3-Clause.** Functionally similar to MIT for this project. MIT is more familiar to npm-ecosystem readers.
3. **AGPL-3.0 or other copyleft.** Rejected — would discourage exactly the commercial adoption that creates hiring-manager interest. Wrong tool for a portfolio project.
4. **Dual-license (MIT + commercial).** Premature — there is no commercial offering to gate.

## Revisit if

- The project gains a corporate contributor base where a patent grant becomes load-bearing.
- A specific patent risk emerges in the agent-harness space that warrants Apache-2.0's protections.
- The project pivots to a commercial offering with a community edition.
