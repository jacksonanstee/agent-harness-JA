// The Claude Code settings sources the SDK child may load (issue #140,
// ADR-0040). The tuple is the harness's own literal, parity-pinned in both
// directions against the SDK's `SettingSource` in session/sdk-types.test.ts.
// The default is none: an absent or empty list isolates the child. The parser
// that validates the user file's `sdk.settingSources` arrives in a later task.
export const SETTING_SOURCES = ['user', 'project', 'local'] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];
