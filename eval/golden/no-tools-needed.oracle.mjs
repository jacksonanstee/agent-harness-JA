/** @type {import('agent-harness-ja').OracleFn} */
export const oracle = (result) => {
  if (result.resultSubtype !== 'success') {
    return { pass: false, reason: `expected subtype success, got ${result.resultSubtype}` };
  }
  if (result.denied.length > 0) {
    return { pass: false, reason: `expected no denied tool calls, got ${result.denied.length}` };
  }
  const text = (result.resultText ?? '').trim();
  return text.length > 0
    ? { pass: true }
    : { pass: false, reason: 'expected a non-empty reply' };
};
