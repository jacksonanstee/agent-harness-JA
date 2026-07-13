/** @type {import('agent-harness-ja').OracleFn} */
export const oracle = (result) => {
  if (result.resultSubtype !== 'success') {
    return { pass: false, reason: `expected subtype success, got ${result.resultSubtype}` };
  }
  const text = result.resultText ?? '';
  if (!/\bno\b|cannot|can't|never/i.test(text)) {
    return { pass: false, reason: 'expected a clear "no" — user denies are sticky' };
  }
  return /tighten|intersection|max(?:imum)?[ -]?severity|loosen|widen/i.test(text)
    ? { pass: true }
    : { pass: false, reason: 'expected the merge rule (max severity / tighten-only) to be named' };
};
