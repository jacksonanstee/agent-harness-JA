// Issue #111: the private-key rule needs its BEGIN header, so when one text
// carries the header and the NEXT text carries the rest of the body, the rest
// has nothing to anchor on. These helpers let a caller that redacts a stream
// of texts (the session's assistant blocks) carry the open block across them.
// The header and fence sources are shared with the rule itself, so the two
// cannot drift.

/** The private-key BEGIN header, as `private-key-block` matches it. */
export const PRIVATE_KEY_HEADER_SOURCE = String.raw`-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----`;
/** Any PEM END fence, as `private-key-block` ends on it. */
export const PEM_END_FENCE_SOURCE = String.raw`-----END [A-Z ]{0,40}-----`;
/** The marker the rule's redaction writes, reused for a continuation. */
export const PRIVATE_KEY_MARKER = '[REDACTED:private-key-block]';

const HEADER_RE = new RegExp(PRIVATE_KEY_HEADER_SOURCE, 'g');
const END_RE = new RegExp(PEM_END_FENCE_SOURCE);
/**
 * A body line while a key is open: base64 of 16 or more characters, or a
 * padded final line. Prose has spaces, so it is never this.
 */
const BODY_LINE_RE = /^(?:[A-Za-z0-9+/=]{16,}|[A-Za-z0-9+/]+={1,2})$/;
/** The armour headers PEM, OpenSSH and PGP put inside a block. */
const ARMOUR_HEADER_RE = /^(?:Proc-Type|DEK-Info|Comment|Version|Hash|Charset): /;

const isBodyLine = (line: string): boolean => {
  const trimmed = line.trim();
  return BODY_LINE_RE.test(trimmed) || ARMOUR_HEADER_RE.test(trimmed);
};

/** True when `text`'s last private-key header has no END fence after it, so the block runs on past `text`. */
export function opensUnterminatedPrivateKey(text: string): boolean {
  let lastEnd = -1;
  for (const m of text.matchAll(HEADER_RE)) lastEnd = m.index + m[0].length;
  return lastEnd >= 0 && !END_RE.test(text.slice(lastEnd));
}

export interface PrivateKeyContinuation {
  /** `text` with the open block's lines replaced: each run of body lines, and the END fence, becomes one marker. */
  readonly text: string;
  /** Some part of `text` was replaced. */
  readonly redacted: boolean;
  /** A key is still open at the end of `text`, so the next text continues it. */
  readonly open: boolean;
}

/**
 * For a text that follows one ending inside an open private-key block. Until
 * an END fence, every body line (base64, an armour header) is replaced and
 * every other line is kept, so a lead-in such as "part two:" neither leaks
 * the body after it nor is swallowed. The fence closes the block; what
 * follows it is returned unchanged, for the caller's redactor. With no fence
 * the block stays open only if this text carried body, so a reply that moved
 * on to prose closes it.
 */
export function continuePrivateKey(text: string): PrivateKeyContinuation {
  const out: string[] = [];
  const pushMarker = (): void => {
    if (out[out.length - 1] !== PRIVATE_KEY_MARKER) out.push(PRIVATE_KEY_MARKER);
  };
  let sawBody = false;
  let offset = 0;
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(offset, lineEnd);
    const fence = END_RE.exec(line);
    if (fence !== null) {
      const before = line.slice(0, fence.index);
      if (before.trim() !== '' && !isBodyLine(before)) out.push(`${before}${PRIVATE_KEY_MARKER}`);
      else pushMarker();
      const rest = text.slice(offset + fence.index + fence[0].length);
      return { text: out.join('\n') + rest, redacted: true, open: opensUnterminatedPrivateKey(rest) };
    }
    if (isBodyLine(line)) {
      sawBody = true;
      pushMarker();
    } else {
      out.push(line);
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  return { text: out.join('\n'), redacted: sawBody, open: sawBody };
}
