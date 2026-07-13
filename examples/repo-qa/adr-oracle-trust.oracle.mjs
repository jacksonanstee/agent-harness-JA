/** @type {import('agent-harness-ja').OracleFn} */
export const oracle = (result) => {
  if (result.resultSubtype !== 'success') {
    return { pass: false, reason: `expected subtype success, got ${result.resultSubtype}` };
  }
  const text = result.resultText ?? '';
  if (!/0017/.test(text)) {
    return { pass: false, reason: 'expected the answer to name ADR-0017' };
  }
  return /in[ -]?process|r[- ]?10|arbitrary code|trust/i.test(text)
    ? { pass: true }
    : { pass: false, reason: 'expected the in-process / R-10 trust caveat' };
};
