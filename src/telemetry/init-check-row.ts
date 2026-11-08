import { sanitizeControlChars, stripBidi } from '../internal/sanitize.js';
import { INIT_CHECK_ROW_LIST_MAX, INIT_CHECK_ROW_NAME_MAX, type InitCheckPayload, type InitCheckRowState } from './types.js';

// Issue #232 (ADR-0046 D4): the init-check row's validator and sanitiser, kept
// out of store.ts (already past the 800-line ceiling) and wired in there.

// Presence record (the EVENT_TYPE_PRESENCE idiom): a state added to the mirror
// without its key here is a compile error.
const STATE_PRESENCE: Record<InitCheckRowState, true> = { 'not-run': true, clean: true, found: true };
export const INIT_CHECK_ROW_STATES = Object.keys(STATE_PRESENCE) as readonly InitCheckRowState[];
const STATE_SET: ReadonlySet<string> = new Set(INIT_CHECK_ROW_STATES);

/** The closed key set, checked first: no text can ride on the row under another key. */
const KEYS: ReadonlySet<string> = new Set(['state', 'unruledTools', 'unknownAgents', 'unruledToolCount', 'unknownAgentCount']);

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * An array of strings, each at most INIT_CHECK_ROW_NAME_MAX UTF-16 units,
 * whose length is exactly min(count, INIT_CHECK_ROW_LIST_MAX): the check keeps
 * the first names up to the cap and counts every distinct one. A hole in a
 * sparse array reads as undefined, so the string check refuses it too.
 */
function isCappedList(list: unknown, count: number): list is string[] {
  if (!Array.isArray(list) || list.length !== Math.min(count, INIT_CHECK_ROW_LIST_MAX)) return false;
  for (let i = 0; i < list.length; i += 1) {
    const name: unknown = list[i];
    if (typeof name !== 'string' || name.length > INIT_CHECK_ROW_NAME_MAX) return false;
  }
  return true;
}

/** `found` exactly when a count is above zero; `clean` and `not-run` carry nothing. */
const stateAgrees = (state: string, unruledToolCount: number, unknownAgentCount: number): boolean =>
  (state === 'found') === (unruledToolCount + unknownAgentCount > 0);

export function isInitCheckPayload(value: unknown): value is InitCheckPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !KEYS.has(key))) return false;
  const { state, unruledTools, unknownAgents, unruledToolCount, unknownAgentCount } = row;
  return (
    typeof state === 'string' &&
    STATE_SET.has(state) &&
    isCount(unruledToolCount) &&
    isCount(unknownAgentCount) &&
    isCappedList(unruledTools, unruledToolCount) &&
    isCappedList(unknownAgents, unknownAgentCount) &&
    stateAgrees(state, unruledToolCount, unknownAgentCount)
  );
}

/** Both are 1:1 substitutions, so the length caps validated above still hold. */
const cleanName = (name: string): string => sanitizeControlChars(stripBidi(name));

/** A new payload with every name cleaned again, since the store is a public factory a direct writer can reach. */
export function sanitizeInitCheckPayload(payload: InitCheckPayload): InitCheckPayload {
  return {
    ...payload,
    unruledTools: payload.unruledTools.map(cleanName),
    unknownAgents: payload.unknownAgents.map(cleanName),
  };
}
