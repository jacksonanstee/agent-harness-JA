import { describe, expect, it } from 'vitest';

import { continuePrivateKey, opensUnterminatedPrivateKey, PEM_END_FENCE_SOURCE, PRIVATE_KEY_HEADER_SOURCE, PRIVATE_KEY_MARKER } from './pem-continuation.js';
import { redact } from './redact.js';
import { DEFAULT_SECRET_RULES } from './rules.js';

// Issue #111: carrying an open private-key block from one text to the next.
// Test keys are built from pieces so no line of this file reads as a real key.
const BEGIN = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
const END = '-----END RSA ' + 'PRIVATE KEY-----';
const BODY = 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn' + '/ygWyF8PbnGy0AHB7MaGzZ4bU0Ij5h';

describe('the shared sources are the rule\'s own (#111)', () => {
  it('private-key-block is built from the header and fence sources, and writes the marker', () => {
    const rule = DEFAULT_SECRET_RULES.find((r) => r.id === 'private-key-block');
    expect(rule?.pattern.source).toBe(`${PRIVATE_KEY_HEADER_SOURCE}[\\s\\S]*?(?:${PEM_END_FENCE_SOURCE}|$)`);
    expect(redact(`${BEGIN}\n${BODY}\n${END}`).redacted).toBe(PRIVATE_KEY_MARKER);
  });
});

describe('opensUnterminatedPrivateKey (#111)', () => {
  it.each([
    ['a header with no fence', `part one:\n${BEGIN}\n${BODY}`, true],
    ['a closed block', `${BEGIN}\n${BODY}\n${END}`, false],
    ['a closed block then a second, open one', `${BEGIN}\n${END}\nnext:\n${BEGIN}\n${BODY}`, true],
    ['no header', `${BODY}\n${END}`, false],
    ['a public key header', `-----BEGIN PUBLIC KEY-----\n${BODY}`, false],
    ['nothing', '', false],
  ])('%s: %s', (_label, text, open) => {
    expect(opensUnterminatedPrivateKey(text)).toBe(open);
  });
});

describe('continuePrivateKey (#111)', () => {
  const M = PRIVATE_KEY_MARKER;

  it('body lines through the END fence become one marker; what follows the fence is untouched', () => {
    expect(continuePrivateKey(`${BODY}\n${BODY}\n${END}\nThat is the key.`)).toEqual({ text: `${M}\nThat is the key.`, redacted: true, open: false });
  });

  it('a prose lead-in is kept and the body after it still replaced (the issue\'s "part two:")', () => {
    expect(continuePrivateKey(`part two:\n${BODY}\n${END}`)).toEqual({ text: `part two:\n${M}`, redacted: true, open: false });
  });

  it('armour headers and blank lines inside the block', () => {
    const text = `Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABC\n\n${BODY}\n${END}`;
    expect(continuePrivateKey(text)).toEqual({ text: `${M}\n\n${M}`, redacted: true, open: false });
  });

  it('a fence on the same line as body, and one after prose on its line', () => {
    expect(continuePrivateKey(`${BODY}${END} done`)).toEqual({ text: `${M} done`, redacted: true, open: false });
    expect(continuePrivateKey(`the line ends with ${END}`)).toEqual({ text: `the line ends with ${M}`, redacted: true, open: false });
  });

  it('a padded short final line is body', () => {
    expect(continuePrivateKey(`Zq8=\n${END}`)).toEqual({ text: M, redacted: true, open: false });
  });

  it('body and no fence: the block stays open', () => {
    expect(continuePrivateKey(`${BODY}\n${BODY}`)).toEqual({ text: M, redacted: true, open: true });
  });

  it('prose only, no fence: nothing replaced and the block ends', () => {
    expect(continuePrivateKey('Sorry, I should not print that.')).toEqual({ text: 'Sorry, I should not print that.', redacted: false, open: false });
  });

  it('short words and prose with spaces are never body', () => {
    expect(continuePrivateKey('ok\nyes\nabc def ghi jkl mno pqr').redacted).toBe(false);
  });

  it('a new key opened after the fence leaves the state open', () => {
    expect(continuePrivateKey(`${BODY}\n${END}\nnext:\n${BEGIN}\n${BODY}`).open).toBe(true);
  });

  it('empty text: nothing replaced, closed', () => {
    expect(continuePrivateKey('')).toEqual({ text: '', redacted: false, open: false });
  });
});
