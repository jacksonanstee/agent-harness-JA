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

export const TASK_SHAPES: readonly TaskShape[] = [
  'review',
  'build',
  'research',
  'lookup',
];

export const TASK_SENSITIVITIES: readonly TaskSensitivity[] = [
  'low',
  'medium',
  'high',
];
