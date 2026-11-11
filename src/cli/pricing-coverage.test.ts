import { describe, expect, it } from 'vitest';

import { CLI_SIDE_CALL_MODELS, PRICE_TABLE, RETIRED_ROUTER_MODELS } from '../internal/pricing.js';
import { DEFAULT_ROUTING_TABLE, FALLTHROUGH_MODEL } from '../router/table.js';
import { MODELS, type Model } from '../router/types.js';
import { JUDGE_INPUT_USD_PER_MTOK, JUDGE_OUTPUT_USD_PER_MTOK } from '../security/injection/judge-settings.js';
import { JUDGE_MODEL } from '../session/index.js';

// Lives in cli (the composition layer) because internal may import no domain:
// the price table keys on plain strings, so this test ties it to the router's
// closed model list (#192). MODELS is checked against the hand-written `Model`
// union by a `satisfies` presence record in router/types.ts, so adding a model
// to the union without a price row fails here.
// Compile-time half: the fallthrough and table models must be union members.
// The judge is deliberately NOT in this list (#242, ADR-0016 decision 6: the
// judge is never routed, so its id is a plain string outside the union). It
// has its own runtime assertion below: it must be priced.
const knownModels: readonly Model[] = [FALLTHROUGH_MODEL, ...DEFAULT_ROUTING_TABLE.map((r) => r.model)];

const priced = (): string[] => PRICE_TABLE.map((r) => r.model);

describe('PRICE_TABLE coverage', () => {
  it('has a row for every model in MODELS', () => {
    expect(MODELS.length).toBeGreaterThan(0);
    for (const id of MODELS) expect(priced(), id).toContain(id);
  });

  // #242: a row is allowed for a router model, a CLI side-call model, or a
  // retired router model (kept so a live run that still names one, through a
  // cast or an untyped consumer, is priced when it ends).
  // Stored telemetry does not depend on these rows: `telemetry cost` reads
  // the figure already on each row.
  it('has no row for a model outside MODELS, CLI_SIDE_CALL_MODELS or RETIRED_ROUTER_MODELS, and no duplicate rows', () => {
    const named = new Set<string>([...MODELS, ...CLI_SIDE_CALL_MODELS, ...RETIRED_ROUTER_MODELS]);
    for (const r of PRICE_TABLE) expect(named.has(r.model), r.model).toBe(true);
    expect(new Set(priced()).size).toBe(PRICE_TABLE.length);
  });

  // #219: a side-call model is priced but never routed; once the router can choose it, it belongs in MODELS.
  // #242: Haiku 5.5 became a router model, so the list is empty today. The
  // rule stays for the next side-call model the CLI is observed to use.
  it('every CLI_SIDE_CALL_MODELS entry is priced and outside MODELS', () => {
    for (const id of CLI_SIDE_CALL_MODELS) {
      expect(priced(), id).toContain(id);
      expect(MODELS as readonly string[], id).not.toContain(id);
    }
    // Not vacuous while the list is empty: the model that used to be listed is now routed.
    expect(MODELS as readonly string[]).toContain('claude-haiku-5-5');
    expect([...CLI_SIDE_CALL_MODELS]).not.toContain('claude-haiku-5-5');
  });

  it('every RETIRED_ROUTER_MODELS entry is still priced (a live run can still name it)', () => {
    expect(RETIRED_ROUTER_MODELS.length).toBeGreaterThan(0);
    for (const id of RETIRED_ROUTER_MODELS) expect(priced(), id).toContain(id);
  });

  it('MODELS, CLI_SIDE_CALL_MODELS and RETIRED_ROUTER_MODELS are pairwise disjoint, with no duplicates', () => {
    const all = [...MODELS, ...CLI_SIDE_CALL_MODELS, ...RETIRED_ROUTER_MODELS];
    expect(all.length).toBeGreaterThan(MODELS.length);
    expect(new Set(all).size).toBe(all.length);
  });

  it('every model the router table and the fallthrough name is in MODELS', () => {
    expect(knownModels.length).toBeGreaterThan(1);
    for (const id of knownModels) expect(MODELS as readonly string[], id).toContain(id);
  });

  // #242, the reworded S-18 pin's coverage half: the judge is decoupled from
  // the router, so it need not be a union member, but it must have a price
  // row. Deleting the judge's row (or moving the judge to an unpriced id)
  // fails here.
  it('the judge model has a PRICE_TABLE row, whether or not it is a router model', () => {
    expect(priced()).toContain(JUDGE_MODEL);
  });

  // #242 (security review LOW-1): the judge's money ceiling
  // (JUDGE_WORST_CASE_USD_PER_CALL) is derived from two hand-written list
  // prices in security/injection/judge-settings.ts. This ties them to the
  // judge's PRICE_TABLE row, so the pin above is about the judge's PRICES and
  // not only about a row existing: re-pricing the row, or moving JUDGE_MODEL
  // to a differently priced id, fails here until the ceiling is re-derived.
  it("the judge's list-price constants equal its PRICE_TABLE row", () => {
    const row = PRICE_TABLE.find((r) => r.model === JUDGE_MODEL);
    expect(row).toBeDefined();
    expect(row?.longContext).toBeNull();
    expect([JUDGE_INPUT_USD_PER_MTOK, JUDGE_OUTPUT_USD_PER_MTOK]).toEqual([row?.inputUsdPerMTok, row?.outputUsdPerMTok]);
  });
});
