import { describe, expect, it } from 'vitest';

import { PRICE_TABLE } from '../internal/pricing.js';
import { DEFAULT_ROUTING_TABLE, FALLTHROUGH_MODEL } from '../router/table.js';
import { MODELS, type Model } from '../router/types.js';
import { JUDGE_MODEL } from '../session/index.js';

// Lives in cli (the composition layer) because internal may import no domain:
// the price table keys on plain strings, so this test ties it to the router's
// closed model list (#192). MODELS is checked against the hand-written `Model`
// union by a `satisfies` presence record in router/types.ts, so adding a model
// to the union without a price row fails here.
// Compile-time half: the judge and fallthrough models must be union members.
const knownModels: readonly Model[] = [JUDGE_MODEL, FALLTHROUGH_MODEL, ...DEFAULT_ROUTING_TABLE.map((r) => r.model)];

describe('PRICE_TABLE coverage', () => {
  it('has a row for every model in MODELS', () => {
    expect(MODELS.length).toBeGreaterThan(0);
    for (const id of MODELS) expect(PRICE_TABLE.map((r) => r.model), id).toContain(id);
  });

  it('has no row for a model outside MODELS, and no duplicate rows', () => {
    const named = new Set<string>(MODELS);
    for (const r of PRICE_TABLE) expect(named.has(r.model), r.model).toBe(true);
    expect(new Set(PRICE_TABLE.map((r) => r.model)).size).toBe(PRICE_TABLE.length);
  });

  it('every model the router table, fallthrough and judge name is in MODELS', () => {
    for (const id of knownModels) expect(MODELS as readonly string[], id).toContain(id);
  });
});
