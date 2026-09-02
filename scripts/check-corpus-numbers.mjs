#!/usr/bin/env node
// S2 docs done-gate, third derived constant: the red-team corpus figures.
//
// README, docs/*.md and docs/blog/*.md state how big the corpus is, how many
// cases are malicious, how many the scanner detects, how many it misses and
// the detection rate. Every one of those is a hand-copied derived constant,
// and on 2026-08-25 an external review found the prose stale since the one
// count change after ADR-0018 (51 cases and 92.5% asserted in the present
// tense, against a shipped 53 and 90.2%) with nothing re-deriving them.
// check-docs.sh's header lists "another hand-copied derived constant" as its
// extension point; this is that extension, in its own file because it needs
// a JSON parser and check-docs is bash and awk with none.
//
// EXIT CODES ARE THE CONTRACT, same three states as the sibling gates:
//   0  every recognised claim matches the figures re-derived from the rows
//   1  at least one claim is stale (each one printed), or no claim was
//      recognised anywhere (a gate that recognises nothing covers nothing)
//   2  the gate did not complete: bad root, baseline missing / unreadable /
//      a symlink / over the byte cap / internally inconsistent, a malformed
//      skip marker, an unclosed fence, or a crash. Exit 1 can never mean a
//      crash: every throw lands in the catch-all at the bottom and becomes 2.
//
// WHAT IS RE-DERIVED, AND FROM WHAT. The figures come from the ROWS of
// eval/redteam/baseline.json (category and verdict per row), never from its
// `totals` block, which is itself a hand-copied derived constant. The totals
// ARE compared with the row-derived figures, and a disagreement is exit 2
// rather than a finding: the baseline is then inconsistent with itself, which
// the redteam gate's totalsMismatchDetail owns, and reporting a doc finding
// would blame prose for a data defect.
//
// FILE SCOPE is "live docs by construction": README.md, docs/*.md and
// docs/blog/*.md. docs/decisions/ is out (every ADR carries a Date and records
// its own moment) and so is process/ (devlogs and review notes are dated
// records). Stated consequence: a NEW ADR written with a stale number is not
// caught here; ADR prose is reviewed, not gated, same as before. The
// directories are a fixed list (DOC_DIRS): a new docs/<other>/*.md is out of
// scope until it is added there, so adding a docs directory is a change to
// this gate.
//
// EXEMPTION is an explicit, balanced marker pair placed in the document:
//   <!-- corpus-gate: skip -->   ...   <!-- corpus-gate: resume -->
// Used for prose that deliberately quotes historical figures (security-model
// section 7's frozen Week-2 snapshot). A skip never resumed, a resume without
// a skip, or a nested skip is exit 2, because coverage is then unknown. This
// is the "explicit ignore list" check-docs.sh says to add rather than weaken
// a check; it lives beside the text it exempts so the exemption shows in the
// diff that adds it. Same-line qualifiers ("at E-2", "Week 3", a date) were
// rejected: a wrapped qualifier lands on the next line, and a LIVE claim on a
// line that happens to mention Week 3 would be skipped silently.
//
// BEFORE MATCHING, each line is normalised. Look-alikes first: NFKC folds
// fullwidth digits; TAB, VT, FF, the Unicode spaces and line separators
// become a space; the dash family becomes "-"; and every
// Default_Ignorable_Code_Point plus the non-whitespace C0 controls, DEL and
// C1 are deleted, because "53 cases" with a no-break space or a tab,
// "53-case" with a non-breaking hyphen and "corpus" with a soft hyphen, a
// bidi override or a NEL inside it all render exactly like the ASCII claim
// and hid it from every recogniser (security lens and verifier, 2026-09-01).
// A homoglyph (a Cyrillic o inside "corpus") is outside every folded class
// and still hides a claim; that is a stated limit. Then link TARGETS (`[text](target)`,
// the target free of parentheses and whitespace) and bare URLs are removed
// (an address is not prose, and `.../51-case-study` is not a claim), link
// TEXT is kept (it is prose a reader believes; the ADR-index row that
// shipped stale sat beside a link in the same table cell, and no live corpus
// figure has yet appeared inside link text), and digit-group commas
// are removed so "1,000 cases" reads as 1000 rather than as its last group.
// The stripper and every recogniser are linear in the line (a failed attempt
// stops at the next bracket, parenthesis or word boundary rather than
// scanning to the end from every position); a line over MAX_LINE_CHARS, a
// run of more than MAX_COMBINING_MARKS combining marks (NFKC's canonical
// reordering is quadratic in one, and the check runs before NFKC does) or a
// doc over MAX_DOC_BYTES is exit 2 naming the file; and findings are capped
// at MAX_FINDINGS_PER_FILE per file with the rest counted. So no doc can
// hold the job or flood its log: the first cut's rate recognisers took 2.5 s
// on 50k digits and 40 s on 200k on one machine, on a workflow that fork PRs
// reach, and one 1 MB doc of stale rates produced 224,901 findings (the
// verifier's 2026-09-01 fixture; the ratio, not the pair, reproduces).
//
// RECOGNISED CLAIM SHAPES (on fence-stripped, marker-stripped lines):
//   N-case, N cases            == corpus size   } only on a line that also
//   >=N cases, >=N-case,       == a lower bound } says "corpus" (the U+2265
//     at least N cases                          } form counts)
//   D/M malicious (spaces around the slash allowed)
//                              D == detected and M == malicious
//   N malicious, N detected, N benign      == the named figure
//   N (or one..twelve) [current] [known-]miss/misses/missed   == missed
//   NN.N% and NN.NN% on a line containing "detect"   == rate (a space before
//   ~NN% on a line containing "detect"    == round(rate)   the sign is fine)
// The rate is rounded HALF-UP from the exact integer ratio, never through a
// float: see deriveCorpus.
//
// NOT recognised, deliberately, and the limits are where a future drift will
// hide: a size claim on a line that never says "corpus" (ordinary prose says
// "in 3 cases the model refused", and without that gate the sentence is a
// build failure); a bare integer percentage (the blog uses "92% to 94%" and
// ">= 90%" as hypotheticals and those must stay legal); the
// blocked/flagged/asked split (no live doc restates it; add a recogniser when
// one does); a spelled-out size ("fifty-three cases"); a rate whose word
// "detect" wraps to the next line; a count whose noun wraps ("Three cases are
// *known" / "misses*" is the exact shape that shipped stale, and why the blog
// now says it on one line). A link that carries a title (`[t](x.md "...")`)
// is not stripped, so its target is read as prose along with the title. The
// fence grammar is check-docs.sh's, so it shares that gate's limit: a
// backtick opener whose info string contains a backtick is a fence to both
// gates and not to a CommonMark renderer (issue #119, both gates together).
// A reference-style link label (`[text][label]`) is read as prose although a
// reader never sees the label.
//
// LOG HYGIENE. Doc content and filenames are attacker-influenced under the
// cloned-repo threat model (security-model section 2) and reach CI logs.
// Every emitted line starts with the fixed PREFIX so a filename such as
// `::error title=X::y.md` cannot become a GitHub workflow command, and every
// emitted line, filename and finding text alike, is stripped of C0/C1/DEL and
// the bidi overrides and isolates at the one place that writes (the first
// cut sanitised the filename only, and a vertical tab inside a matched
// "5<VT>known-misses" reached the log raw). Findings quote only the
// regex-constrained match (digits, a fixed word list, `/`, `~`, `%` and the
// whitespace between them) and the derived figure, never the rest of the
// line. A read that fails names the relative file and the error code, never
// the runner's absolute path (a root that cannot be entered echoes the
// operator's own argument, the one path the operator typed).
//
// READ ENVELOPE. The baseline and every doc are read through the redteam
// gate's envelope (src/internal/guarded-read.ts, ADR-0034), restated here
// rather than imported because this job installs nothing: the leaf and every
// ancestor directory under ROOT are lstat-refused if symlinks, the open
// carries O_NOFOLLOW and O_NONBLOCK, and the type and the byte cap come from
// fstat on the descriptor that is read. The first cut lstat-checked the leaf
// only and read by path, so a committed `eval/redteam` directory symlink was
// followed where loadBaseline refuses it, and the docs were read with no
// envelope at all (security lens, 2026-09-01). Caps, each exit 2 naming the
// file: MAX_BASELINE_BYTES and MAX_DOC_BYTES per file, MAX_LINE_CHARS per
// line.
//
// Usage: node scripts/check-corpus-numbers.mjs [ROOT]   (ROOT exists so the
// test suite can point it at fixture trees; it defaults to the repo root.)

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PREFIX = 'check-corpus:';
const BASELINE = 'eval/redteam/baseline.json';
/** Mirrors MAX_BASELINE_BYTES in src/eval/redteam/baseline.ts. */
const MAX_BASELINE_BYTES = 1_000_000;
/** Same cap for a doc; the largest live one is 66 KB. */
const MAX_DOC_BYTES = 1_000_000;
/**
 * Per line, in UTF-16 code units (what `.length` counts, so an astral
 * character counts twice and the cap is conservative); the longest live line
 * is 9,584 (a security-model table row).
 */
const MAX_LINE_CHARS = 20_000;
/**
 * NFKC's canonical reordering is quadratic in a run of combining marks with
 * mixed canonical classes (the verifier timed x4 per doubling). UAX #15's
 * stream-safe limit is 30; no live line carries a run of two.
 */
const MAX_COMBINING_MARKS = 30;
const COMBINING_RUN = new RegExp(`\\p{M}{${MAX_COMBINING_MARKS + 1}}`, 'u');
/** Findings shown per file; the rest are counted, so one doc cannot flood the log. */
const MAX_FINDINGS_PER_FILE = 200;
const DOC_DIRS = ['docs', 'docs/blog'];
// Absent on platforms without them; the lstat checks stay the primary guard.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** A did-not-complete condition with a curated message. Exit 2. */
class Incomplete extends Error {}

/**
 * Half-up rounding of an exact integer ratio. Integer arithmetic throughout:
 * `Math.round(a / b)` and `toFixed` both round a float that may already sit
 * on the wrong side of a half.
 */
const roundHalfUp = (numerator, denominator) => {
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  return 2 * remainder >= denominator ? quotient + 1 : quotient;
};

/**
 * C0, DEL, C1, the bidi overrides (U+202A..U+202E) and isolates
 * (U+2066..U+2069). Built from code points so this source file carries none
 * of the bytes it strips.
 */
const cp = (n) => String.fromCharCode(n);
const span = (from, to) => `${cp(from)}-${cp(to)}`;
const UNSAFE = new RegExp(
  `[${span(0x00, 0x1f)}${cp(0x7f)}${span(0x80, 0x9f)}${span(0x202a, 0x202e)}${span(0x2066, 0x2069)}]`,
  'g',
);
const sanitise = (text) => String(text).replace(UNSAFE, '');
/** The one place that writes: every line is prefixed AND sanitised here. */
const emit = (text) => console.error(`${PREFIX} ${sanitise(text)}`);

/**
 * Look-alikes, folded before matching. NFKC first (fullwidth digits and
 * tilde, the compatibility forms); then TAB, VT, FF, the Unicode spaces and
 * the line and paragraph separators become a space; the dash family becomes
 * "-"; and every Default_Ignorable_Code_Point (soft hyphen, the zero-width
 * characters, the bidi marks, isolates and overrides, variation selectors,
 * BOM and the rest of that Unicode property) plus the C0 controls that are
 * not whitespace, DEL and C1 are deleted, because each renders as nothing.
 * The first fold set was a hand-picked list of eight code points, and the
 * verifier showed eight other default-ignorables, the controls and a plain
 * TAB still hid a claim;
 * naming the property instead of a list is what closes the class.
 */
const LOOKALIKE_SPACES = /[\t\v\f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;
const LOOKALIKE_DASHES = /[\u2010-\u2015\u2212]/g;
const IGNORABLE = new RegExp(
  `[\\p{Default_Ignorable_Code_Point}${span(0x00, 0x08)}${span(0x0e, 0x1f)}${cp(0x7f)}${span(0x80, 0x9f)}]`,
  'gu',
);
const normalise = (line) =>
  line.normalize('NFKC').replace(LOOKALIKE_SPACES, ' ').replace(LOOKALIKE_DASHES, '-').replace(IGNORABLE, '');

const ENVELOPE = 'refusing to follow it (same envelope as the redteam gate)';

/**
 * lstat without following. Returns null for ENOENT (the caller decides what
 * absence means); a symlink or any other stat failure is Incomplete.
 */
function lstatRefusingSymlink(root, rel, label) {
  let stat;
  try {
    stat = lstatSync(join(root, rel));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Incomplete(`could not stat ${label} ${rel} (${error?.code ?? 'stat error'}); not checked`);
  }
  if (stat.isSymbolicLink()) throw new Incomplete(`${label} ${rel} is a symlink; ${ENVELOPE}`);
  return stat;
}

/**
 * The redteam gate's read envelope (src/internal/guarded-read.ts, ADR-0034),
 * restated rather than imported because this job installs nothing. The leaf
 * and every ancestor directory under ROOT are lstat-refused if symlinks; the
 * open carries O_NOFOLLOW (a leaf symlink raced in after the lstat cannot be
 * traversed) and O_NONBLOCK (a FIFO cannot hang the gate); the type and the
 * byte cap come from fstat on the SAME descriptor the read uses. ENOENT is
 * rethrown untouched so each caller names what absence means. Messages carry
 * the relative name and an error code, never the runner's absolute path.
 */
function readGuarded(root, rel, maxBytes) {
  const parts = rel.split('/');
  for (let depth = 1; depth < parts.length; depth += 1) {
    lstatRefusingSymlink(root, parts.slice(0, depth).join('/'), 'directory');
  }
  lstatRefusingSymlink(root, rel, 'file');
  let fd;
  try {
    fd = openSync(join(root, rel), fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (error?.code === 'ENOENT') throw error;
    if (error?.code === 'ELOOP') throw new Incomplete(`file ${rel} is a symlink; ${ENVELOPE}`);
    throw new Incomplete(`could not read ${rel} (${error?.code ?? 'open error'}); not checked`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Incomplete(`${rel} is not a regular file`);
    if (stat.size > maxBytes) {
      throw new Incomplete(`${rel} is ${stat.size} bytes, over the ${maxBytes}-byte cap; not checked`);
    }
    return readFileSync(fd, 'utf8');
  } catch (error) {
    if (error instanceof Incomplete) throw error;
    throw new Incomplete(`could not read ${rel} (${error?.code ?? 'read error'}); not checked`);
  } finally {
    closeSync(fd);
  }
}

function deriveCorpus(root) {
  let text;
  try {
    text = readGuarded(root, BASELINE, MAX_BASELINE_BYTES);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Incomplete(`no ${BASELINE} under the root - nothing to re-derive from`);
    }
    throw error;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // The parser's message can quote the file body; it is not echoed.
    throw new Incomplete(`could not derive corpus figures from ${BASELINE}: not JSON`);
  }
  const rows = doc?.rows;
  if (!Array.isArray(rows)) {
    throw new Incomplete(`could not derive corpus figures from ${BASELINE}: rows is not an array`);
  }
  let malicious = 0;
  let detected = 0;
  rows.forEach((row, index) => {
    if (!row || typeof row.category !== 'string' || typeof row.verdict !== 'string') {
      throw new Incomplete(`could not derive corpus figures from ${BASELINE}: row ${index} lacks a category or verdict`);
    }
    if (row.category === 'benign') return;
    malicious += 1;
    if (row.verdict !== 'pass') detected += 1;
  });
  const size = rows.length;
  if (malicious === 0) {
    throw new Incomplete(`could not derive corpus figures from ${BASELINE}: no malicious rows, so no rate`);
  }
  const missed = malicious - detected;
  const benign = size - malicious;

  const totals = doc.totals ?? {};
  const meta = doc.meta ?? {};
  const problems = [];
  const show = (value) => (typeof value === 'number' ? String(value) : `<${typeof value}>`);
  const compare = (label, claimed, actual) => {
    if (claimed !== actual) problems.push(`${label} claims ${show(claimed)}, rows derive ${actual}`);
  };
  compare('totals.total', totals.total, size);
  compare('totals.malicious', totals.malicious, malicious);
  compare('totals.detected', totals.detected, detected);
  compare('totals.byFailureKind.missed', totals.byFailureKind?.missed, missed);
  compare('meta.corpusSize', meta.corpusSize, size);
  if (problems.length > 0) {
    throw new Incomplete(
      `${BASELINE} is internally inconsistent (${problems.join('; ')}) - the redteam gate owns that; the docs were not checked`,
    );
  }
  // The rate is rounded from the EXACT ratio, never through a float. At
  // 23/80 the true value is exactly 28.75%, but `(23 / 80 * 100).toFixed(1)`
  // is "28.7": the product lands at 28.749999999999996, so the gate would
  // reject the correct figure and accept the wrong one. Twenty-six such
  // (detected, malicious) pairs exist below 500 malicious cases; 41 is not
  // one of them today, which is exactly why this had to be found by
  // execution rather than by reading (code lens, 2026-08-31).
  const tenths = roundHalfUp(detected * 1000, malicious);
  const hundredths = roundHalfUp(detected * 10000, malicious);
  return {
    size,
    malicious,
    detected,
    missed,
    benign,
    rate1: `${Math.floor(tenths / 10)}.${tenths % 10}`,
    rate2: `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`,
    rateRound: roundHalfUp(detected * 100, malicious),
  };
}

function liveDocs(root) {
  const docs = [];
  const readme = lstatRefusingSymlink(root, 'README.md', 'file');
  if (readme !== null && !readme.isFile()) throw new Incomplete('README.md is not a regular file');
  if (readme !== null) docs.push('README.md');
  for (const dir of DOC_DIRS) {
    // Absent is fine (a tree may carry no docs/ at all); a symlink is refused
    // and anything else that is not a directory means the scan did not
    // happen, which is the didn't-run state, not a clean one.
    const stat = lstatRefusingSymlink(root, dir, 'directory');
    if (stat === null) continue;
    if (!stat.isDirectory()) {
      throw new Incomplete(`${dir} exists but is not a directory, so ${dir}/*.md was not scanned`);
    }
    let names;
    try {
      names = readdirSync(join(root, dir));
    } catch {
      throw new Incomplete(`could not enumerate ${dir}, so ${dir}/*.md was not scanned`);
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue;
      const rel = `${dir}/${name}`;
      const entry = lstatRefusingSymlink(root, rel, 'file');
      // A directory that happens to end in .md is not a doc; a FIFO, socket or
      // device is refused rather than skipped, because skipping it silently
      // would be a scan that did not happen.
      if (entry === null || entry.isDirectory()) continue;
      if (!entry.isFile()) throw new Incomplete(`${rel} is not a regular file`);
      docs.push(rel);
    }
  }
  return docs;
}

/** Returns the number of claims recognised on the line; findings are pushed. */
function checkLine(name, lineNo, line, d, findings) {
  let claims = 0;
  const note = (claim, derived) => findings.push(`${name}:${lineNo}: claims ${claim} but the baseline derives ${derived}`);
  // A link TARGET and a bare URL are addresses, not prose: `.../51-case-study`
  // is not a claim about the corpus, and a reader never sees it as one. Link
  // TEXT is deliberately kept, because that is prose a reader believes (the
  // ADR-index row that shipped stale sat beside a link in the same cell; no
  // live corpus figure has yet appeared inside link text).
  //
  // Both the stripper and every recogniser below are linear in the line: link
  // text may not contain a bracket and a target may not contain a parenthesis
  // or whitespace, so a failed attempt stops at the next such character
  // instead of scanning to the end of the line from every "](" (security
  // lens, 2026-09-01: 50 lines of openers took 2.8 s; the rate recognisers
  // without a word boundary took 2.5 s on 50k digits and 40 s on 200k).
  const text = normalise(line);
  let work = text.replace(/\[([^[\]]*)\]\([^()\s]*\)/g, '[$1] ').replace(/\bhttps?:\/\/\S+/gi, ' ');
  // Digit-group commas are removed so "1,000 cases" is read as 1000 rather
  // than as its last group: `\b` fires immediately after the comma, and the
  // first cut reported "claims 000 cases".
  work = work.replace(/(\d),(?=\d{3}\b)/g, '$1');

  // SIZE claims require the word "corpus" on the line, the way a rate claim
  // requires "detect". Ordinary prose says "in 3 cases the model refused",
  // and without this gate that sentence is a build failure. Stated cost: a
  // size claim on a line that never says "corpus" is not checked. Every one
  // of the six live sites carries the word (README, architecture,
  // eval-methodology twice, security-model, the blog; re-derived by running
  // the gate against a shrunk baseline, which reports every size site).
  const aboutCorpus = /corpus/i.test(text);
  if (aboutCorpus) {
    // Lower bounds first, and removed from the working copy so the exact form
    // below does not read ">=50 cases" as a claim of exactly 50.
    work = work.replace(/(?:≥|>=|at least )\s?(\d+)(?:-case| cases?)\b/g, (_m, num) => {
      claims += 1;
      if (d.size < Number(num)) note(`at least ${num} cases`, `${d.size} cases`);
      return ' ';
    });
    for (const match of work.matchAll(/\b(\d+)-cases?\b/g)) {
      claims += 1;
      if (Number(match[1]) !== d.size) note(`a ${match[1]}-case corpus`, `${d.size} cases`);
    }
    for (const match of work.matchAll(/\b(\d+) cases?\b/g)) {
      claims += 1;
      if (Number(match[1]) !== d.size) note(`${match[1]} cases`, `${d.size}`);
    }
  }

  // The fraction first, removed, so "37/41 malicious" is not also read as a
  // bare "41 malicious". Spaces around the slash are accepted: without them
  // "30 / 41 malicious" fell through to the bare form, which checks only the
  // DENOMINATOR and passed a wrong detected count (code lens, 2026-08-31).
  work = work.replace(/\b(\d+)\s*\/\s*(\d+) malicious\b/g, (_m, top, bottom) => {
    claims += 1;
    if (Number(top) !== d.detected || Number(bottom) !== d.malicious) {
      note(`${top}/${bottom} malicious`, `${d.detected}/${d.malicious} malicious`);
    }
    return ' ';
  });
  for (const match of work.matchAll(/\b(\d+) malicious\b/g)) {
    claims += 1;
    if (Number(match[1]) !== d.malicious) note(`${match[1]} malicious`, `${d.malicious}`);
  }
  for (const match of work.matchAll(/\b(\d+) detected\b/g)) {
    claims += 1;
    if (Number(match[1]) !== d.detected) note(`${match[1]} detected`, `${d.detected}`);
  }
  for (const match of work.matchAll(/\b(\d+) benign\b/g)) {
    claims += 1;
    if (Number(match[1]) !== d.benign) note(`${match[1]} benign`, `${d.benign}`);
  }

  const missRe = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:current\s+)?(?:known[-\s])?miss(?:es|ed)?\b/gi;
  for (const match of work.matchAll(missRe)) {
    claims += 1;
    const value = /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1].toLowerCase()];
    if (value !== d.missed) note(`${match[0]} (${value})`, `${d.missed} missed`);
  }

  if (/detect/i.test(text)) {
    // `\s?%` because a typographic space before the sign is ordinary in prose
    // and the first cut could not see "99.9 %" as a claim at all.
    for (const match of work.matchAll(/\b(\d+\.\d\d)\s?%/g)) {
      claims += 1;
      if (match[1] !== d.rate2) note(`${match[1]}% detection`, `${d.rate2}%`);
    }
    for (const match of work.matchAll(/\b(\d+\.\d)\s?%/g)) {
      claims += 1;
      if (match[1] !== d.rate1) note(`${match[1]}% detection`, `${d.rate1}%`);
    }
    for (const match of work.matchAll(/~\s?(\d+)\s?%/g)) {
      claims += 1;
      if (Number(match[1]) !== d.rateRound) note(`~${match[1]}% detection`, `~${d.rateRound}%`);
    }
  }
  return claims;
}

/**
 * Fence grammar is check-docs.sh's, restated: an opener is up to 3 spaces
 * then a run of 3+ backticks or tildes, and only a run of the SAME character
 * at least as long, followed by whitespace only, closes it. Markers are seen
 * only outside fences, so fenced example text cannot open a skip region.
 */
function checkFile(root, rel, d, findings) {
  const name = sanitise(rel);
  const local = [];
  // All three line endings, so a lone-CR file does not collapse into one
  // logical line and report every finding against line 1.
  let body;
  try {
    body = readGuarded(root, rel, MAX_DOC_BYTES);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Incomplete(`could not read ${rel} (ENOENT); not checked`);
    throw error;
  }
  const lines = body.split(/\r\n|\r|\n/);
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceOpenedAt = 0;
  let skipOpenedAt = 0;
  let claims = 0;
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    if (raw.length > MAX_LINE_CHARS) {
      throw new Incomplete(`${name}:${lineNo} is ${raw.length} chars, over the ${MAX_LINE_CHARS}-char cap; not checked`);
    }
    if (COMBINING_RUN.test(raw)) {
      throw new Incomplete(
        `${name}:${lineNo} carries a run of more than ${MAX_COMBINING_MARKS} combining marks; not checked`,
      );
    }
    const line = raw;
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const run = fence[1];
      if (!inFence) {
        inFence = true;
        fenceChar = run[0];
        fenceLen = run.length;
        fenceOpenedAt = lineNo;
        return;
      }
      if (run[0] === fenceChar && run.length >= fenceLen && /^[ \t]*$/.test(fence[2])) inFence = false;
      return;
    }
    if (inFence) return;
    if (/^\s*<!--\s*corpus-gate:\s*skip\s*-->\s*$/.test(line)) {
      if (skipOpenedAt !== 0) {
        throw new Incomplete(`${name}:${lineNo}: corpus-gate skip nested inside the skip opened at line ${skipOpenedAt}`);
      }
      skipOpenedAt = lineNo;
      return;
    }
    if (/^\s*<!--\s*corpus-gate:\s*resume\s*-->\s*$/.test(line)) {
      if (skipOpenedAt === 0) throw new Incomplete(`${name}:${lineNo}: corpus-gate resume without a skip`);
      skipOpenedAt = 0;
      return;
    }
    if (skipOpenedAt !== 0) return;
    claims += checkLine(name, lineNo, line, d, local);
  });
  if (inFence) {
    throw new Incomplete(
      `${name}: a code fence opened at line ${fenceOpenedAt} and never closed, so nothing after it was checked (check-docs reports the same fence)`,
    );
  }
  if (skipOpenedAt !== 0) {
    throw new Incomplete(`${name}: corpus-gate skip opened at line ${skipOpenedAt} and never resumed`);
  }
  const shown = local.slice(0, MAX_FINDINGS_PER_FILE);
  findings.push(...shown);
  const suppressed = local.length - shown.length;
  if (suppressed > 0) {
    findings.push(`${name}: ${suppressed} more finding(s) not shown (${MAX_FINDINGS_PER_FILE} shown per file)`);
  }
  return { claims, problems: local.length, suppressed };
}

const rootOf = (argv) => resolve(argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

function main(argv) {
  // Fault injection, not dependency injection (check-docs.sh's note applies):
  // a crash has to be REACHABLE for the catch-all below to be bound by a test.
  if (process.env.CHECK_CORPUS_SELFTEST_CRASH) throw new Error('self-test crash requested');

  const root = rootOf(argv);
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch {
    throw new Incomplete(`cannot enter '${root}'`);
  }
  if (!rootStat.isDirectory()) throw new Incomplete(`cannot enter '${root}': not a directory`);

  const derived = deriveCorpus(root);
  const findings = [];
  let claims = 0;
  let problems = 0;
  let suppressed = 0;
  for (const rel of liveDocs(root)) {
    const result = checkFile(root, rel, derived, findings);
    claims += result.claims;
    problems += result.problems;
    suppressed += result.suppressed;
  }

  if (claims === 0) {
    findings.push(
      'no corpus claim recognised in any live doc (README.md, docs/*.md, docs/blog/*.md) - either the docs stopped stating corpus numbers (then remove this gate in the same commit) or they were reworded past the recognisers',
    );
    problems += 1;
  }
  if (findings.length > 0) {
    for (const finding of findings) emit(finding);
    emit(`FAILED (${problems} problem(s)${suppressed > 0 ? `, ${suppressed} not shown` : ''})`);
    return 1;
  }
  const summary = `${derived.size} cases, ${derived.malicious} malicious, ${derived.detected} detected, ${derived.missed} missed, ${derived.rate1}%`;
  console.log(`${PREFIX} OK (${summary}; ${claims} ${claims === 1 ? 'claim' : 'claims'} checked)`);
  return 0;
}

try {
  process.exitCode = main(process.argv);
} catch (error) {
  if (error instanceof Incomplete) {
    emit(error.message);
  } else {
    // A genuine bug's message may carry an absolute path; the runner's
    // workspace is one more attacker-adjacent string the log does not need.
    emit(`did not complete (${String(error?.message ?? error).split(rootOf(process.argv)).join('<root>')})`);
  }
  process.exitCode = 2;
}
