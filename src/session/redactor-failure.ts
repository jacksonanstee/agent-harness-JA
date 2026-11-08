/**
 * What a warning may say about a redactor, or an injection scanner, that threw
 * (issues #113 and #234: both take secret-bearing input). The
 * redactor's input is secret-bearing by construction, so its error message can
 * carry the secret (a redactor throwing `new Error('bad input: ' + text)` put
 * it on stderr). So can a custom error's `name`, and a thrown non-Error. Only a
 * standard error class, matched by its prototype, is named, by a name written
 * here (never read from the constructor, whose `name` can be redefined);
 * everything else reads the same fixed phrase. The message is never shown.
 *
 * It never throws: it runs inside catch blocks, so a throw here would escape
 * them (a revoked Proxy makes `Object.getPrototypeOf` throw).
 */
const STANDARD_ERRORS: readonly (readonly [object, string])[] = [
  [Error.prototype, 'Error'],
  [TypeError.prototype, 'TypeError'],
  [RangeError.prototype, 'RangeError'],
  [SyntaxError.prototype, 'SyntaxError'],
  [ReferenceError.prototype, 'ReferenceError'],
];

const NON_STANDARD = 'a non-standard error';

function errorKind(error: unknown): string {
  try {
    if (typeof error !== 'object' || error === null) return NON_STANDARD;
    const prototype: unknown = Object.getPrototypeOf(error);
    return STANDARD_ERRORS.find(([candidate]) => candidate === prototype)?.[1] ?? NON_STANDARD;
  } catch {
    return NON_STANDARD;
  }
}

const withheld = (component: string, error: unknown, issue: string): string =>
  `the ${component} threw ${errorKind(error)}; its message is withheld because it can carry the input (${issue})`;

export function redactorFailure(error: unknown): string {
  return withheld('redactor', error, '#113');
}

/** The injection scanner's input is the raw tool output (#234). */
export function scannerFailure(error: unknown): string {
  return withheld('scanner', error, '#234');
}
