import { describe, it, expect } from 'vitest';

// SDK types imported in a test only (ADR-0010 decision 2). This file is a
// compile-time parity pin: if the harness's structural hook views drift from
// the installed SDK's declarations, `npm run typecheck` fails here. The single
// runtime assertion exists so vitest counts the file; the real work is the
// type-level constants, which only compile when the relations below hold.
import type {
  HookCallbackMatcher,
  HookJSONOutput,
  Options,
  PostToolUseFailureHookInput,
  PostToolUseFailureHookSpecificOutput,
  PostToolUseHookInput,
  PostToolUseHookSpecificOutput,
  PreToolUseHookInput,
  PreToolUseHookSpecificOutput,
  SDKAPIRetryMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  QueryOptions,
  SdkHookCallback,
  SdkHookInput,
  SdkHookMatcher,
  SdkHookOutputFor,
  SdkResultMessage,
  SdkPostToolFailureAnnotateOutput,
  SdkPostToolRewriteOutput,
  SdkPostToolUseFailureInput,
  SdkPostToolUseInput,
  SdkPreToolDenyOutput,
  SdkPreToolUseInput,
  SdkUserMessage,
} from './types.js';

// True only if A is assignable to B.
type Assignable<A, B> = [A] extends [B] ? true : false;
// True only if the view declares no key the SDK type does not.
type NoExtraKeys<View, Sdk> = [Exclude<keyof View, keyof Sdk>] extends [never] ? true : false;

// The real SDK event is assignable to the harness view (the fields the harness
// reads are all present, with compatible types).
const _preAssignable: Assignable<PreToolUseHookInput, SdkPreToolUseInput> = true;
const _postAssignable: Assignable<PostToolUseHookInput, SdkPostToolUseInput> = true;
// The view invents no field the SDK does not send (this is what a `tool_output`
// field would violate, and did).
const _preNoExtra: NoExtraKeys<SdkPreToolUseInput, PreToolUseHookInput> = true;
const _postNoExtra: NoExtraKeys<SdkPostToolUseInput, PostToolUseHookInput> = true;

// Output side: the deny bridge is one of two enforced model-facing controls
// (the other is the post-tool `updatedToolOutput` rewrite adopted in issue #84,
// pinned below), so its shape must be ACCEPTABLE to the SDK (our output
// assignable to the SDK's), and the matcher must invent no key the SDK's
// matcher lacks. Note
// the direction: for inputs the SDK value flows to us (SDK -> view); for outputs
// our value flows to the SDK (view -> SDK).
const _denyOutputAccepted: Assignable<SdkPreToolDenyOutput, HookJSONOutput> = true;
const _matcherNoExtra: NoExtraKeys<SdkHookMatcher, HookCallbackMatcher> = true;
// Assignability alone does NOT catch a renamed deny key: the SDK declares
// `permissionDecision?`/`permissionDecisionReason?` optional, so a payload that
// renames one stays assignable to `HookJSONOutput` (the rename is caught only
// by the enforced producers, not by this contract pin). Pin the nested payload
// with NoExtraKeys so a renamed or invented key on our deny output reddens HERE
// too, at the contract boundary rather than only at the call site.
const _denyPayloadNoExtra: NoExtraKeys<
  SdkPreToolDenyOutput['hookSpecificOutput'],
  PreToolUseHookSpecificOutput
> = true;

// A literal using the old `tool_output` name no longer type-checks.
const _rejectsOldField: SdkPostToolUseInput = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: {},
  tool_response: { stdout: '' },
  // @ts-expect-error tool_output is not a field the SDK declares on PostToolUse
  tool_output: 'gone',
};

describe('SDK hook-input type parity', () => {
  it('holds at compile time (this file fails typecheck if the views drift)', () => {
    expect([
      _preAssignable,
      _postAssignable,
      _preNoExtra,
      _postNoExtra,
      _denyOutputAccepted,
      _matcherNoExtra,
      _denyPayloadNoExtra,
      _rejectsOldField,
    ]).toBeDefined();
  });
});

// ---- Roadmap pins (issue #101, requirements H-7 and H-8) --------------------
//
// H-7 and H-8 in process/01-requirements.md record what the harness does NOT
// do today: it passes the SDK no cancellation channel, no budget and no
// timeout, and it neither configures nor records the SDK's own API retries.
// Those are claims about code and about the pinned SDK, so they are pinned the
// same way the hook views are, in two directions:
//
//   1. The SDK really declares what the rows say it declares. If a future SDK
//      pin drops `abortController` or `maxBudgetUsd`, or changes the shape of
//      its retry report, the rows' rationale is stale and typecheck reddens here.
//   2. The harness seam (`QueryOptions`) still carries exactly the four keys it
//      carries today. The day H-7 lands, the seam grows a key, this reddens,
//      and the row's "today" sentence is rewritten in the same change. A pin on
//      an absence is unusual; it exists so a roadmap row cannot silently
//      outlive the gap it records.

// True only if T has exactly the keys K: none missing, none extra.
type ExactKeys<T, K extends PropertyKey> = [Exclude<keyof T, K>] extends [never]
  ? [Exclude<K, keyof T>] extends [never]
    ? true
    : false
  : false;

// SDK side (0.3.201): the channels exist and have the shapes the rows describe.
const _sdkDeclaresAbort: Assignable<'abortController', keyof Options> = true;
const _sdkAbortIsController: Assignable<NonNullable<Options['abortController']>, AbortController> = true;
const _sdkDeclaresBudget: Assignable<'maxBudgetUsd', keyof Options> = true;
const _sdkBudgetIsNumber: Assignable<NonNullable<Options['maxBudgetUsd']>, number> = true;
// `any` satisfies every pin above (the code lens's `abortController?: any`
// survived), so both channel declarations are also pinned as not-any.
type IsAny<T> = 0 extends 1 & T ? true : false;
const _sdkAbortNotAny: IsAny<Options['abortController']> = false;
const _sdkBudgetNotAny: IsAny<Options['maxBudgetUsd']> = false;
// The SDK declares a retry report with the shape H-8 names. Its MEMBERSHIP in
// the `SDKMessage` stream union is deliberately not pinned: in 0.3.201 that
// union names two members the package never declares
// (`SDKControlRequestProgressMessage`, `SDKConversationResetMessage`,
// sdk.d.ts:3772), which under `skipLibCheck` are the error type, so the union
// accepts everything and a membership pin compiled for `string` too (code
// lens, issue #101). The line below RECORDS that defect: when a future SDK
// declares those members the union becomes real, this reddens, and
// `Assignable<SDKAPIRetryMessage, SDKMessage>` can take its place.
const _sdkMessageUnionAcceptsAnything: Assignable<string, SDKMessage> = true;
const _retrySubtype: Assignable<SDKAPIRetryMessage['subtype'], 'api_retry'> = true;
const _retryCountsAttempts: Assignable<SDKAPIRetryMessage['attempt'], number> = true;
// The SDK result declares two duration fields (on both result variants), and
// the harness view reads neither: H-8's "declared but not read" is pinned in
// both directions.
// One pin per key and per direction: a union of keys on the left of
// `Assignable` holds only when EVERY member holds, so a single added or
// dropped key would slip through a two-key pin (a mutation showed it).
const _sdkResultHasDurationMs: Assignable<'duration_ms', keyof SDKResultMessage> = true;
const _sdkResultHasDurationApiMs: Assignable<'duration_api_ms', keyof SDKResultMessage> = true;
const _viewReadsNoDurationMs: Assignable<'duration_ms', keyof SdkResultMessage> = false;
const _viewReadsNoDurationApiMs: Assignable<'duration_api_ms', keyof SdkResultMessage> = false;

// Harness side: the seam is exactly {model, systemPrompt, maxTurns, hooks}.
const _seamExact: ExactKeys<QueryOptions, 'model' | 'systemPrompt' | 'maxTurns' | 'hooks'> = true;
// And the three scalar keys carry the SDK's value types (the hooks key is
// pinned above by `_matcherNoExtra`), so a widening such as
// `maxTurns?: number | string` reddens here rather than surviving keys-only.
const _seamScalarsMatchSdk: Assignable<Omit<QueryOptions, 'hooks'>, Options> = true;
// And a literal carrying the SDK's cancellation key does not type-check
// against the seam (excess property), the same idiom as `_rejectsOldField`.
const _seamRejectsAbort: QueryOptions = {
  maxTurns: 1,
  // @ts-expect-error abortController is not a key the harness seam carries (H-7 is deferred)
  abortController: new AbortController(),
};

describe('roadmap pins for requirements H-7 and H-8 (issue #101)', () => {
  it('hold at compile time: the SDK declares the channels, the harness seam still carries none', () => {
    expect([
      _sdkDeclaresAbort,
      _sdkAbortIsController,
      _sdkDeclaresBudget,
      _sdkBudgetIsNumber,
      _sdkAbortNotAny,
      _sdkBudgetNotAny,
      _sdkMessageUnionAcceptsAnything,
      _retrySubtype,
      _retryCountsAttempts,
      _sdkResultHasDurationMs,
      _sdkResultHasDurationApiMs,
      _viewReadsNoDurationMs,
      _viewReadsNoDurationApiMs,
      _seamExact,
      _seamScalarsMatchSdk,
      _seamRejectsAbort,
    ]).toBeDefined();
  });
});

// ---- Issue #84 D6 parity pins ------------------------------------------------
//
// The rewrite channel (updatedToolOutput) and the failure-hook annotation
// channel (additionalContext on PostToolUseFailure) are typed per event; these
// pins bind the harness views to the installed SDK in both directions, one per
// key per direction (the 09-07 lesson: a union on the LEFT of `Assignable` is
// an AND, so members are written out).

// The rewrite output is ACCEPTABLE to the SDK, and its payload invents no key
// the SDK's PostToolUse output lacks.
const _rewriteAccepted: Assignable<SdkPostToolRewriteOutput, HookJSONOutput> = true;
const _rewritePayloadNoExtra: NoExtraKeys<
  SdkPostToolRewriteOutput['hookSpecificOutput'],
  PostToolUseHookSpecificOutput
> = true;

// updatedToolOutput is declared on PostToolUse and NOT on PostToolUseFailure.
const _updatedOnPostTool: Assignable<'updatedToolOutput', keyof PostToolUseHookSpecificOutput> = true;
const _updatedNotOnFailure: Assignable<'updatedToolOutput', keyof PostToolUseFailureHookSpecificOutput> = false;
// additionalContext is a string on both event outputs.
const _ctxOnPostTool: Assignable<'additionalContext', keyof PostToolUseHookSpecificOutput> = true;
const _ctxIsStringPostTool: Assignable<NonNullable<PostToolUseHookSpecificOutput['additionalContext']>, string> = true;
const _ctxOnFailure: Assignable<'additionalContext', keyof PostToolUseFailureHookSpecificOutput> = true;
const _ctxIsStringFailure: Assignable<NonNullable<PostToolUseFailureHookSpecificOutput['additionalContext']>, string> = true;

// Failure hook input: the SDK value flows to the harness view (SDK -> view),
// and the view invents no key the SDK lacks.
const _failInputAssignable: Assignable<PostToolUseFailureHookInput, SdkPostToolUseFailureInput> = true;
const _failInputNoExtra: NoExtraKeys<SdkPostToolUseFailureInput, PostToolUseFailureHookInput> = true;
// Failure output: ACCEPTABLE to the SDK, additionalContext only.
const _failOutputAccepted: Assignable<SdkPostToolFailureAnnotateOutput, HookJSONOutput> = true;
const _failPayloadNoExtra: NoExtraKeys<
  SdkPostToolFailureAnnotateOutput['hookSpecificOutput'],
  PostToolUseFailureHookSpecificOutput
> = true;

// A failure output carrying updatedToolOutput does not type-check (the failure
// hook has no rewrite channel, S-1).
const _rejectsFailureRewrite: SdkPostToolFailureAnnotateOutput = {
  hookSpecificOutput: {
    hookEventName: 'PostToolUseFailure',
    additionalContext: 'note',
    // @ts-expect-error PostToolUseFailure output declares no updatedToolOutput
    updatedToolOutput: 'gone',
  },
};

// User-message view: SDK value flows to the view; the view invents no key.
const _userAssignable: Assignable<SDKUserMessage, SdkUserMessage> = true;
const _userNoExtra: NoExtraKeys<SdkUserMessage, SDKUserMessage> = true;

// Bare-callback narrowing (U-8): a value typed by the BARE SdkHookCallback
// still narrows `hookSpecificOutput?.permissionDecision`, because
// SdkHookOutputFor<SdkHookInput> keeps the deny member.
type BareOutput = Awaited<ReturnType<SdkHookCallback>>;
const _bareIsWidest: Assignable<SdkHookOutputFor<SdkHookInput>, BareOutput> = true;
const _bareNarrows: (o: BareOutput) => 'deny' | 'other' = (o) =>
  o.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny' : 'other';

// A post-tool callback returning a PRE-tool deny is a type error (the mismatch
// is reported at the assignment, where the whole function type is checked).
// @ts-expect-error a PreToolUse deny is not a valid PostToolUse output
const _postCannotDeny: SdkHookCallback<SdkPostToolUseInput> = async () => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse' as const,
    permissionDecision: 'deny' as const,
    permissionDecisionReason: 'x',
  },
});

describe('issue #84 D6 rewrite/failure/user-message type parity', () => {
  it('holds at compile time', () => {
    expect([
      _rewriteAccepted,
      _rewritePayloadNoExtra,
      _updatedOnPostTool,
      _updatedNotOnFailure,
      _ctxOnPostTool,
      _ctxIsStringPostTool,
      _ctxOnFailure,
      _ctxIsStringFailure,
      _failInputAssignable,
      _failInputNoExtra,
      _failOutputAccepted,
      _failPayloadNoExtra,
      _rejectsFailureRewrite,
      _userAssignable,
      _userNoExtra,
      _bareIsWidest,
      _bareNarrows,
      _postCannotDeny,
    ]).toBeDefined();
  });
});
