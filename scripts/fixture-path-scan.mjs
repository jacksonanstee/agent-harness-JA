// Shared by scripts/capture-sdk-hook-fixture.mjs (decide write or refuse) and
// src/session/sdk-fixture.test.ts (scan the committed JSON, unit-test both
// refusals offline). ONE implementation, so writer and checker cannot drift.
//
// Policy (#103): scrub only KNOWN literals (the Read target, the failing-run
// path, the cwd). Every path the run is expected to contain is one of those, so
// any OTHER absolute or home-relative path means the run did something
// unexpected, and the right response is to REFUSE, not to guess a placeholder.
// The scan is inverted accordingly: it does not list home-like roots, it flags
// any path-looking token.

// A token starts at the beginning of a string or after whitespace, a quote, a
// bracket, or one of `= : , ;` (so `<cwd>/x` and `https://h/p` do not start one).
const START = '(?<![^\\s"\'`(=:,;\\[{])';
const TAIL = '[^\\s"\'`<>)]*';
const ALTERNATIVES = [
  `${START}\\/[^\\s\\/<>"'\`]`, // /anything, including /./x and /opt/x
  `${START}~(?=[\\w.-]*(?:[\\/\\\\\\s"'\`)]|$))[\\w.-]*`, // ~, ~/x, ~user/x
  `${START}[A-Za-z]:[\\\\\\/]`, // C:\ and C:/
  `${START}\\.\\.[\\\\\\/]`, // ../ at the start of a token
  '(?<=\\/)\\.\\.[\\\\\\/]', // .. segment climbing mid-path
  '[A-Za-z][A-Za-z0-9+.-]*:\\/\\/', // ANY URL scheme (file, http, ssh, vscode...): a path can ride inside one
  '\\$\\{?HOME\\b\\}?', // $HOME, ${HOME}
  '\\\\\\\\[^\\s\\\\]', // \\server\share (UNC)
];
/** Fresh global regex matching each path-looking token. */
export const machinePathRegex = () => new RegExp(`(?:${ALTERNATIVES.join('|')})${TAIL}`, 'g');

/** Every path-looking token in any string VALUE or object KEY, as `pointer: token`. */
export function findMachinePaths(value, where = '$') {
  if (typeof value === 'string') {
    return [...value.matchAll(machinePathRegex())].map((m) => `${where}: ${m[0]}`);
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findMachinePaths(v, `${where}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...findMachinePaths(k, `${where}.<key ${JSON.stringify(k)}>`),
      ...findMachinePaths(v, `${where}.${k}`),
    ]);
  }
  return [];
}

const escapeRegExp = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace KNOWN literal paths in every string value, in order (most specific first). */
export function applyLiterals(value, literals) {
  if (typeof value === 'string') {
    // Replace only at a path boundary: the literal must not run on into a
    // longer name, so a sibling such as `<cwd>-other/x` is NOT rewritten (it
    // stays a path, and the scan then refuses it) and a cwd of `/` cannot mangle.
    return literals.reduce(
      (acc, [from, to]) => acc.replace(new RegExp(`${escapeRegExp(from)}(?![\\w.~-])`, 'g'), () => to),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((v) => applyLiterals(v, literals));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applyLiterals(v, literals)]));
  }
  return value;
}

/**
 * Pure decision step of the capture: validate the raw events, scrub the known
 * literals and volatile top-level fields, scan the result, and return either
 * `{ ok: true, fixture }` or `{ ok: false, kind: 'bad' | 'leaks', problems }`.
 * No I/O, so both refusals are unit-testable without a live run.
 *
 * cfg: { marker, markerFail, readMarker, readPlaceholder, literals, volatile, sdkVersion }
 */
export function buildFixture(events, cfg) {
  const { pre, post, fail, readPre, readPost } = events;
  const top = (e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, k in cfg.volatile ? cfg.volatile[k] : v]));
  const scrub = (e) => applyLiterals(top(e), cfg.literals);
  const bad = [];
  if (pre?.tool_name !== 'Bash') bad.push(`pre.tool_name=${pre?.tool_name}`);
  if (post?.tool_name !== 'Bash') bad.push(`post.tool_name=${post?.tool_name}`);
  if (post?.tool_response?.stdout !== cfg.marker) {
    bad.push(`post.tool_response.stdout=${JSON.stringify(post?.tool_response?.stdout)}`);
  }
  if (fail) {
    if (fail.tool_name !== 'Bash') bad.push(`fail.tool_name=${fail.tool_name}`);
    const err = fail.error;
    if (typeof err !== 'string') bad.push(`fail.error is not a string (${typeof err})`);
    else if (!err.includes(cfg.markerFail) && !err.toLowerCase().includes('no such file') && !err.toLowerCase().includes('exit')) {
      bad.push(`fail.error does not look like the fixed failing run: ${JSON.stringify(err).slice(0, 120)}`);
    }
  }
  if (readPre?.tool_name !== 'Read') bad.push(`readPre.tool_name=${readPre?.tool_name}`);
  if (readPost?.tool_name !== 'Read') bad.push(`readPost.tool_name=${readPost?.tool_name}`);
  const sReadPre = readPre ? scrub(readPre) : undefined;
  const sReadPost = readPost ? scrub(readPost) : undefined;
  for (const [label, v] of [
    ['readPre.tool_input.file_path', sReadPre?.tool_input?.file_path],
    ['readPost.tool_input.file_path', sReadPost?.tool_input?.file_path],
    ['readPost.tool_response.file.filePath', sReadPost?.tool_response?.file?.filePath],
  ]) {
    if (v !== cfg.readPlaceholder) bad.push(`${label}=${JSON.stringify(v)} (want ${cfg.readPlaceholder})`);
  }
  const content = readPost?.tool_response?.file?.content;
  if (typeof content !== 'string' || !content.includes(cfg.readMarker)) {
    bad.push(`readPost.tool_response.file.content=${JSON.stringify(content)}`);
  }
  if (bad.length) return { ok: false, kind: 'bad', problems: bad };

  const fixture = {
    _provenance: {
      capturedFrom: '@anthropic-ai/claude-agent-sdk',
      sdkVersion: cfg.sdkVersion,
      marker: cfg.marker,
      readMarker: cfg.readMarker,
      note: 'Genuine SDK hook inputs, volatile fields replaced with placeholders. Re-capture with scripts/capture-sdk-hook-fixture.mjs after an SDK bump.',
    },
    preToolUse: scrub(pre),
    postToolUse: scrub(post),
    readPreToolUse: sReadPre,
    readPostToolUse: sReadPost,
    // Present only when the failing drive elicited a PostToolUseFailure event.
    ...(fail ? { postToolUseFailure: scrub(fail) } : {}),
  };
  const leaks = findMachinePaths(fixture);
  if (leaks.length) return { ok: false, kind: 'leaks', problems: leaks };
  return { ok: true, fixture };
}
