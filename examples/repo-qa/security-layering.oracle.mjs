/** @type {import('agent-harness-ja').OracleFn} */
export const oracle = (result) => {
  if (result.resultSubtype !== 'success') {
    return { pass: false, reason: `expected subtype success, got ${result.resultSubtype}` };
  }
  // Groundedness pin — see adr-oracle-trust.oracle.mjs.
  if (result.numTurns !== 1) {
    return { pass: false, reason: `expected a 1-turn skill-grounded answer, got ${result.numTurns} turns` };
  }
  const text = result.resultText ?? '';
  if (!/\bno\b|cannot|can't|never/i.test(text)) {
    return { pass: false, reason: 'expected a clear "no" — user denies are sticky' };
  }
  // The PERMISSION merge rule specifically (ADR-0014): max severity /
  // sticky deny. Deliberately not "intersection" — that is ADR-0015's
  // sandbox-allowlist rule, a different mechanism; accepting it would pass
  // an answer that names the wrong ADR's machinery.
  return /max(?:imum)?[ -]?severity|sticky[ -]?deny/i.test(text)
    ? { pass: true }
    : { pass: false, reason: 'expected the permission merge rule (max severity / sticky deny) to be named' };
};
