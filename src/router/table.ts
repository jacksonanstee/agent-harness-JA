import type { RoutingRule } from './types.js';

// Frozen at runtime (issue #123): the array AND each rule, because freezing the
// array alone leaves `DEFAULT_ROUTING_TABLE[0].model = ...` live. Rules are
// frozen at the definition site via `rule()`.
const rule = (r: RoutingRule): Readonly<RoutingRule> => Object.freeze(r);

export const DEFAULT_ROUTING_TABLE: readonly RoutingRule[] = Object.freeze([
  rule({
    id: 'sensitivity-high',
    match: (d) => d.sensitivity === 'high',
    model: 'claude-opus-5',
    reason: 'sensitivity=high → opus',
  }),
  rule({
    id: 'shape-lookup',
    match: (d) => d.shape === 'lookup',
    model: 'claude-haiku-4-5',
    reason: 'shape=lookup → haiku',
  }),
  rule({
    id: 'shape-research',
    match: (d) => d.shape === 'research',
    model: 'claude-opus-5',
    reason: 'shape=research → opus',
  }),
  rule({
    id: 'shape-review-small',
    match: (d) => d.shape === 'review' && d.expected_tokens < 20_000,
    model: 'claude-sonnet-5',
    reason: 'shape=review + tokens<20k → sonnet',
  }),
  rule({
    id: 'shape-build-small',
    match: (d) => d.shape === 'build' && d.expected_tokens < 50_000,
    model: 'claude-sonnet-5',
    reason: 'shape=build + tokens<50k → sonnet',
  }),
]);

/** Implicit last rule. Catches large-context or unclassified work and escalates to opus. */
export const FALLTHROUGH_RULE_ID = 'fallthrough' as const;
export const FALLTHROUGH_MODEL = 'claude-opus-5' as const;
export const FALLTHROUGH_REASON =
  'fallthrough → opus (large context or unclassified)';
