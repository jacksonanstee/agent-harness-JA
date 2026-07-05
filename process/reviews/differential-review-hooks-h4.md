# Differential Security Review — `feat/hooks-h4` vs `main`

- **Range:** `git diff 59946b3..HEAD` (4 commits: `40df64a` ADR-0008, `28fd924` types, `6b21425` runtime, `a98657b` 3-agent hardening)
- **Reviewer:** differential-review (DEEP strategy — SMALL codebase, <20 source files; all deps read, full diff walked)
- **Date:** 2026-07-05
- **Verdict:** 🟢 **APPROVE-WITH-NITS**

---

## Summary

The branch adds `src/hooks/` — a sequential async hook runtime (ADR-0008): `register(event, handler)` + `fire(event, payload)` over four locked events, with `pre-tool` throw = DENY (short-circuit + `denied-by-hook` telemetry), and `post-tool`/`session-start`/`stop` throw = isolated error (recorded, later handlers still run). It depends on nothing and adds zero runtime deps. It sits **before** `permissions.check` in the turn flow, so a missed deny is a security-control bypass — the whole reason this review is DEEP.

I verified the FINAL branch state empirically against the compiled `dist/hooks/runtime.js` (32 hand-written probes + the 86-test suite). **The core deny contract is sound and every documented invariant holds under adversarial input.** The four hardening fixes applied in `a98657b` all do what they claim:

1. `assertPayloadMatchesEvent` — runs after `assertValidEvent`, **before** `Object.freeze` and before any dispatch/side-effect. Rejects a mismatched payload with `TypeError` and emits **no** telemetry (verified: `records=[]`). Cannot be bypassed to reach dispatch. Critically, the deny decision keys on the trusted `event` **parameter** (`event === 'pre-tool'`, line 137), not on the attacker-influenced `payload.event` field — so even a lying `event` getter cannot flip deny semantics (verified a5/b4).
2. `Object.freeze(payload)` — shallow as documented; does not throw on an already-frozen, reused, null-prototype, or getter-bearing payload (verified b1–b4). Nested `args` remain mutable by design, with the SDK re-read obligation (ADR §1) as the real mitigation.
3. `tool: sanitize(...)` in the `denied-by-hook` record — the control-char regex is **byte-for-byte identical** to `src/router/route.ts:78` and `src/skills/load.ts:66` (`/[\x00-\x1F\x7F-\x9F  ]/g`), verified by grep and by an independent canonical-regex parity probe (c8). Strips NUL, ESC/ANSI, newline, DEL, C1, U+2028, U+2029.
4. The swallowing `emit()` wrapper — correctly scoped to the **sink call only**; a throwing sink is swallowed on both the accept and deny paths, all handlers still run, and `fire` still resolves (verified d1–d3). A sink that mutates its own record object cannot corrupt the internal `errors[]`/`FireResult` (verified d4).

Re-entrancy, concurrent-fire snapshot isolation, and first-deny-wins all hold on the built artifact (e1–e3, a4). `npm run build`, `npm run typecheck`, and `npx vitest run` are all green; the claimed **86 tests pass** (32 hooks + 28 router + 26 skills) and hooks coverage is **100% stmt/func/line, 97% branch** (the one uncovered branch is the defensive `if (!current) return` in the unsubscribe closure — benign).

**One genuine issue survives both the per-file passes and the hardening, and was in fact *introduced* by fix #3:** the deny path assumes `payload.tool` is a string, but this boundary deliberately distrusts payload typing (that is the entire premise of `assertPayloadMatchesEvent`). A non-string `tool` on the **deny** path makes `fire` reject with a `TypeError` instead of returning `{ denied: true }` — asymmetric with the accept path, which resolves cleanly for the same malformed payload. It is fail-closed in effect (the tool is never greenlit) and currently latent (no consumer calls `fire` yet), so it does **not** block, but it should be fixed now, before H-1 wires this into the turn flow.

---

## Risk Classification per File

| File | Change | Risk | Notes |
|---|---|---|---|
| `src/hooks/runtime.ts` | **new** + hardening — `register`/`fire`, deny short-circuit, freeze, sanitize, swallow-sink | 🔴 **HIGH** | Sits before `permissions.check`; a missed deny = control bypass |
| `src/hooks/types.ts` | **new** — type-only | 🟢 LOW | No runtime |
| `src/hooks/index.ts` | **new** — barrel | 🟢 LOW | Re-exports public API only |
| `src/index.ts` | +1 line — re-export hooks | 🟡 MEDIUM | Widens public surface (see Blast Radius) |
| `vitest.config.ts` | +1 line — include hooks tests | 🟢 LOW | Test wiring |
| `docs/decisions/0008-*.md` | **new** — ADR | 🟢 LOW | Docs; invariants cross-checked against code |
| `src/hooks/runtime.test.ts` | **new** — 32 tests | 🟢 LOW | Tests |

---

## Findings

### F-1 — LOW — Deny path rejects (instead of returning `denied:true`) when `payload.tool` is not a string
**File:** `src/hooks/runtime.ts:144` — `tool: sanitize((payload as PreToolPayload).tool)`
**Introduced by:** `a98657b` (hardening fix #3 — the new `sanitize(...)` call around `tool`).

`sanitize(text)` calls `text.replace(CONTROL_CHARS, ' ')`. If `payload.tool` is not a string (number, `undefined`, `null`, object, symbol, array), `.replace` throws a `TypeError`. That throw happens during record-argument construction **inside the deny branch of the `catch`, before `emit()` and before the `return { denied: true, ... }`** — so it is not caught by the `emit()` swallow wrapper (which only wraps the sink call, correctly). The result: `fire` **rejects** rather than resolving a deny `FireResult`.

Empirically confirmed against `dist/hooks/runtime.js` for `tool ∈ {123, undefined, null, {}, ['x'], Symbol}`:

```
tool=number(123)      DENY-PATH     -> REJECTED TypeError: text.replace is not a function
tool=number(123)      NON-DENY-PATH -> RESOLVED denied=false
tool=undefined        DENY-PATH     -> REJECTED TypeError: Cannot read properties of undefined (reading 'replace')
tool=undefined        NON-DENY-PATH -> RESOLVED denied=false
```

Two reasons this is a real (if low-severity) defect rather than noise:

1. **Internal inconsistency with the module's own threat premise.** The hardening added `assertPayloadMatchesEvent` precisely *because* TS payload typing is not trusted at the widened-dispatch `fire` boundary. By the same reasoning, `tool: string` is not runtime-guaranteed here — yet the deny path trusts it. Distrusting `event` but trusting `tool` at the same boundary is contradictory.
2. **Accept/deny asymmetry.** The identical malformed payload resolves cleanly on the accept path (tool is never read) but rejects on the deny path. ADR-0008 §4 states `fire` throws **only** for programmer errors (bad event name, non-function handler) and instructs callers to branch on `result.denied` rather than `try/catch`. A caller following the ADR faithfully would get an unhandled rejection specifically when a hook tries to deny a malformed-tool call.

**Exploitability: LOW.** For a real turn, `tool` is the model-requested tool *name*, which the (not-yet-built) H-1 SDK serializes as a string; a non-string requires an SDK construction bug, not direct attacker reach. And the failure mode is fail-closed — `fire` rejecting aborts the turn rather than resolving `denied:false`, so the tool is never greenlit. **Blast radius today is zero:** `grep` confirms the only consumer is the `src/index.ts` barrel re-export; nothing calls `fire()` in a turn flow yet (H-1 unbuilt). This is the ideal moment to fix — before a consumer bakes in the asymmetry.

**Recommended fix (one line, mirrors the existing `reasonOf` which already `String()`-coerces non-Error throws):**
```ts
tool: sanitize(String((payload as PreToolPayload).tool)),
```
Add a regression test with a non-string `tool` on the deny path asserting `result.denied === true`.

---

### N-1 (nit) — INFO — Bare `catch {}` in `emit()` gives no signal when telemetry is fully broken
**File:** `src/hooks/runtime.ts:89–95`

The swallow wrapper is correctly designed and correctly scoped (ADR §7: telemetry must never affect control flow). Accepted as-is. Note only that a *persistently* throwing sink adapter (a real bug in the future telemetry module) is silently invisible — total observability loss with no in-band signal. This is a deliberate tradeoff, not a defect; flagged only so it is a conscious one. No action required for v1.0.

---

## Coverage & Honesty of Claims

| Claim | Verdict | Evidence |
|---|---|---|
| 86 tests pass | ✅ TRUE | `vitest run`: 3 files, 86 tests, 0 fail (32 hooks + 28 router + 26 skills) |
| 3-agent findings fixed in latest commit | ✅ TRUE | `a98657b` diff adds all four fixes; each independently re-verified on `dist` |
| Deny short-circuit / first-deny-wins | ✅ TRUE | Probes a1–a5; sync/async/non-Error/`null`/`undefined`/symbol all deny |
| `tool` sanitize matches router/skills byte-for-byte | ✅ TRUE | grep parity + canonical-regex probe c8 |
| Freeze is shallow, non-throwing on odd payloads | ✅ TRUE | Probes b1–b5 |
| Throwing sink cannot break control flow | ✅ TRUE | Probes d1–d4 |
| Zero runtime deps / depends on nothing | ✅ TRUE | Only import is `./types.js`; regex copied not imported |
| hooks coverage | 100% stmt/func/line, 97% branch | v8 report; sole uncovered branch is benign unsubscribe guard (line 109) |

**Coverage limitation (honest):** H-1 (SDK wiring — the actual `fire()` caller in the turn flow) does not exist yet, so the end-to-end "missed deny → tool runs anyway" path cannot be exercised. This review validates the runtime in isolation; the ADR §1 re-read obligation and F-1's fail-closed assumption both become live only when H-1 lands and must be re-checked there.

---

## Verdict

🟢 **APPROVE-WITH-NITS.** The deny contract is correct and robust; the four hardening fixes hold up under independent adversarial testing; claims are honest. F-1 is a genuine LOW (accept/deny asymmetry on a non-string `tool`, introduced by the sanitize fix) that is fail-closed and currently latent — fix it before H-1 wiring, but it does not block this merge.
