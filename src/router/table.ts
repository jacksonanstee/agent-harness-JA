import type { RoutingRule } from './types.js';

export const DEFAULT_ROUTING_TABLE: readonly RoutingRule[] = [
  {
    id: 'sensitivity-high',
    match: (d) => d.sensitivity === 'high',
    model: 'claude-opus-4-7',
    reason: 'sensitivity=high → opus',
  },
  {
    id: 'shape-lookup',
    match: (d) => d.shape === 'lookup',
    model: 'claude-haiku-4-5',
    reason: 'shape=lookup → haiku',
  },
  {
    id: 'shape-research',
    match: (d) => d.shape === 'research',
    model: 'claude-opus-4-7',
    reason: 'shape=research → opus',
  },
  {
    id: 'shape-review-small',
    match: (d) => d.shape === 'review' && d.expected_tokens < 20_000,
    model: 'claude-sonnet-4-6',
    reason: 'shape=review + tokens<20k → sonnet',
  },
  {
    id: 'shape-build-small',
    match: (d) => d.shape === 'build' && d.expected_tokens < 50_000,
    model: 'claude-sonnet-4-6',
    reason: 'shape=build + tokens<50k → sonnet',
  },
];

/** Implicit last rule. Catches large-context or unclassified work and escalates to opus. */
export const FALLTHROUGH_RULE_ID = 'fallthrough' as const;
export const FALLTHROUGH_MODEL = 'claude-opus-4-7' as const;
export const FALLTHROUGH_REASON =
  'fallthrough → opus (large context or unclassified)';
