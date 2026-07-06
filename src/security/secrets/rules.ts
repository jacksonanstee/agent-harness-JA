import type { SecretRule } from './types.js';

/**
 * Secret-detection rules derived from the gitleaks and trufflehog rule sets.
 * Every pattern MUST stay linear-time: single-level bounded quantifiers, no
 * backreferences, no lookbehind — enforced by the ReDoS guard in
 * rules.test.ts. `high`-precision rules are structural (fixed prefix + fixed
 * charset/length) and fire on the pattern alone; `heuristic` rules also
 * require the entropy gate because the shape over-matches.
 *
 * Deliberately NOT included: gitleaks' unanchored `generic-api-key` (a bare
 * long-token match). Its false-positive rate on code-heavy tool output is
 * unacceptable; the keyword-anchored `generic-keyword-secret` below covers the
 * realistic case (ADR-0013).
 */
export const DEFAULT_SECRET_RULES = [
  {
    id: 'aws-access-key-id',
    precision: 'high',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
    description: 'AWS access key id',
  },
  {
    id: 'aws-secret-access-key',
    precision: 'heuristic',
    entropy: 3.5,
    pattern:
      /aws_?secret_?(?:access_?)?key['"]?\s{0,3}[:=]\s{0,3}['"]?([A-Za-z0-9/+=]{40})/i,
    description: 'AWS secret access key (keyword-anchored, entropy-gated)',
  },
  {
    id: 'github-pat',
    precision: 'high',
    pattern: /\bghp_[A-Za-z0-9]{36}\b/,
    description: 'GitHub personal access token',
  },
  {
    id: 'github-fine-grained-pat',
    precision: 'high',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
    description: 'GitHub fine-grained PAT',
  },
  {
    id: 'github-oauth',
    precision: 'high',
    pattern: /\bgho_[A-Za-z0-9]{36}\b/,
    description: 'GitHub OAuth access token',
  },
  {
    id: 'github-app-token',
    precision: 'high',
    pattern: /\bgh[us]_[A-Za-z0-9]{36}\b/,
    description: 'GitHub app / server-to-server token',
  },
  {
    id: 'gitlab-pat',
    precision: 'high',
    pattern: /\bglpat-[A-Za-z0-9_-]{20}\b/,
    description: 'GitLab personal access token',
  },
  {
    id: 'slack-token',
    precision: 'high',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,72}\b/,
    description: 'Slack token',
  },
  {
    id: 'slack-webhook',
    precision: 'high',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]{8,12}\/B[A-Za-z0-9_]{8,12}\/[A-Za-z0-9_]{24}/,
    description: 'Slack incoming webhook',
  },
  {
    id: 'stripe-secret-key',
    precision: 'high',
    pattern: /\b[sr]k_live_[A-Za-z0-9]{20,247}\b/,
    description: 'Stripe live secret / restricted key',
  },
  {
    id: 'stripe-test-key',
    precision: 'high',
    pattern: /\b[sr]k_test_[A-Za-z0-9]{20,247}\b/,
    description: 'Stripe test key',
  },
  {
    id: 'google-api-key',
    precision: 'high',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    description: 'Google API key',
  },
  {
    id: 'gcp-service-account',
    precision: 'high',
    pattern: /"private_key_id"\s{0,3}:\s{0,3}"[a-f0-9]{40}"/,
    description: 'GCP service-account private_key_id',
  },
  {
    id: 'openai-api-key',
    precision: 'high',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,160}T3BlbkFJ[A-Za-z0-9_-]{20,160}\b/,
    description: 'OpenAI project/user API key',
  },
  {
    id: 'openai-legacy-key',
    precision: 'high',
    pattern: /\bsk-[A-Za-z0-9]{48}\b/,
    description: 'OpenAI legacy API key',
  },
  {
    id: 'anthropic-api-key',
    precision: 'high',
    pattern: /\bsk-ant-(?:api|admin)[A-Za-z0-9]{2,6}-[A-Za-z0-9_-]{80,120}\b/,
    description: 'Anthropic API key',
  },
  {
    id: 'npm-access-token',
    precision: 'high',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
    description: 'npm access token',
  },
  {
    id: 'pypi-upload-token',
    precision: 'high',
    pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,1000}\b/,
    description: 'PyPI upload token',
  },
  {
    id: 'sendgrid-api-key',
    precision: 'high',
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
    description: 'SendGrid API key',
  },
  {
    id: 'twilio-api-key',
    precision: 'heuristic',
    entropy: 3.0,
    pattern: /\bSK[0-9a-fA-F]{32}\b/,
    description: 'Twilio API key (SK + 32 hex; entropy-gated)',
  },
  {
    id: 'mailgun-api-key',
    precision: 'high',
    pattern: /\bkey-[a-f0-9]{32}\b/,
    description: 'Mailgun API key',
  },
  {
    id: 'jwt',
    precision: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,2000}\b/,
    description: 'JSON Web Token',
  },
  {
    id: 'private-key-block',
    precision: 'high',
    // One rule for terminated AND unterminated/oversized blocks: a bounded
    // lazy body runs to the END fence OR to end-of-input. Splitting this into
    // a separate BEGIN-only "fence" rule leaked the key body when the body
    // exceeded the lazy cap (only the header matched) — see ADR-0013. The
    // {0,16384} bound (16 KiB ≫ any real PEM key: RSA-8192 ≈ 6.4 KiB) keeps
    // per-match work small; redact()'s MAX_INPUT cap bounds the many-header
    // worst case (differential-review DoS finding).
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,16384}?(?:-----END [A-Z ]{0,40}-----|$)/,
    description: 'PEM private-key block (terminated, unterminated, or oversized)',
  },
  {
    id: 'basic-auth-in-url',
    precision: 'high',
    pattern: /[a-zA-Z][a-zA-Z0-9+.-]{1,20}:\/\/[^/\s:@]{1,64}:[^/\s@]{1,64}@[^\s]{1,256}/,
    description: 'credentials embedded in a URL (user:pass@host)',
  },
  {
    id: 'generic-keyword-secret',
    precision: 'heuristic',
    entropy: 3.5,
    pattern:
      /(?:api_?key|secret|token|password|passwd|pwd)['"]?\s{0,3}[:=]\s{0,3}['"]([A-Za-z0-9/+_=-]{16,64})['"]/i,
    description: 'keyword-anchored secret assignment (entropy-gated)',
  },
] as const satisfies readonly SecretRule[];
