import { describe, expect, it } from 'vitest';

import { CLOSED_PRIVATE_KEY, continuePrivateKey, OPEN_PRIVATE_KEY, opensUnterminatedPrivateKey, PEM_END_FENCE_SOURCE, PRIVATE_KEY_HEADER_SOURCE, PRIVATE_KEY_IDLE_BLOCKS, PRIVATE_KEY_MARKER } from './pem-continuation.js';
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
    ['a header then key body, no fence', `part one:\n${BEGIN}\n${BODY}`, true],
    ['a header that ends the text (the body comes next)', `here it is:\n${BEGIN}\n`, true],
    ['a closed block', `${BEGIN}\n${BODY}\n${END}`, false],
    ['a closed block then a second, open one', `${BEGIN}\n${END}\nnext:\n${BEGIN}\n${BODY}`, true],
    ['a header mentioned inside prose (review: no over-redaction)', `Look for the line \`${BEGIN}\` at the top of the file.`, false],
    ['a header followed by a hex hash, not key body', `${BEGIN}\n${'a'.repeat(20)}${'0'.repeat(20)}`, false],
    ['review: a header then only armour headers and a blank line (ENCRYPTED PEM, PGP)', `${BEGIN}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0A1B\n\n`, true],
    ['review: a header then a partial first body line', `${BEGIN}\nMIIEowIBAAKCAQEA0Z3V`, true],
    ['review: a header then a quoted partial line', `> ${BEGIN}\n> MIIEowIBAAKC`, true],
    ['a header then prose', `${BEGIN}\nis the line a key starts with.`, false],
    ['no header', `${BODY}\n${END}`, false],
    ['a public key header', `-----BEGIN PUBLIC KEY-----\n${BODY}`, false],
    ['nothing', '', false],
  ])('%s', (_label, text, open) => {
    expect(opensUnterminatedPrivateKey(text)).toBe(open);
  });
});

describe('continuePrivateKey (#111)', () => {
  const M = PRIVATE_KEY_MARKER;
  const go = (text: string) => continuePrivateKey(OPEN_PRIVATE_KEY, text);

  it('a closed carry passes the text through', () => {
    expect(continuePrivateKey(CLOSED_PRIVATE_KEY, `${BODY}\n${END}`)).toEqual({ text: `${BODY}\n${END}`, redacted: false, carry: CLOSED_PRIVATE_KEY });
  });

  it('body lines and the END fence become markers; what follows the fence is untouched', () => {
    expect(go(`${BODY}\n${BODY}\n${END}\nThat is the key.`)).toEqual({ text: `${M}\n${M}\n${M}\nThat is the key.`, redacted: true, carry: CLOSED_PRIVATE_KEY });
  });

  it('a prose lead-in is kept and the body after it replaced (the issue\'s "part two:")', () => {
    expect(go(`part two:\n${BODY}\n${END}`).text).toBe(`part two:\n${M}\n${M}`);
  });

  it.each([
    ['a blockquote', `> ${BODY}`, `> ${M}`],
    ['a bullet', `- ${BODY}`, `- ${M}`],
    ['a line number', `12 | ${BODY}`, `12 | ${M}`],
    ['backticks', `\`${BODY}\``, `\`${M}\``],
    ['a trailing comment', `${BODY} # line 2`, `${M} # line 2`],
    ['base64url', `${BODY.replace(/\+/g, '-').replace(/\//g, '_')}`, M],
  ])('review: a decorated body line (%s) has its body replaced, the decoration kept', (_label, line, want) => {
    expect(go(`${line}\n${END}`).text).toBe(`${want}\n${M}`);
  });

  it('review: a JSON-escaped body on one line (literal \\n) is replaced run by run', () => {
    // The `n` of an escaped `\n` joins the next run, so the marker takes it: cosmetic, the key material is what matters.
    const { text } = go(`"${BODY}\\n${BODY}\\n${END}"`);
    expect(text).not.toContain(BODY.slice(0, 20));
    expect(text).not.toContain(BODY.slice(-20));
    expect(text).not.toContain('-----END');
    expect(text.startsWith(`"${M}`)).toBe(true);
  });

  it('CRLF line endings', () => {
    expect(go(`${BODY}\r\n${BODY}\r\n${END}\r\nok`).text).toBe(`${M}\r\n${M}\r\n${M}\r\nok`);
  });

  it('armour headers, blank lines and a short final line are body when more body or the fence follows', () => {
    expect(go(`Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABC\n\n${BODY}\nAQAB\n${END}`).text).toBe(`${M}\n${M}\n\n${M}\n${M}\n${M}`);
  });

  it('review: a short base64 remnant on its own (a mid-line block boundary) is body when the fence follows', () => {
    expect(go(`AQAB\n${END}`).text).toBe(`${M}\n${M}`);
    expect(go(`AQAB${END} done`).text).toBe(`${M} done`);
  });

  it('a short word with nothing key-like after it is kept', () => {
    expect(go('Done\nThanks').text).toBe('Done\nThanks');
  });

  it('review: hashes, paths, long identifiers and a Version: line are never body (no over-redaction)', () => {
    const text = `${'a1b2c3d4e5'.repeat(4)}\n/usr/local/bin/node\nInternationalizationServiceFactoryProvider\nVersion: 1.4.2`;
    expect(go(text)).toEqual({ text, redacted: false, carry: { open: true, idle: 1 } });
  });

  it('body and no fence: the key stays open with the idle count reset', () => {
    expect(go(`${BODY}\n${BODY}`)).toEqual({ text: `${M}\n${M}`, redacted: true, carry: OPEN_PRIVATE_KEY });
  });

  it('review: a blank text leaves the carry as it was', () => {
    for (const blank of ['', '\n', '  \n\n']) expect(go(blank)).toEqual({ text: blank, redacted: false, carry: OPEN_PRIVATE_KEY });
  });

  it(`review: prose counts towards ${PRIVATE_KEY_IDLE_BLOCKS} idle texts; the key closes only after that many in a row`, () => {
    let carry = OPEN_PRIVATE_KEY;
    for (let i = 1; i < PRIVATE_KEY_IDLE_BLOCKS; i += 1) {
      carry = continuePrivateKey(carry, 'Let me check the file first.').carry;
      expect(carry).toEqual({ open: true, idle: i });
    }
    expect(continuePrivateKey(carry, 'Moving on.').carry).toEqual(CLOSED_PRIVATE_KEY);
    // Body before the limit resets it.
    expect(continuePrivateKey({ open: true, idle: PRIVATE_KEY_IDLE_BLOCKS - 1 }, BODY).carry).toEqual(OPEN_PRIVATE_KEY);
  });

  it('review: a decorated short line is body when the fence follows, its decoration kept', () => {
    expect(go(`> ${BODY}\n> AQAB\n> ${END}`).text).toBe(`> ${M}\n> ${M}\n> ${M}`);
    expect(go(`> AQAB${END}`).text).toBe(`> ${M}`);
  });

  it('review: a short line right after body is body even with the fence in the next text', () => {
    expect(go(`${BODY}\nAQAB`)).toEqual({ text: `${M}\n${M}`, redacted: true, carry: OPEN_PRIVATE_KEY });
  });

  it('review: paths and URLs with a digit and a capital are not key body (they mix / with - or _)', () => {
    const text = 'Opened https://github.com/jacksonanstee/agent-harness-JA/pull/100\nSee /Users/Jackson/Documents/agent-harness-JA/src/session2/x.ts';
    expect(go(text)).toEqual({ text, redacted: false, carry: { open: true, idle: 1 } });
  });

  it('a base64url key line (no / or +) is still body', () => {
    expect(go(`${'AbCd012_-'.repeat(6)}\n${END}`).text).toBe(`${M}\n${M}`);
  });

  it('the shared carries are frozen', () => {
    expect(Object.isFrozen(OPEN_PRIVATE_KEY) && Object.isFrozen(CLOSED_PRIVATE_KEY)).toBe(true);
  });
});
