import {
  DEFAULT_ROUTING_TABLE,
  FALLTHROUGH_MODEL,
  FALLTHROUGH_REASON,
  FALLTHROUGH_RULE_ID,
} from './table.js';
import {
  TASK_SENSITIVITIES,
  TASK_SHAPES,
  type ModelChoice,
  type RoutingRule,
  type TaskDescriptor,
} from './types.js';
import { sanitizeControlChars as sanitizeReason } from '../internal/sanitize.js';

export interface RouterOptions {
  table?: readonly RoutingRule[];
}

export interface Router {
  route(descriptor: TaskDescriptor): ModelChoice;
}

export function createRouter(opts: RouterOptions = {}): Router {
  const table = opts.table ?? DEFAULT_ROUTING_TABLE;
  return {
    route(descriptor: TaskDescriptor): ModelChoice {
      assertValid(descriptor);
      for (const rule of table) {
        if (safeMatch(rule, descriptor)) {
          return {
            model: rule.model,
            rule_id: rule.id,
            reason: sanitizeReason(rule.reason),
          };
        }
      }
      return {
        model: FALLTHROUGH_MODEL,
        rule_id: FALLTHROUGH_RULE_ID,
        reason: sanitizeReason(FALLTHROUGH_REASON),
      };
    },
  };
}

const defaultRouter: Router = createRouter();

export function route(descriptor: TaskDescriptor): ModelChoice {
  return defaultRouter.route(descriptor);
}

function assertValid(d: TaskDescriptor): void {
  if (!TASK_SHAPES.includes(d.shape)) {
    throw new TypeError(
      `TaskDescriptor.shape must be one of ${TASK_SHAPES.join('|')}, got ${String(d.shape)}`,
    );
  }
  if (!TASK_SENSITIVITIES.includes(d.sensitivity)) {
    throw new TypeError(
      `TaskDescriptor.sensitivity must be one of ${TASK_SENSITIVITIES.join('|')}, got ${String(d.sensitivity)}`,
    );
  }
  if (!Number.isFinite(d.expected_tokens) || d.expected_tokens < 0) {
    throw new TypeError(
      `TaskDescriptor.expected_tokens must be a non-negative finite number, got ${String(d.expected_tokens)}`,
    );
  }
}

function safeMatch(rule: RoutingRule, d: TaskDescriptor): boolean {
  try {
    return rule.match(d) === true;
  } catch {
    return false;
  }
}

