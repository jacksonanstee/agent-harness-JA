import { sanitizeControlChars } from '../internal/sanitize.js';

/**
 * Renders a thrown value or a Result error for a warning or a retained row.
 * Never throws and always returns a string: `message` may be a getter that
 * throws or returns a non-string (found by execution, issue #75), and
 * `sanitizeControlChars` is an untyped replace that would pass a non-string
 * through. Every injected dependency is an arbitrary implementation at the
 * same trust boundary as a hook, so every catch that renders one goes through
 * here. Non-object throws render as 'unknown', the behaviour these sites had.
 *
 * One definition for the session layer (Task 8 review, Important 2): session.ts
 * and the judge path's live lines both import it, with no cycle.
 */
export function describeError(error: unknown): string {
  try {
    if (typeof error !== 'object' || error === null || !('message' in error)) return 'unknown';
    const rendered: unknown = (error as { message: unknown }).message;
    return typeof rendered === 'string' ? sanitizeControlChars(rendered) : 'unrepresentable error';
  } catch {
    return 'unrepresentable error';
  }
}
