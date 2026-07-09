/**
 * Shared frontmatter-parsing guards (spec 2026-07-08 E-1: hoisted from the
 * skills loader at the second consumer, mirroring the settings.ts precedent).
 * Any module parsing untrusted `---`-fenced Markdown MUST use all three:
 * MAX_FILE_BYTES before read, hasUnsafeFenceLanguage before matter(), and
 * SAFE_MATTER_OPTIONS as the matter() options. Zero repo dependencies.
 */

/** Refuse to read skill files larger than this (resource-exhaustion guard). */
export const MAX_FILE_BYTES = 1_000_000;

// gray-matter picks its parse engine from a language tag on the opening
// fence (`---js`, `---coffee`, ...). Its built-in `javascript` engine
// `eval()`s the frontmatter body — arbitrary code execution from an
// untrusted skill file, BEFORE schema validation ever runs. Two independent
// guards close this:
//   1. FENCE_LANGUAGE rejects any fence whose language is not empty/yaml/yml
//      before matter() is called at all.
//   2. SAFE_MATTER_OPTIONS replaces the `javascript`/`js` engines with ones
//      that throw, so no eval happens even if guard (1) is ever bypassed.
// Only YAML frontmatter is a valid skill (ADR-0006), so this loses nothing.
// Matches exactly `---` (gray-matter's delimiter), not `---+`: the greedy
// `---+` shared a `-` with the `[^\r\n]*` capture, giving O(n^2) backtracking
// on a long dash run (a ~1 MB dash file hung validate() for minutes). Exactly
// three dashes is also gray-matter's real behavior — it early-returns when the
// 4th char is another dash — so this is stricter-or-equal, never looser.
const FENCE_LANGUAGE = /^\uFEFF?---([^\r\n]*)(?:\r?\n|$)/;

function refuseNonYaml(): never {
  throw new Error('non-YAML frontmatter engine is disabled');
}

const refuseEngine = { parse: refuseNonYaml, stringify: refuseNonYaml };

export const SAFE_MATTER_OPTIONS = {
  engines: { javascript: refuseEngine, js: refuseEngine },
} as const;

export function hasUnsafeFenceLanguage(raw: string): boolean {
  const match = FENCE_LANGUAGE.exec(raw);
  if (match === null) return false;
  const language = (match[1] ?? '').trim();
  return language !== '' && !/^ya?ml$/i.test(language);
}
