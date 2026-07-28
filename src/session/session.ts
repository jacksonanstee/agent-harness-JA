import { randomUUID } from 'node:crypto';

import type { TaskDescriptor } from '../router/index.js';
import type { Skill } from '../skills/index.js';
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
} from './types.js';
import {
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
// left (legit NFD accents); the injection scan below sees the RAW text, so
// nothing stripped here evades detection (issue #24 follow-up).
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
const STRIPPED_BEFORE_PROMPT_RULE_IDS: readonly string[] = ['unicode-tag-chars'];

/** True when a verdict should keep a skill out of the prompt. */
function blocksSkill(scan: ScanResult | null): boolean {
  // `ask` (medium confidence) never drops: too broad for a channel the
  // operator authored. Enforcement is high-confidence only.
  if (scan === null || scan.verdict !== 'block') return false;
  return scan.rule_ids.some((id) => !STRIPPED_BEFORE_PROMPT_RULE_IDS.includes(id));
}

function buildSystemPrompt(skills: Skill[]): {
  prompt: string | undefined;
  droppedSkills: DroppedSkill[];
} {
  if (skills.length === 0) return { prompt: undefined, droppedSkills: [] };
  // The body IS the skill (ADR-0006: "This is what the agent reads when the
  // skill is loaded") — inject it whole, not just the name/description line.
  // Same charset contract as the header: control/bidi/invisible chars are
  // stripped; the injection scan runs on the RAW body before this.
  const sections: string[] = [];
  const droppedSkills: DroppedSkill[] = [];
  let remaining = MAX_SKILL_PROMPT_CHARS;
  for (const skill of skills) {
    const name = cleanSkillText(skill.name);
    const header = `## Skill: ${name}\n${cleanSkillText(skill.description)}`;
    const body = cleanSkillText(skill.body).trim();
    const section = body === '' ? header : `${header}\n\n${body}`;
    // A later, smaller skill may still fit after an oversized one is dropped:
    // inclusion is per-skill against the remaining budget, in load order.
    // +2 counts the `\n\n` join separator, so the cap is exact, not soft —
    // otherwise ~20k minimal skills overrun the budget ~15% via separators.
    if (section.length + 2 > remaining) {
      droppedSkills.push({ name, path: skill.path, reason: 'prompt-budget', ruleIds: [] });
      continue;
    }
    remaining -= section.length + 2;
    sections.push(section);
  }
  if (sections.length === 0) return { prompt: undefined, droppedSkills };
  return {
    prompt: ['You have the following harness skills available:', ...sections].join('\n\n'),
    droppedSkills,
  };
}

/**
 * Wires router, skills, hooks, and memory into one Claude Agent SDK session
 * (architecture data-flow steps 2, 3, 4, 5-14, 15). The SDK `query` function
 * is injected so tests never touch the network.
 */
export function createSession(deps: SessionDeps, config: SessionConfig): Session {
  const now = config.now ?? Date.now;
  const generateId = config.generateId ?? randomUUID;
  const warn = config.onWarning ?? (() => undefined);

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
    // invisible chars (not combining marks — see cleanSkillText); the scan
    // runs on the raw text first, so stripping cannot hide anything from it.
    //
    // ENFORCED, not observe-only (ADR-0026), unlike tool results: R-4's
    // rationale is that no SDK result-rewrite channel exists, but the harness
    // assembles this prompt itself, so refusing to inject is implementable
    // here. A high-confidence block on EITHER channel drops the whole skill —
    // description as well as body, because otherwise the payload just moves
    // to the description, which lands at the same authority.
    const injectableSkills: Skill[] = [];
    const blockedSkills: DroppedSkill[] = [];
    for (const skill of loadResult.skills) {
      const label = cleanSkillText(skill.name);
      const description = scanSkillChannel(`skill "${label}" description`, skill.description);
      const body = scanSkillChannel(`skill "${label}" body`, skill.body);
      const blocking = [
        ...(blocksSkill(description) ? [{ channel: 'description', scan: description }] : []),
        ...(blocksSkill(body) ? [{ channel: 'body', scan: body }] : []),
      ];
      if (blocking.length === 0) {
        injectableSkills.push(skill);
        continue;
      }
      blockedSkills.push({
        name: label,
        path: skill.path,
        reason: 'injection-block',
        // Deduped across channels: the same rule firing on both is one reason.
        ruleIds: [...new Set(blocking.flatMap((b) => b.scan?.rule_ids ?? []))],
      });
      warn(
        `skill "${label}" (${sanitizeText(skill.path)}) dropped from the system prompt: ` +
          `injection scan blocked its ${blocking.map((b) => b.channel).join(' and ')} ` +
          `(rules: ${[...new Set(blocking.flatMap((b) => b.scan?.rule_ids ?? []))].map(sanitizeText).join(', ')}). ` +
          `Edit the skill file to remove the flagged content if this is a false positive.`,
      );
    }

    const harnessSessionId = generateId();
    // Fallback deliberately does NOT reuse generateId: a caller injecting a
    // constant generateId (as the CLI does) would otherwise collapse
    // turnId === sessionId and destroy trace correlation.
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
      return (runInjectionScan(label, text) as ScanResult | null) ?? null;
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

    // Only the skills that survived the injection gate are offered to the
    // budget pass, so the two drop reasons stay distinct and a blocked skill
    // never consumes budget a legitimate one could have used.
    const { prompt: systemPrompt, droppedSkills: budgetDropped } =
      buildSystemPrompt(injectableSkills);
    for (const dropped of budgetDropped) {
      warn(
        `skill "${dropped.name}" (${sanitizeText(dropped.path)}) dropped from the system ` +
          `prompt: aggregate skill budget (${MAX_SKILL_PROMPT_CHARS} chars) exceeded`,
      );
    }
    const droppedSkills: DroppedSkill[] = [...blockedSkills, ...budgetDropped];

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
