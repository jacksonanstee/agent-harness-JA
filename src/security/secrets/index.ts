export { createSecretRedactor, redact } from './redact.js';
export { DEFAULT_SECRET_RULES } from './rules.js';
// SECRET_CORPUS / SecretCase are NOT re-exported: the corpus is a test-only
// fixture of credential-shaped strings, excluded from the published build so
// no fake secrets ship in the tarball (ADR-0022). Tests import it directly
// from ./secret-corpus.js.
export type {
  RedactResult,
  RedactorOptions,
  SecretFinding,
  SecretPrecision,
  SecretRedactor,
  SecretRule,
} from './types.js';
