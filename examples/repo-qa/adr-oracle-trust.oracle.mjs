/** @type {import('agent-harness-ja').OracleFn} */
export const oracle = (result) => {
  if (result.resultSubtype !== 'success') {
    return { pass: false, reason: `expected subtype success, got ${result.resultSubtype}` };
  }
  // Groundedness pin: a single turn means the answer came from the loaded
  // skill, not from tool-hunting through the repo — the "right answer, wrong
  // mechanism" false-pass this example originally shipped with.
  if (result.numTurns !== 1) {
    return { pass: false, reason: `expected a 1-turn skill-grounded answer, got ${result.numTurns} turns` };
  }
  const text = result.resultText ?? '';
  if (!/adr[-\s]?0{0,2}17\b/i.test(text)) {
    return { pass: false, reason: 'expected the answer to name ADR-0017' };
  }
  return /in[ -]?process|r[- ]?10|arbitrary code/i.test(text)
    ? { pass: true }
    : { pass: false, reason: 'expected the in-process / R-10 trust caveat' };
};
