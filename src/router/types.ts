export type TaskShape = 'review' | 'build' | 'research' | 'lookup';

export type TaskSensitivity = 'low' | 'medium' | 'high';

export type Model =
  | 'claude-haiku-4-5'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-7';

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
