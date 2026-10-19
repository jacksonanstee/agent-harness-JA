export type TaskShape = 'review' | 'build' | 'research' | 'lookup';

export type TaskSensitivity = 'low' | 'medium' | 'high';

/**
 * Models this harness knows how to name. Closed on purpose (ADR-0007, ADR-0024):
 * a refresh is a compiler-enforced event, not a silent string swap.
 *
 * Membership is not endorsement. `claude-fable-5` is nameable from a custom
 * table but no shipped default rule selects it — see ADR-0024 decision 1 and
 * the guard tests in `route.test.ts`.
 */
export type Model =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-5'
  | 'claude-opus-5'
  | 'claude-fable-5';

// Presence record (the house idiom, see TELEMETRY_EVENT_TYPES): `satisfies
// Record<Model, true>` makes a union member without an entry a compile error,
// and an entry outside the union an excess-property error. MODELS is the
// runtime list the price-table coverage test iterates (#192). It is NOT
// re-exported from the router barrel and `Model` does not reference it, so the
// public surface (ADR-0023) is unchanged.
const MODEL_PRESENCE = Object.freeze({
  'claude-haiku-4-5': true,
  'claude-sonnet-5': true,
  'claude-opus-5': true,
  'claude-fable-5': true,
} satisfies Record<Model, true>);
export const MODELS: readonly Model[] = Object.freeze(Object.keys(MODEL_PRESENCE) as Model[]);

export interface TaskDescriptor {
  shape: TaskShape;
  sensitivity: TaskSensitivity;
  expected_tokens: number;
  hint?: string;
}

export interface ModelChoice {
  model: Model;
  rule_id: string;
  reason: string;
}

export interface RoutingRule {
  id: string;
  match: (d: TaskDescriptor) => boolean;
  model: Model;
  reason: string;
}

// Frozen at runtime as well as typed readonly (issue #123): a push onto either
// array would widen every validator that holds it while a rendered usage line
// went stale. Same house pattern as DEFAULT_DESCRIPTOR.
export const TASK_SHAPES: readonly TaskShape[] = Object.freeze([
  'review',
  'build',
  'research',
  'lookup',
] as const);

export const TASK_SENSITIVITIES: readonly TaskSensitivity[] = Object.freeze([
  'low',
  'medium',
  'high',
] as const);
