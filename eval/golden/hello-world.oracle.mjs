/** @type {import('agent-harness-ja').OracleFn} */
export const oracle = (result) => {
  if (result.resultSubtype !== 'success') {
    return { pass: false, reason: `expected subtype success, got ${result.resultSubtype}` };
  }
  const text = (result.resultText ?? '').trim().toLowerCase();
  return text.includes('pong')
    ? { pass: true }
    : { pass: false, reason: 'expected "pong" in the reply' };
};
