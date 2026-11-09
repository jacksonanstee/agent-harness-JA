// Issue #111: the private-key rule needs its BEGIN header, so when one text
// carries the header and a LATER text carries the rest of the body, the rest
// has nothing to anchor on. These helpers let a caller that redacts a stream
// of texts (the session's assistant blocks) carry an open block across them.
// The header and fence sources are shared with the rule itself, so the two
// cannot drift.

/** The private-key BEGIN header, as `private-key-block` matches it. */
export const PRIVATE_KEY_HEADER_SOURCE = String.raw`-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----`;
/** Any PEM END fence, as `private-key-block` ends on it. */
export const PEM_END_FENCE_SOURCE = String.raw`-----END [A-Z ]{0,40}-----`;
/** The marker the rule's redaction writes, reused for a continuation. */
export const PRIVATE_KEY_MARKER = '[REDACTED:private-key-block]';

/** How many non-blank texts in a row may carry no key body before an open key is taken to have ended. */
export const PRIVATE_KEY_IDLE_BLOCKS = 3;

const HEADER_RE = new RegExp(PRIVATE_KEY_HEADER_SOURCE, 'g');
const END_RE = new RegExp(PEM_END_FENCE_SOURCE);
/** A run of key body: 40+ base64 or base64url characters anywhere in a line (a `> ` or `12 | ` prefix, or an escaped `\n`, breaks it cleanly). */
const BODY_RUN_RE = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
/** A short line that is only base64 (a final body line): body only when more body or the fence follows it. */
const SHORT_BASE64_LINE_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
/** Armour headers inside an encrypted PEM key (Proc-Type, DEK-Info) or a PGP block (Version, Comment), counted like a short line. */
const ARMOUR_HEADER_RE = /^(?:Proc-Type|DEK-Info|Version|Comment): /;

/** Key body mixes upper case, lower case and digits; a hex hash, a path or a long identifier does not. */
const isKeyRun = (run: string): boolean => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);
const hasKeyRun = (line: string): boolean => (line.match(BODY_RUN_RE) ?? []).some(isKeyRun);
const replaceKeyRuns = (line: string): string => line.replace(BODY_RUN_RE, (run) => (isKeyRun(run) ? PRIVATE_KEY_MARKER : run));

/**
 * True when `text`'s last private-key header has no END fence after it and
 * starts a key: the header ends the text, or key body follows it. A header
 * mentioned inside prose ("look for -----BEGIN ...----- at the top") opens
 * nothing.
 */
export function opensUnterminatedPrivateKey(text: string): boolean {
  let lastEnd = -1;
  for (const m of text.matchAll(HEADER_RE)) lastEnd = m.index + m[0].length;
  if (lastEnd < 0) return false;
  const tail = text.slice(lastEnd);
  return !END_RE.test(tail) && (tail.trim() === '' || hasKeyRun(tail));
}

/** The carry between texts: whether a key is open, and how many non-blank texts in a row carried none of its body. */
export interface PrivateKeyCarry {
  readonly open: boolean;
  readonly idle: number;
}
export const CLOSED_PRIVATE_KEY: PrivateKeyCarry = { open: false, idle: 0 };
export const OPEN_PRIVATE_KEY: PrivateKeyCarry = { open: true, idle: 0 };

export interface PrivateKeyContinuation {
  /** `text` with the open key's body and END fence replaced by the marker. */
  readonly text: string;
  /** Some part of `text` was replaced. */
  readonly redacted: boolean;
  /** The carry for the next text, before the caller checks this text for a new header. */
  readonly carry: PrivateKeyCarry;
}

type LineKind = 'body' | 'maybe' | 'blank' | 'other';
const kindOf = (line: string): LineKind => {
  const trimmed = line.trim();
  if (trimmed === '') return 'blank';
  if (hasKeyRun(line)) return 'body';
  if (SHORT_BASE64_LINE_RE.test(trimmed) || ARMOUR_HEADER_RE.test(trimmed)) return 'maybe';
  return 'other';
};

/** Which lines are body: every `body` line, and a `maybe` line when the next line that is not blank or `maybe` is body or the fence. */
function bodyLines(kinds: readonly LineKind[], fenceFollows: boolean): boolean[] {
  const isBody = kinds.map((kind) => kind === 'body');
  let follows = fenceFollows;
  for (let i = kinds.length - 1; i >= 0; i -= 1) {
    const kind = kinds[i];
    if (kind === 'body') follows = true;
    else if (kind === 'maybe') isBody[i] = follows;
    else if (kind === 'other') follows = false;
  }
  return isBody;
}

/**
 * For a text that follows one ending inside an open private-key block. Up to
 * an END fence, each run of key body becomes the marker wherever it sits in a
 * line, and so does a short base64 line or an armour header when more body or
 * the fence follows it; everything else is kept. The fence closes the key and
 * what follows it is returned unchanged, for the caller's redactor. A blank
 * text leaves the carry as it was; a text with no body counts towards
 * PRIVATE_KEY_IDLE_BLOCKS, after which the key is taken to have ended.
 */
export function continuePrivateKey(carry: PrivateKeyCarry, text: string): PrivateKeyContinuation {
  if (!carry.open || text.trim() === '') return { text, redacted: false, carry };
  const lines = text.split('\n');
  const fenceAt = lines.findIndex((line) => END_RE.test(line));
  const scanned = fenceAt < 0 ? lines : lines.slice(0, fenceAt);
  const kinds = scanned.map(kindOf);
  const isBody = bodyLines(kinds, fenceAt >= 0);
  let replaced = false;
  const out = scanned.map((line, i) => {
    if (isBody[i] !== true) return line;
    replaced = true;
    return kinds[i] === 'body' ? replaceKeyRuns(line) : line.replace(/\S[^\r]*/, PRIVATE_KEY_MARKER);
  });
  if (fenceAt >= 0) {
    const fenceLine = lines[fenceAt] ?? '';
    const fence = END_RE.exec(fenceLine);
    const start = fence?.index ?? 0;
    const end = fence === null ? 0 : start + fence[0].length;
    const before = fenceLine.slice(0, start);
    // A short base64 remnant right before the fence (`AQAB-----END ...`) is the body's last characters.
    const lead = SHORT_BASE64_LINE_RE.test(before.trim()) ? before.slice(0, before.length - before.trimStart().length) : replaceKeyRuns(before);
    out.push(`${lead}${PRIVATE_KEY_MARKER}`);
    const rest = [fenceLine.slice(end), ...lines.slice(fenceAt + 1)].join('\n');
    return { text: out.join('\n') + rest, redacted: true, carry: CLOSED_PRIVATE_KEY };
  }
  const idle = replaced ? 0 : carry.idle + 1;
  return { text: out.join('\n'), redacted: replaced, carry: idle >= PRIVATE_KEY_IDLE_BLOCKS ? CLOSED_PRIVATE_KEY : { open: true, idle } };
}
