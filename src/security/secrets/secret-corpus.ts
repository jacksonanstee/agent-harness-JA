/**
 * Fake-secret fixtures (never real credentials) in realistic surroundings, plus
 * benign false-positive guards. Shaped for adoption by the Week-3 eval corpus
 * (`src/eval/corpus/`), mirroring the injection `STARTER_CORPUS`.
 */
export interface SecretCase {
  id: string;
  /** The rule id expected to fire, or 'benign' for a false-positive guard. */
  expect: string;
  text: string;
}

export const SECRET_CORPUS = [
  // --- malicious: secrets in realistic contexts ---
  { id: 's-01', expect: 'aws-access-key-id', text: 'export AWS_ACCESS_KEY_ID=AKIA' + 'IOSFODNN7EXAMPLE' },
  {
    id: 's-02',
    expect: 'aws-secret-access-key',
    text: 'aws_sec' + 'ret_access_key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYabcd"',
  },
  { id: 's-03', expect: 'github-pat', text: 'GITHUB_TOKEN=ghp_' + 'a1B2c3D4e5f6G7h8i9J0k1L2m3N4o5P6q7R8' },
  {
    id: 's-04',
    expect: 'github-fine-grained-pat',
    text: `to${''}ken: github${'_pat_'}${'A1b2C3d4E5'.repeat(8)}A1`,
  },
  { id: 's-05', expect: 'gitlab-pat', text: 'CI_JOB_TOKEN=glpat-' + 'ABCDEF1234567890abcd' },
  { id: 's-06', expect: 'slack-token', text: '{"slack":"xoxb-' + '1234567890-abcdefghijklmnop"}' },
  {
    id: 's-07',
    expect: 'slack-webhook',
    text: 'url=https://hooks.sla' + 'ck.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
  },
  { id: 's-08', expect: 'stripe-secret-key', text: 'STRIPE_KEY=sk_live_' + '1234567890abcdefghijklmn' },
  { id: 's-09', expect: 'google-api-key', text: 'key=AIza' + 'SyA1234567890abcdefghijklmnopqrstuv' },
  {
    id: 's-10',
    expect: 'gcp-service-account',
    text: '{"type":"service_account","private_key_id": "0123456789abcdef0123456789abcdef01234567"}',
  },
  {
    id: 's-11',
    expect: 'openai-api-key',
    text: `OPENAI_API${''}_KEY=sk-proj-${'a'.repeat(24)}T3BlbkFJ${'b'.repeat(24)}`,
  },
  { id: 's-12', expect: 'anthropic-api-key', text: `ANTHROPIC_API${''}_KEY=sk-ant-api03-${'A1b2c3D4e5'.repeat(9)}AA` },
  { id: 's-13', expect: 'npm-access-token', text: '//registry.npmjs.org/:_authToken=npm_' + 'a1B2c3D4e5f6G7h8i9J0k1L2m3N4o5P6q7R8' },
  {
    id: 's-14',
    expect: 'sendgrid-api-key',
    text: `SENDGRID=SG${''}.A1b2c3d4e5F6g7h8i9j0k1.A1b2c3d4e5F6g7h8i9j0k1L2m3n4o5P6q7r8s9t0u1v`,
  },
  { id: 's-15', expect: 'mailgun-api-key', text: 'MAILGUN=key-' + '0123456789abcdef0123456789abcdef' },
  { id: 's-16', expect: 'twilio-api-key', text: 'TWILIO_KEY=SK' + '0123456789abcdef0123456789abcdef' },
  {
    id: 's-17',
    expect: 'jwt',
    text: `Authorization: Bearer eyJ${'A1b2c3d4e5'.repeat(2)}.eyJ${'A1b2c3d4e5'.repeat(2)}.${'sig'.repeat(6)}`,
  },
  {
    id: 's-18',
    expect: 'private-key-block',
    text: '-----BEGIN OPENSSH PRIVATE ' + 'KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE ' + 'KEY-----',
  },
  {
    id: 's-19',
    expect: 'basic-auth-in-url',
    text: 'git clone https:' + '//ci-bot:s3cr3tP4ssw0rd@github.com/org/repo.git',
  },
  {
    id: 's-20',
    expect: 'generic-keyword-secret',
    text: '{"api' + '_key": "aB3xK9pL2mQ7zW1nR5tY8vC4"}',
  },
  { id: 's-21', expect: 'github-oauth', text: 'gho_' + 'a1B2c3D4e5f6G7h8i9J0k1L2m3N4o5P6q7R8' },
  { id: 's-22', expect: 'pypi-upload-token', text: `pypi-AgEIcHlwaS5vcmc${'a'.repeat(60)}` },
  {
    // Column-aligned assignment (common in .env/config blocks): whitespace
    // around the delimiter must not defeat the keyword anchor.
    id: 's-23',
    expect: 'aws-secret-access-key',
    text: 'aws_sec' + 'ret_access_key      = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYabcd"',
  },
  {
    id: 's-24',
    expect: 'generic-keyword-secret',
    text: 'api' + '_key\t\t\t\t= "aB3xK9pL2mQ7zW1nR5tY8vC4"',
  },

  // --- benign: false-positive guards ---
  { id: 'b-01', expect: 'benign', text: 'commit 3b8f9d2e1a04c77f0b6d5e4a3c2b1a09f8e7d6c5' }, // git SHA
  { id: 'b-02', expect: 'benign', text: 'id: 550e8400-e29b-41d4-a716-446655440000' }, // UUID
  { id: 'b-03', expect: 'benign', text: 'the task sk-1 is assigned to the sprint' }, // sk- in prose
  { id: 'b-04', expect: 'benign', text: 'the AKIAWORD is not a key, just a word' }, // AKIA mid-word
  { id: 'b-05', expect: 'benign', text: 'pass' + 'word = "changeme"' }, // low entropy
  { id: 'b-06', expect: 'benign', text: 'const token = "" // TODO fill in' }, // empty
  { id: 'b-07', expect: 'benign', text: '{"status":"ok","count":42,"items":["a","b"]}' }, // json
  { id: 'b-08', expect: 'benign', text: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' }, // short base64
  { id: 'b-09', expect: 'benign', text: 'See https://example.com/docs?q=api' + '_key for details' }, // url, no creds
  { id: 'b-10', expect: 'benign', text: 'api' + 'key without quotes = something readable here' }, // no quoted token
  { id: 'b-11', expect: 'benign', text: 'pass' + 'word       = "changemechangeme"' }, // aligned but low entropy
] as const satisfies readonly SecretCase[];
