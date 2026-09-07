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
  PostToolUseHookInput,
  PreToolUseHookInput,
  PreToolUseHookSpecificOutput,
  SDKAPIRetryMessage,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  QueryOptions,
  SdkHookMatcher,
  SdkPostToolUseInput,
  SdkPreToolDenyOutput,
  SdkPreToolUseInput,
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

// Output side: the deny bridge is the harness's one enforced model-facing
// control, so its shape must be ACCEPTABLE to the SDK (our output assignable to
// the SDK's), and the matcher must invent no key the SDK's matcher lacks. Note
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
//      pin drops `abortController` or `maxBudgetUsd`, or stops reporting
//      retries, the rows' rationale is stale and typecheck reddens here.
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
// The SDK reports each API retry as a system message the stream can carry.
const _sdkReportsRetries: Assignable<SDKAPIRetryMessage, SDKMessage> = true;
const _retrySubtype: Assignable<SDKAPIRetryMessage['subtype'], 'api_retry'> = true;
const _retryCountsAttempts: Assignable<SDKAPIRetryMessage['attempt'], number> = true;

// Harness side: the seam is exactly {model, systemPrompt, maxTurns, hooks}.
const _seamExact: ExactKeys<QueryOptions, 'model' | 'systemPrompt' | 'maxTurns' | 'hooks'> = true;
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
      _sdkReportsRetries,
      _retrySubtype,
      _retryCountsAttempts,
      _seamExact,
      _seamRejectsAbort,
    ]).toBeDefined();
  });
});
