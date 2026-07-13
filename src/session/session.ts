import { randomUUID } from 'node:crypto';

import type { TaskDescriptor } from '../router/index.js';
import type { Skill } from '../skills/index.js';
import type { TelemetryEventInput } from '../telemetry/index.js';
import type {
  DeniedToolCall,
  SdkAssistantMessage,
  SdkHookCallback,
  SdkMessage,
  SdkResultMessage,
  SdkSystemMessage,
  SdkTextBlock,
  Session,
  SessionConfig,
  SessionDeps,
  SessionResult,
} from './types.js';
import { sanitizeControlChars as sanitizeText } from '../internal/sanitize.js';

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

function buildSystemPrompt(skills: Skill[]): string | undefined {
  if (skills.length === 0) return undefined;
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return ['You have the following harness skills available:', ...lines].join('\n');
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
          systemPrompt: buildSystemPrompt(loadResult.skills),
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
        } else if (isAssistant(message)) {
          for (const text of assistantText(message)) {
            config.onText?.(text);
          }
        } else if (isResult(message)) {
          if (message.session_id) sdkSessionId = message.session_id;
          resultText = message.result ?? null;
          resultSubtype = message.subtype ?? null;
          usage = message.usage ?? null;
          costUsd = message.total_cost_usd ?? null;
          numTurns = message.num_turns ?? null;
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
      sessionId,
      modelChoice,
      usage,
      costUsd,
      numTurns,
      denied,
      memoryEntryId,
      skillErrors: loadResult.errors,
    };
  }

  return { run };
}
