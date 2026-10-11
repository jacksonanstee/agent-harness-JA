/**
 * The one USD figure formatter (issue #143): a dollar sign and four decimals,
 * `toFixed` rounding. Hoisted from six inlined copies (golden and redteam
 * markdown, the judge sample summary, the judge summary line, the CLI result
 * line, the golden runner's progress cell). Zero-dep, so every layer may use it.
 */
export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
