import { randomUUID } from 'node:crypto';

import type { TaskDescriptor } from '../router/index.js';
import type { Skill } from '../skills/index.js';
import {
  boundSkillDropName,
  boundSkillDropPath,
  assertValidCorrelationId,
  SKILL_DROP_RULE_ID_MAX,
  SKILL_DROP_RULE_IDS_MAX,
} from '../telemetry/index.js';
import type { TelemetryEventInput } from '../telemetry/index.js';
import type { ScanResult } from '../security/index.js';
import type {
  DeniedToolCall,
  DroppedSkill,
  SdkAssistantMessage,
  SdkHookCallback,
  SdkMessage,
  SdkModelRefusalMessage,
  SdkResultMessage,
  SdkSystemMessage,
  SdkTextBlock,
  Session,
  SessionConfig,
  SessionDeps,
  SessionRefusal,
  SessionResult,
  SkillDropChannel,
} from './types.js';
import {
  escapePathUnsafe,
  sanitizeControlChars,
  stripBidi,
  stripInvisibles,
  truncateWellFormed,
} from '../internal/sanitize.js';

// Alias: keeps the ~10 pre-existing call sites unchanged after the
// internal/ hoist; charset contract (C0/C1 only) is identical.
const sanitizeText = sanitizeControlChars;

// Skill name/description are attacker-influenced (a hostile skill pack is in
// the threat model) and flow into the system prompt and warnings — strip
// control chars, bidi overrides, and invisible smuggling chars (zero-width/
// tag/variation-selector) at this boundary. Combining marks are deliberately
// left (legit NFD accents). The injection scan sees the RAW text, so nothing
// stripped here evades detection (issue #24 follow-up) — but note that is only
// true in the HIDING direction. Stripping substitutes SPACES, so it can also
// CREATE a payload the raw scan never saw; that is why the enforcement pass
// scans the assembled, cleaned section too (ADR-0026, skillSection).
function cleanSkillText(text: string): string {
  return stripInvisibles(stripBidi(sanitizeControlChars(text)));
}

const DEFAULT_DESCRIPTOR: TaskDescriptor = {
  shape: 'build',
  sensitivity: 'low',
  expected_tokens: 4000,
};

/** Session-summary entries decay; telemetry (Week 2) owns durable metrics. */
const SUMMARY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Cap on prompt/result text persisted in the session summary. */
const SUMMARY_TEXT_LIMIT = 200;

/** Telemetry sentinel when the secret redactor throws (fail-closed — never raw). */
const REDACTION_FAILED = '[REDACTION FAILED]';


function truncate(value: string | null): string | null {
  if (value === null) return null;
  const clean = sanitizeText(value);
  return clean.length > SUMMARY_TEXT_LIMIT ? `${clean.slice(0, SUMMARY_TEXT_LIMIT)}…` : clean;
}

function isSystemInit(message: SdkMessage): message is SdkSystemMessage {
  return message.type === 'system' && (message as SdkSystemMessage).subtype === 'init';
}

function isAssistant(message: SdkMessage): message is SdkAssistantMessage {
  return message.type === 'assistant';
}

function isResult(message: SdkMessage): message is SdkResultMessage {
  return message.type === 'result';
}

/**
 * The SDK's refusal banners (ADR-0025). Absent from older CLIs, hence the
 * second channel.
 *
 * Declared as an exhaustive record keyed by the message's own `subtype` union,
 * NOT as a `ReadonlySet<...subtype>`. The set form looks like it pins the two
 * declarations together but does not: method-parameter bivariance makes
 * `Set<'a'|'b'>` assignable to `ReadonlySet<'a'|'b'|'c'>`, so widening the union
 * and forgetting the runtime gate compiles clean (verified with tsc), which is
 * precisely the silent-detection-gap direction that matters. A keyed record
 * fails both ways: a new union member is a missing-property error, and a
 * removed one is an excess-property error. The Set is derived from its keys so
 * there is one source of truth and `has()` stays prototype-safe.
 */
const REFUSAL_SUBTYPE_GATE: Record<SdkModelRefusalMessage['subtype'], true> = {
  model_refusal_no_fallback: true,
  model_refusal_fallback: true,
};

const REFUSAL_SUBTYPES: ReadonlySet<string> = new Set(Object.keys(REFUSAL_SUBTYPE_GATE));

function isModelRefusal(message: SdkMessage): message is SdkModelRefusalMessage {
  return (
    message.type === 'system' &&
    REFUSAL_SUBTYPES.has((message as SdkModelRefusalMessage).subtype)
  );
}

/**
 * Cap on a short SDK-supplied token before it reaches a retained sink. The SDK
 * calls both `api_refusal_category` and `stop_reason` open strings ("new
 * categories ship on the wire ahead of schema updates"), so nothing in the
 * contract bounds either to a short token, and every other persisted string in
 * this module is bounded.
 */
const SDK_TOKEN_LIMIT = 100;

/**
 * Cleans a short SDK token (`api_refusal_category`, `fallback_model`,
 * `stop_reason`). Same charset contract as `cleanSkillText`, for the same
 * reason: these values reach a terminal line whose whole job is to tell an
 * operator that a DIFFERENT model answered their turn, so a bidi override that
 * visually reorders a model name defeats the one guarantee the line makes.
 * Control chars alone are not enough (review finding, empirically
 * demonstrated: U+202E survived `sanitizeControlChars` and
 * `sanitizeForTerminal` all the way to stderr). Bounded too, because an open
 * string reaching two retained sinks needs a cap.
 *
 * NOT for prose: `truncate` (200 chars, redacted first) owns `resultText` and
 * `prompt`. This is for short vendor tokens only.
 */
function cleanSdkToken(text: string): string {
  // Trimmed because stripping substitutes SPACES: without it, `stop_reason`
  // values like "refusal<U+202E>" clean to "refusal " and silently miss the
  // === 'refusal' comparison, so a single trailing smuggled char disabled the
  // whole second detection channel (verify-pass finding). Also kills the
  // leading-space variant.
  // Internal whitespace collapses to '_': none of these tokens legitimately
  // contains a space ('cyber', 'claude-sonnet-5', 'end_turn'), and the two
  // `[harness]` lines are space-delimited `key=value` pairs, so a space-bearing
  // token could forge a sibling field. Quoting at the sink is belt-and-braces;
  // this closes it even for a naive `grep -o 'fallback=[^ ]*'` (verify-pass
  // finding). Runs after the strip pass, which itself substitutes spaces.
  const clean = stripInvisibles(stripBidi(sanitizeControlChars(text)))
    .trim()
    .replace(/\s+/g, '_');
  // Well-formed: a naive slice can emit a lone surrogate, and these values
  // reach a public API field.
  return truncateWellFormed(clean, SDK_TOKEN_LIMIT);
}

/**
 * Reads a banner into the surfaced shape. The category and the fallback model
 * are sanitized HERE, at capture, so every downstream sink (result, memory,
 * telemetry, terminal) inherits a clean value rather than each re-deriving it.
 *
 * The banner's `content` field (and `api_refusal_explanation`) are deliberately
 * never read: both are model-authored prose, and capturing either would open a
 * new untrusted-prose channel into two retained sinks (ADR-0025 decision 2).
 */
function refusalFromBanner(message: SdkModelRefusalMessage): SessionRefusal {
  const category =
    typeof message.api_refusal_category === 'string'
      ? cleanSdkToken(message.api_refusal_category)
      : null;
  const fallbackModel =
    message.subtype === 'model_refusal_fallback' && typeof message.fallback_model === 'string'
      ? cleanSdkToken(message.fallback_model)
      : null;
  return { source: 'system-event', category, fallbackModel };
}

function assistantText(message: SdkAssistantMessage): string[] {
  const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
  return blocks
    .filter(
      (block): block is SdkTextBlock =>
        typeof block === 'object' &&
        block !== null &&
        (block as SdkTextBlock).type === 'text' &&
        typeof (block as SdkTextBlock).text === 'string',
    )
    .map((block) => block.text);
}

/**
 * Aggregate budget for skill content injected into the system prompt. The
 * loader's 1 MB cap is per FILE (memory safety); without an aggregate bound a
 * malicious skill pack (many schema-valid files with large bodies) turns
 * every session turn into a context/cost blowup. Whole-skill granularity: an
 * over-budget skill is dropped and warned about, never truncated mid-body —
 * a half-injected skill is worse than an absent one.
 */
const MAX_SKILL_PROMPT_CHARS = 256_000;

/**
 * Hidden-unicode rule that does NOT justify dropping a skill (ADR-0026).
 * `cleanSkillText` already strips tag characters before this sink, so a
 * block whose ONLY hit is this rule would refuse a skill over characters
 * that could never reach the model — pure false-positive cost for zero
 * marginal benefit. Nothing is lost: the scanner strips and rescans, so tag
 * chars concealing a real payload still fire that payload's plaintext rule,
 * and the block then stands on that rule instead.
 */
const STRIPPED_BEFORE_PROMPT_RULE_IDS: readonly string[] = ['unicode-tag-chars', 'zero-width-run'];

/** True when a verdict should keep a skill out of the prompt. */
function blocksSkill(scan: ScanResult | null): boolean {
  // `ask` (medium confidence) never drops: too broad for a channel the
  // operator authored. Enforcement is high-confidence only.
  if (scan === null || scan.verdict !== 'block') return false;
  // An explicit block with NO rule ids fails CLOSED. `[].some()` is false, so
  // the carve-out below would otherwise read "every blocking rule is stripped"
  // and inject a skill the scanner just blocked. Unreachable from the shipped
  // scan() (a block always carries the hit that caused it) but `scanInjection`
  // is arbitrary caller code, and ADR-0016's judge is an obvious future source
  // of a rule-id-less block.
  if (scan.rule_ids.length === 0) return true;
  return scan.rule_ids.some((id) => !STRIPPED_BEFORE_PROMPT_RULE_IDS.includes(id));
}

/**
 * The exact text a skill contributes to the system prompt.
 *
 * Extracted so enforcement scans the string that is actually INJECTED, not
 * merely the raw source. Those differ: cleanSkillText maps C0/C1 and bidi
 * characters to SPACES, which does not only fail to hide a payload — it can
 * CREATE one. `ignore<0x01>all previous instructions` matches no rule raw
 * (\s does not match 0x01), and becomes a clean `ignore all previous
 * instructions` in the prompt. Scanning raw text alone is therefore blind to
 * a one-byte bypass, and scanning only the cleaned text would be blind to
 * smuggling the cleaner removes. Both are scanned; see ADR-0026.
 *
 * Scanning the assembled section also covers two channels a per-field scan
 * misses: `name`, which lands at column 0 as `## Skill: <name>`, and a phrase
 * split across fields (rules join on \s+, which matches the newlines between
 * header, description and body).
 */
function skillSection(skill: Skill): { name: string; section: string } {
  const name = cleanSkillText(skill.name);
  const header = `## Skill: ${name}\n${cleanSkillText(skill.description)}`;
  const body = cleanSkillText(skill.body).trim();
  return { name, section: body === '' ? header : `${header}\n\n${body}` };
}

/**
 * Exhaustive BY CONSTRUCTION over SkillDropChannel — the EVENT_TYPE_PRESENCE
 * idiom (src/telemetry/store.ts), generalised from a `true` marker to the
 * accessor that yields the text each channel scans. The array literal this
 * replaced was MEMBERSHIP-typed: widening SkillDropChannel and forgetting the
 * literal compiled clean, and the new channel was then never scanned — a
 * silent hole in an ENFORCED control (ADR-0026), with a green suite. A
 * missing key here is now a compile error.
 *
 * Key ORDER is load-bearing, not cosmetic: it is the order channels are
 * scanned in, the order they appear in DroppedSkill.channels, and the order
 * the drop warning joins them in ("... its body and assembled section").
 * Pinned by session.test.ts.
 *
 * Accessors stay EAGER — every channel is scanned for every skill and the
 * results are filtered afterwards. Do not short-circuit on the first blocking
 * channel: DroppedSkill.channels is meant to name every channel that blocked.
 */
const SKILL_DROP_CHANNEL_TEXT: Record<SkillDropChannel, (skill: Skill) => string> = {
  description: (skill) => skill.description,
  body: (skill) => skill.body,
  'assembled section': (skill) => skillSection(skill).section,
};

/**
 * The channel list, DERIVED — never hand-written. Its length is the union's
 * cardinality, which telemetry hand-copies as SKILL_DROP_CHANNELS_MAX
 * (src/telemetry/types.ts). Layering forbids telemetry importing session, so
 * nothing can derive one from the other and the two can only be compared from
 * this side; session.test.ts re-derives the equality.
 */
export const SKILL_DROP_CHANNELS = Object.keys(
  SKILL_DROP_CHANNEL_TEXT,
) as readonly SkillDropChannel[];

/**
 * Internal pairing of a drop with the RAW path it came from (issue #54).
 *
 * `DroppedSkill.path` is escaped, and the telemetry digest must NOT be taken
 * over that form: `escapePathUnsafe`'s target set derives from
 * `\p{Default_Ignorable_Code_Point}`, a Unicode-version-dependent property, so
 * an ICU upgrade or a deliberate charset widening silently re-keys every digest
 * ever written. The digest exists to answer "are these two truncated rows the
 * same file?", and across such a change it would start answering NO for exactly
 * the invisible-character-bearing hostile paths it was built for.
 *
 * Deliberately NOT a field on `DroppedSkill`: that type is public
 * (SessionResult.droppedSkills), the raw path is attacker-authored, and putting
 * an unescaped hostile string back onto the programmatic surface would undo
 * what escaping it was for. It stays internal to this module, paired by the
 * compiler rather than by a lookup that could miss.
 */
interface DropRecord {
  skill: DroppedSkill;
  rawPath: string;
}

function buildSystemPrompt(skills: Skill[]): {
  prompt: string | undefined;
  dropped: DropRecord[];
} {
  if (skills.length === 0) return { prompt: undefined, dropped: [] };
  // The body IS the skill (ADR-0006: "This is what the agent reads when the
  // skill is loaded") — inject it whole, not just the name/description line.
  // Same charset contract as the header: control/bidi/invisible chars are
  // stripped; the injection scan runs on the RAW body before this.
  const sections: string[] = [];
  const dropped: DropRecord[] = [];
  let remaining = MAX_SKILL_PROMPT_CHARS;
  for (const skill of skills) {
    // Same helper the enforcement pass scans, so the gated string and the
    // injected string can never drift apart.
    const { name, section } = skillSection(skill);
    // A later, smaller skill may still fit after an oversized one is dropped:
    // inclusion is per-skill against the remaining budget, in load order.
    // +2 counts the `\n\n` join separator, so the cap is exact, not soft —
    // otherwise ~20k minimal skills overrun the budget ~15% via separators.
    if (section.length + 2 > remaining) {
      // ESCAPED, not cleaned like `name` above — see escapePathUnsafe's doc
      // comment (src/internal/sanitize.ts) and DroppedSkill.path's (deleting
      // an invisible character here would misdirect an operator to a
      // byte-identical benign twin, since skill names are not unique).
      const { value: path, escaped: pathHasEscapes } = escapePathUnsafe(skill.path);
      dropped.push({
        skill: {
          name,
          path,
          pathHasEscapes,
          reason: 'prompt-budget',
          channels: [],
          ruleIds: [],
        },
        rawPath: skill.path,
      });
      continue;
    }
    remaining -= section.length + 2;
    sections.push(section);
  }
  if (sections.length === 0) return { prompt: undefined, dropped };
  return {
    prompt: ['You have the following harness skills available:', ...sections].join('\n\n'),
    dropped,
  };
}

/**
 * Wires router, skills, hooks, and memory into one Claude Agent SDK session
 * (architecture data-flow steps 2, 3, 4, 5-14, 15). The SDK `query` function
 * is injected so tests never touch the network.
 */
/**
 * Issue #51. The telemetry store refuses a malformed correlation id, but
 * `recordTelemetry` below catches that throw and downgrades it to one stderr
 * warning, so a caller whose id scheme is rejected would lose every row of the
 * run and get only a warning per row, which is the silent-loss failure mode
 * this codebase keeps rediscovering. Checking here converts it into a loud
 * failure at the earliest point each id exists: `config.turnId` at
 * construction, `generateId()`'s output on the first call that produces one.
 *
 * `assertValidCorrelationId` is IMPORTED, never re-implemented, and it carries
 * the message as well as the rule. Two copies of either would drift, and the
 * drift would be invisible in the dangerous direction: if this side were
 * looser, the store's rejection is the one that gets swallowed.
 */
export function createSession(deps: SessionDeps, config: SessionConfig): Session {
  const now = config.now ?? Date.now;
  const generateId = config.generateId ?? randomUUID;
  const warn = config.onWarning ?? (() => undefined);
  if (config.turnId !== undefined) assertValidCorrelationId(config.turnId, 'config.turnId');

  async function run(prompt: string): Promise<SessionResult> {
    // Step 2: model selection.
    const descriptor = config.descriptor ?? DEFAULT_DESCRIPTOR;
    const modelChoice = deps.route(descriptor);

    // Step 3: skills. A null skillsDir means "no skills" — skip the load
    // entirely (golden eval passes null for a defaulted-and-absent skills
    // dir, so a task with no skills doesn't warn on every run).
    const loadResult = config.skillsDir === null
      ? { skills: [], errors: [] }
      : deps.loadSkills(config.skillsDir);
    for (const error of loadResult.errors) {
      warn(`skill load ${error.kind} error in ${error.file}: ${error.message}`);
    }
    // Skill descriptions and bodies enter the system prompt at system-prompt
    // authority (buildSystemPrompt), so scan them like any other untrusted
    // channel (ASI06 context-poisoning path that previously bypassed the
    // scanner entirely). buildSystemPrompt independently strips control/bidi/
    // invisible chars (not combining marks — see cleanSkillText); the scan runs
    // on the raw text first, so stripping cannot HIDE anything from it, and on
    // the assembled cleaned section, so stripping cannot CREATE anything either.
    //
    // ENFORCED, not observe-only (ADR-0026), unlike tool results: R-4's
    // rationale is that no SDK result-rewrite channel exists, but the harness
    // assembles this prompt itself, so refusing to inject is implementable
    // here. A high-confidence block on EITHER channel drops the whole skill —
    // description as well as body, because otherwise the payload just moves
    // to the description, which lands at the same authority.
    const injectableSkills: Skill[] = [];
    const blockedRecords: DropRecord[] = [];
    for (const skill of loadResult.skills) {
      const label = cleanSkillText(skill.name);
      // RAW scans catch what the cleaner would remove (smuggling). The
      // ASSEMBLED scan catches what the cleaner would create (space-splicing),
      // plus the name channel and phrases split across fields. Neither alone
      // is sufficient — see skillSection's comment and ADR-0026.
      // The scan LABEL is derived from the channel name so the two cannot
      // drift; today's three labels are already exactly `skill "<name>"
      // <channel>`. It reaches the operator via runInjectionScan's
      // "injection scan <verdict> on <label> output" warning.
      const channels: { channel: SkillDropChannel; scan: ScanResult | null }[] =
        SKILL_DROP_CHANNELS.map((channel) => ({
          channel,
          scan: scanSkillChannel(`skill "${label}" ${channel}`, SKILL_DROP_CHANNEL_TEXT[channel](skill)),
        }));
      const blocking = channels.filter((c) => blocksSkill(c.scan));
      if (blocking.length === 0) {
        injectableSkills.push(skill);
        continue;
      }
      // Deduped across channels: the same rule firing on more than one is one
      // reason, not three. Cleaned (deleted, not escaped) with cleanSkillText:
      // `scanInjection` is caller-supplied (SessionDeps), not the shipped
      // rule table, so a rule id is untrusted the same way a path or name is
      // — but unlike `path`, a rule id identifies nothing on disk, so
      // deletion loses nothing worth keeping.
      const ruleIds = [...new Set(blocking.flatMap((b) => b.scan?.rule_ids ?? []))].map(cleanSkillText);
      // ESCAPED, not cleaned: deleting an invisible character here would
      // misdirect an operator to a byte-identical benign twin, since skill
      // names are not unique (escapePathUnsafe's doc comment, src/internal/
      // sanitize.ts; DroppedSkill.path's, round-1 fix issue #46 Finding 1).
      const { value: safePath, escaped: pathHasEscapes } = escapePathUnsafe(skill.path);
      blockedRecords.push({
        skill: {
          name: label,
          path: safePath,
          pathHasEscapes,
          reason: 'injection-block',
          channels: blocking.map((b) => b.channel),
          ruleIds,
        },
        rawPath: skill.path,
      });
      warn(
        `skill "${label}" (${safePath}) dropped from the system prompt: ` +
          `injection scan blocked its ${blocking.map((b) => b.channel).join(' and ')} ` +
          `(rules: ${ruleIds.map(sanitizeText).join(', ')}). ` +
          `Edit the skill file to remove the flagged content if this is a false positive.`,
      );
    }

    const harnessSessionId = assertValidCorrelationId(generateId(), 'generateId() result');
    // Fallback deliberately does NOT reuse generateId: a caller injecting a
    // constant generateId (as the CLI does) would otherwise collapse
    // turnId === sessionId and destroy trace correlation.
    // Not re-checked: config.turnId was validated at construction and
    // randomUUID is well-formed by construction.
    const turnId = config.turnId ?? randomUUID();
    let sdkSessionId: string | null = null;
    const denied: DeniedToolCall[] = [];

    // Telemetry is observability, never control flow: a failing or throwing
    // recorder downgrades to a warning and the run continues.
    function recordTelemetry(event: TelemetryEventInput): void {
      if (deps.telemetry === undefined) return;
      try {
        const result = deps.telemetry.record(event);
        if (!result.ok) {
          warn(`telemetry record failed: ${sanitizeText(result.error.message)}`);
        }
      } catch (error: unknown) {
        warn(
          `telemetry record threw: ${error instanceof Error ? sanitizeText(error.message) : 'unknown'}`,
        );
      }
    }

    // Placed ABOVE the session-start fire deliberately (issue #46). Two
    // reasons: `deps.hooks.fire('session-start')` below is NOT try/caught
    // (unlike the pre-tool fire), so an injected runtime that throws would
    // otherwise lose every drop record; and recording here makes skill-drop
    // rows sort BEFORE the session-start row under the store's default
    // `ORDER BY ts ASC`, which is a truthful trace rather than an excused one.
    // Consequence to keep in mind: operator-visible stderr ordering changed —
    // budget-drop warnings now precede session-start hook-error warnings.
    //
    // Only the skills that survived the injection gate are offered to the
    // budget pass, so the two drop reasons stay distinct and a blocked skill
    // never consumes budget a legitimate one could have used.
    const { prompt: systemPrompt, dropped: budgetRecords } =
      buildSystemPrompt(injectableSkills);
    for (const record of budgetRecords) {
      warn(
        `skill "${record.skill.name}" (${record.skill.path}) dropped from the system ` +
          `prompt: aggregate skill budget (${MAX_SKILL_PROMPT_CHARS} chars) exceeded`,
      );
    }
    const dropRecords: DropRecord[] = [...blockedRecords, ...budgetRecords];
    const droppedSkills: DroppedSkill[] = dropRecords.map((r) => r.skill);

    // Iterates the records whose `.skill` values ARE the elements of the array
    // returned as SessionResult.droppedSkills (same object identities, see the
    // map above), so the durable record and the programmatic surface cannot
    // drift. The record also carries the RAW path, which the digest needs and
    // the public type deliberately does not expose (issue #54, DropRecord).
    //
    // The payload is a bounded PROJECTION of that array, not a copy: the
    // name/path/ruleIds fields are capped because a malicious cloned repo is
    // in scope (security-model) and this sink is durable and exportable.
    //
    // `name` and `path` go through the telemetry helpers, which own the cap
    // arithmetic AND the truncated-flag derivation. Do NOT hand-roll it here:
    // the caps are TOTAL stored length while the truncators bound CONTENT and
    // append an ellipsis, so passing a cap directly yields cap+1 units, fails
    // the store's read validator, throws in assertValidInput, and
    // recordTelemetry downgrades that to a warning — silently losing exactly
    // the oversized attacker-controlled rows this record exists to capture.
    const ruleIdBudget = SKILL_DROP_RULE_ID_MAX - 1;

    for (const record of dropRecords) {
      const dropped = record.skill;
      // TAIL-preserving: a path's disambiguating part is its filename.
      // `dropped.path` is already ESCAPED at capture by escapePathUnsafe —
      // escaped, NOT deleted, so the pre-image stays recoverable. That
      // satisfies the required TRANSFORM-then-TRUNCATE order: truncating first
      // would let an attacker spend the whole budget on characters a later
      // transform rewrites, blanking their own audit row.
      const boundedPath = boundSkillDropPath(dropped.path, record.rawPath);
      recordTelemetry({
        type: 'skill-drop',
        sessionId: harnessSessionId,
        turnId,
        payload: {
          name: boundSkillDropName(dropped.name),
          path: boundedPath.value,
          // Out-of-band, because the in-band ellipsis is attacker-forgeable,
          // and taken from the helper so it cannot disagree with `path`.
          pathTruncated: boundedPath.truncated,
          // Present only when the path WAS truncated, and taken from the same
          // call, so it can no more disagree with `path` than pathTruncated
          // can. Digests the FULL RAW path, not the escaped or truncated one:
          // two paths differing only before the tail-cut store identically and
          // this is what keeps them apart (issue #50), while taking the RAW
          // pre-image keeps the digest stable across ICU upgrades and escape
          // widenings that would otherwise silently re-key it (issue #54).
          // Never re-derive it from `boundedPath.value`.
          //
          // Conditional spread, not `pathDigest: boundedPath.digest`. The
          // latter sets an OWN property holding undefined, which contradicts
          // the "absent means nothing was discarded" contract for anyone
          // inspecting the payload before it is serialised. JSON.stringify
          // happens to drop it either way, so this is about the in-memory
          // object telling the same truth as the stored row.
          ...(boundedPath.digest === undefined ? {} : { pathDigest: boundedPath.digest }),
          // Carried straight through from capture. It describes the RAW
          // PRE-IMAGE, so it deliberately survives a truncation that drops the
          // last escape token — do NOT re-derive it by scanning `path`.
          pathHasEscapes: dropped.pathHasEscapes,
          reason: dropped.reason,
          // NOT sliced, deliberately, and the asymmetry with ruleIds is the
          // point. `channels` is a CLOSED union whose cardinality the
          // session-side drift guards prove equal to SKILL_DROP_CHANNELS_MAX,
          // so an over-length array is unreachable unless that guard has
          // already failed. Slicing would silently write a row missing a
          // channel — hiding the very drift the guards exist to catch, and
          // contradicting the failure mode documented in types.ts on both
          // sides ("exceeds the cap, fails isSkillDropPayload, row gone, one
          // stderr warning"). Losing the row loudly beats keeping a quietly
          // incomplete one.
          // Passed through WHOLE: not sliced, not element-truncated. Unlike
          // ruleIds below, channels is harness-authored from a closed union,
          // so it is not attacker-influenced at all. Truncating an element
          // would silently rewrite a value while the count above deliberately
          // fails loud — two opposite philosophies on one field. Both halves
          // are guarded from the session side, the only side that lints:
          // cardinality by the drift guards, element length by the
          // `every channel name fits SKILL_DROP_CHANNEL_MAX` test.
          channels: [...dropped.channels],
          // Sliced, because these come from a CALLER-SUPPLIED scanner
          // (SessionDeps.scanInjection) and are bounded by nothing.
          ruleIds: dropped.ruleIds
            .slice(0, SKILL_DROP_RULE_IDS_MAX)
            .map((ruleId) => truncateWellFormed(ruleId, ruleIdBudget)),
        },
      });
    }

    function stringifyForScan(output: unknown): string {
      if (typeof output === 'string') return output;
      // Cycle-safe: a tool returning a live object with a circular reference
      // must not collapse to "[object Object]" and hide its payload from the
      // scanner. Drop repeated references rather than throwing.
      const seen = new WeakSet<object>();
      try {
        return (
          JSON.stringify(output, (_key, value: unknown) => {
            if (typeof value === 'object' && value !== null) {
              if (seen.has(value)) return '[Circular]';
              seen.add(value);
            }
            return value;
          }) ?? ''
        );
      } catch {
        return String(output);
      }
    }

    // Redacts secrets from already-stringified tool text. Returns the redacted
    // text + findings, or null when no redactor is injected (nothing to do).
    // On redactor failure the text is fail-closed to a sentinel so a raw
    // secret can never reach a downstream sink (telemetry/logs); findings are
    // structural (hook payload types them `unknown`, no hooks→security import).
    // Stringifies internally (symmetry with runInjectionScan) so callers never
    // double-stringify. Returns null when no redactor is injected (nothing to
    // do → caller uses the raw text); `{redacted: REDACTION_FAILED,
    // findings: null}` when the redactor throws — distinct states that
    // deliberately both surface as `redactions: null` on the hook payload
    // (which is typed `unknown`, so richer signalling isn't available there).
    function runSecretRedaction(
      tool: string,
      output: unknown,
    ): { redacted: string; findings: unknown } | null {
      if (deps.redactSecrets === undefined) return null;
      try {
        const result = deps.redactSecrets(stringifyForScan(output));
        if (result.findings.length > 0) {
          warn(`secrets redacted in ${tool} (${result.findings.length} finding(s))`);
        }
        return { redacted: result.redacted, findings: result.findings };
      } catch (error: unknown) {
        warn(
          `secret redaction failed: ${error instanceof Error ? sanitizeText(error.message) : 'unknown'}`,
        );
        return { redacted: REDACTION_FAILED, findings: null };
      }
    }

    // Redacts a plain string for a persistent sink (memory summary). Fail-
    // closed: on redactor error it returns the REDACTION_FAILED sentinel so a
    // secret can never persist. Absent redactor → raw (nothing configured).
    function redactForPersistence(value: string | null): string | null {
      if (value === null || deps.redactSecrets === undefined) return value;
      try {
        return deps.redactSecrets(value).redacted;
      } catch {
        return REDACTION_FAILED;
      }
    }

    // Scans the full tool output; returns the ScanResult (structural — the
    // hook payload types it `unknown` to avoid a hooks→security import) or
    // null when no scanner is injected. Never throws into the hot path.
    /**
     * Typed view of runInjectionScan for the skill channel, where the verdict
     * is acted on rather than merely warned about (ADR-0026).
     *
     * A null result means "no scanner injected" OR "the scanner threw", and
     * both fail OPEN — the skill is injected. Failing closed would let a
     * custom `scanInjection` that crashes on some input deny every skill,
     * and `scanInjection` is arbitrary caller-supplied code. The shipped
     * scan() is throw-hardened (safeMatch), so the residual is narrow and is
     * recorded in ADR-0026: a custom scanner that crashes on attacker-shaped
     * text evades enforcement, having already warned.
     */
    function scanSkillChannel(label: string, text: string): ScanResult | null {
      return runInjectionScan(label, text) as ScanResult | null;
    }

    function runInjectionScan(tool: string, output: unknown): unknown {
      if (deps.scanInjection === undefined) return null;
      try {
        const result = deps.scanInjection(stringifyForScan(output));
        if (result.verdict !== 'pass') {
          warn(
            `injection scan ${result.verdict} on ${tool} output ` +
              `(rules: ${result.rule_ids.map(sanitizeText).join(', ')})`,
          );
        }
        return result;
      } catch (error: unknown) {
        warn(
          `injection scan failed: ${error instanceof Error ? sanitizeText(error.message) : 'unknown'}`,
        );
        return null;
      }
    }

    // Steps 7 and 12: bridge SDK tool hooks onto the harness runtime.
    const preToolCallback: SdkHookCallback = async (input) => {
      const tool = sanitizeText(input.tool_name ?? 'unknown');
      // Step 11 (inputs): scan tool arguments for secrets. Observe-only — the
      // tool still receives the raw input (the SDK gives no rewrite channel);
      // findings ride the hook payload and warn. `input` may carry a secret an
      // attacker-influenced prior tool result told the model to pass along.
      const inputRedaction = runSecretRedaction(tool, input.tool_input);

      let deniedReason: string | null = null;
      try {
        const fireResult = await deps.hooks.fire('pre-tool', {
          event: 'pre-tool',
          tool,
          args: input.tool_input,
          redactions: inputRedaction?.findings ?? null,
        });
        if (fireResult.denied) deniedReason = fireResult.reason;
      } catch (error: unknown) {
        // fire() itself failing must fail closed, not SDK-defined. The reason
        // sent to the model is generic; the detail goes to warnings only.
        const detail = error instanceof Error ? sanitizeText(error.message) : 'unknown';
        warn(`pre-tool fire failed: ${detail}`);
        // The hook sink never saw this failure (it lives inside fire()), so
        // record it here — every failure path leaves a telemetry trace.
        recordTelemetry({
          type: 'hook-event',
          sessionId: harnessSessionId,
          turnId,
          payload: { kind: 'hook-error', event: 'pre-tool', reason: `fire failed: ${detail}` },
        });
        deniedReason = 'pre-tool hook failure';
      }
      if (deniedReason !== null) {
        denied.push({ tool, reason: deniedReason });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: deniedReason,
          },
        };
      }
      return {};
    };

    const postToolCallback: SdkHookCallback = async (input) => {
      const toolName = sanitizeText(input.tool_name ?? 'unknown');

      // Step 10: prompt-injection scan of the FULL raw tool output before it is
      // surfaced to the agent. S-1 observes + warns; model-facing enforcement
      // is deferred (ADR-0012/0013 — no SDK rewrite channel).
      const scan = runInjectionScan(toolName, input.tool_output);

      // Step 11: redact secrets. This runs BEFORE telemetry so a secret in the
      // tool output never reaches the (indefinitely-retained) telemetry store
      // (ADR-0011 retention finding). Telemetry sees the redacted text; on
      // redactor failure it sees a sentinel, never the raw output.
      const hasOutput = input.tool_output !== undefined && input.tool_output !== null;
      const redaction = hasOutput ? runSecretRedaction(toolName, input.tool_output) : null;
      const telemetryText = hasOutput
        ? (redaction?.redacted ?? stringifyForScan(input.tool_output))
        : null;
      recordTelemetry({
        type: 'tool-trace',
        sessionId: harnessSessionId,
        turnId,
        payload: {
          tool: toolName,
          phase: 'post-tool',
          resultSummary: telemetryText === null ? null : truncate(telemetryText),
        },
      });

      try {
        const fireResult = await deps.hooks.fire('post-tool', {
          event: 'post-tool',
          tool: toolName,
          result: input.tool_output,
          scan,
          redactions: redaction?.findings ?? null,
        });
        for (const error of fireResult.errors) {
          warn(`post-tool hook error: ${error.reason}`);
        }
      } catch (error: unknown) {
        warn(
          `post-tool fire failed: ${error instanceof Error ? sanitizeText(error.message) : 'unknown'}`,
        );
      }
      return {};
    };

    // Step 4: session-start fires before the SDK turn begins.
    const startResult = await deps.hooks.fire('session-start', {
      event: 'session-start',
      sessionId: harnessSessionId,
      startedAt: now(),
    });
    for (const error of startResult.errors) {
      warn(`session-start hook error: ${error.reason}`);
    }

    let resultText: string | null = null;
    let resultSubtype: string | null = null;
    let stopReason: string | null = null;
    let refusal: SessionRefusal | null = null;
    let usage: SessionResult['usage'] = null;
    let costUsd: number | null = null;
    let numTurns: number | null = null;
    let streamError: unknown = null;

    try {
      // Steps 5-14: the SDK turn.
      const stream = deps.query({
        prompt,
        options: {
          model: modelChoice.model,
          systemPrompt,
          maxTurns: config.maxTurns,
          hooks: {
            PreToolUse: [{ hooks: [preToolCallback] }],
            PostToolUse: [{ hooks: [postToolCallback] }],
          },
        },
      });

      for await (const message of stream) {
        if (isSystemInit(message) && message.session_id) {
          sdkSessionId = message.session_id;
        } else if (isModelRefusal(message)) {
          // Later banner wins: a turn that falls back and then refuses again
          // must report the terminal truth, not the intermediate swap.
          refusal = refusalFromBanner(message);
          warn(
            refusal.fallbackModel === null
              ? `model refusal (category=${refusal.category ?? 'unknown'}): no fallback model ` +
                `configured, so the turn ended without an answer`
              : `model refusal (category=${refusal.category ?? 'unknown'}): retried on fallback ` +
                `model ${refusal.fallbackModel}, which is NOT the routed model ${modelChoice.model}`,
          );
        } else if (isAssistant(message)) {
          for (const text of assistantText(message)) {
            config.onText?.(text);
          }
        } else if (isResult(message)) {
          if (message.session_id) sdkSessionId = message.session_id;
          resultText = message.result ?? null;
          resultSubtype = message.subtype ?? null;
          // Cleaned and bounded like the banner tokens: `stop_reason` is an
          // equally open SDK string reaching the same three sinks (result,
          // memory summary, telemetry) plus the terminal, so leaving it raw
          // while bounding its siblings would be an inconsistency, not a
          // considered exception. Cleaning happens BEFORE the comparison
          // below, deliberately: 'refu<ZWSP>sal' collapses to 'refusal' and is
          // detected, which is the fail-loud direction.
          stopReason =
            typeof message.stop_reason === 'string' ? cleanSdkToken(message.stop_reason) : null;
          usage = message.usage ?? null;
          costUsd = message.total_cost_usd ?? null;
          numTurns = message.num_turns ?? null;
          // Second, independent channel: works on CLIs old enough to omit the
          // banner. Never downgrades a banner record, which carries strictly
          // more (category, fallback model).
          if (stopReason === 'refusal' && refusal === null) {
            refusal = { source: 'result-stop-reason', category: null, fallbackModel: null };
            warn('model refused the turn (stop_reason=refusal; no refusal banner on this stream)');
          }
        }
      }
    } catch (error: unknown) {
      streamError = error;
    } finally {
      // Step 15: stop fires even when the stream throws.
      const sessionId = sdkSessionId ?? harnessSessionId;
      const stopResult = await deps.hooks.fire('stop', {
        event: 'stop',
        sessionId,
        stoppedAt: now(),
      });
      for (const error of stopResult.errors) {
        warn(`stop hook error: ${error.reason}`);
      }
    }

    const sessionId = sdkSessionId ?? harnessSessionId;

    // Durable metrics (ADR-0004/0011): one turn-cost event per run, on the
    // error path too so failed runs leave a costed trace. Keyed on the harness
    // session id so hook-sink events correlate; the SDK id rides in the payload.
    recordTelemetry({
      type: 'turn-cost',
      sessionId: harnessSessionId,
      turnId,
      payload: {
        model: modelChoice.model,
        ruleId: modelChoice.rule_id,
        costUsd,
        numTurns,
        usage:
          usage === null
            ? null
            : {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
                cacheReadInputTokens: usage.cache_read_input_tokens ?? null,
              },
        sdkSessionId,
        resultSubtype,
        stopReason,
        refusalSource: refusal?.source ?? null,
        refusalCategory: refusal?.category ?? null,
        refusalFallbackModel: refusal?.fallbackModel ?? null,
      },
    });

    // Week-1 checkpoint: persist at least one memory entry per session — on
    // the error path too, so failed runs leave a trace. Content is truncated
    // and control-char-sanitized; cost/usage metrics live in telemetry
    // (ADR-0004), not memory, so they are not persisted here.
    //
    // Redact secrets BEFORE truncation: memory is a second retained sink (30d
    // TTL), and because S-2 is observe-only the model can echo a tool-read
    // secret into `resultText`, or the user can paste one into `prompt`
    // (ADR-0013). Redact-then-truncate so a marker, not a secret fragment,
    // survives the cut.
    let memoryEntryId: string | null = null;
    const writeResult = deps.memory.write({
      id: `session-${sessionId}`,
      type: 'project',
      key: 'session-summary',
      tags: ['session'],
      staleAfter: now() + SUMMARY_TTL_MS,
      content: JSON.stringify({
        prompt: truncate(redactForPersistence(prompt)),
        model: modelChoice.model,
        rule_id: modelChoice.rule_id,
        resultSubtype,
        stopReason,
        // Already sanitized at capture; no redaction pass needed because these
        // are short vendor-supplied tokens, not model or tool prose.
        refusal,
        resultText: truncate(redactForPersistence(resultText)),
        denied,
        failed: streamError !== null,
      }),
    });
    if (writeResult.ok) {
      memoryEntryId = writeResult.value.id;
    } else {
      warn(`memory write failed: ${writeResult.error.message}`);
    }

    if (streamError !== null) throw streamError;

    return {
      resultText,
      resultSubtype,
      stopReason,
      refusal,
      sessionId,
      modelChoice,
      usage,
      costUsd,
      numTurns,
      denied,
      memoryEntryId,
      skillErrors: loadResult.errors,
      droppedSkills,
    };
  }

  return { run };
}
