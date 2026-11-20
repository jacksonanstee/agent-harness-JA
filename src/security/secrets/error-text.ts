import { stripInvisibles, TERMINAL_UNSAFE } from '../../internal/sanitize.js';
import { continuePrivateKey, OPEN_PRIVATE_KEY, PRIVATE_KEY_HEADER_SOURCE } from './pem-continuation.js';
import type { RedactResult } from './types.js';

/**
 * Redaction for the text of an error that may carry the tail of the bundled
 * CLI's stderr (issue #251; security review and owner ruling of 20/11/2026).
 *
 * That tail is whatever the CLI wrote, cut to its last bytes, and two things
 * about it defeat a redactor that is simply handed the text. OBSERVED by the
 * security review (`tasks/issue-251-evidence/review2/sec`, runs `zwsp` and
 * `headcut`, and `t-redact.out`):
 * - a secret with an invisible character inside it (a zero-width space, a
 *   soft hyphen) is not one unbroken run, so no rule matches it, and the
 *   sanitiser that ran AFTER the redactor then removed the character and
 *   left the secret whole. So everything a terminal would not show is taken
 *   out FIRST: default-ignorable characters (bidi marks among them), ANSI escape
 *   sequences and control characters other than tab and line feed. They are
 *   deleted, not replaced by a space, which would still split the secret.
 * - a private key whose BEGIN line fell outside the kept tail has nothing
 *   for the private-key rule to anchor on. So when a private key's END line
 *   is left after the redactor has run, the text before it is read as the rest of an open
 *   key (`continuePrivateKey`).
 * A secret cut by the tail's own boundary is the tail's to deal with:
 * `stderrTailOf` drops the partial first line.
 *
 * Throws whatever the redactor throws; each caller has its own fail-closed
 * sentinel for that.
 */

// CSI sequences (ESC [ parameters intermediates final): colours and cursor moves. Any other ESC goes with the control
// characters, alone: taking the character after it too would eat a letter of a secret that an ESC had been put inside.
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// The END line of a PRIVATE key, in the forms the BEGIN header has. The end of a certificate or a public key is not
// one: reading the text before it as key body would redact what is not secret.
const PRIVATE_KEY_END = new RegExp(PRIVATE_KEY_HEADER_SOURCE.replace('-----BEGIN ', '-----END '));

/** The text as a terminal would show it, with nothing invisible left inside a word. */
export function joinForRedaction(text: string): string {
  return stripInvisibles(text).replace(ANSI_SEQUENCE, '').replace(new RegExp(TERMINAL_UNSAFE.source, 'g'), '');
}

/** `redactSecrets` over the joined text, then a private key that lost its BEGIN line. The findings are the redactor's own. */
export function redactErrorText(text: string, redactSecrets: (text: string) => RedactResult): RedactResult {
  const result = redactSecrets(joinForRedaction(text));
  if (typeof result.redacted !== 'string' || !PRIVATE_KEY_END.test(result.redacted)) return result;
  return { ...result, redacted: continuePrivateKey(OPEN_PRIVATE_KEY, result.redacted).text };
}
