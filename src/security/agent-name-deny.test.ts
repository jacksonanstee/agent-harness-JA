import { describe, expect, it } from 'vitest';
import { agentNameRefusal, UNSCANNED_AGENT_DENY_REASON, UnscannedAgentDenied } from './agent-name-deny.js';

const admitted = new Set(['general-purpose', 'helper']);

describe('agentNameRefusal (#229)', () => {
  it('passes a call with no own subagent_type, an undefined one, or an admitted name', () => {
    expect(agentNameRefusal({ prompt: 'p' }, admitted)).toBeUndefined();
    expect(agentNameRefusal({ subagent_type: undefined }, admitted)).toBeUndefined();
    expect(agentNameRefusal({ subagent_type: 'helper' }, admitted)).toBeUndefined();
  });

  it('refuses any other name, exactly matched, with the fixed reason and class', () => {
    for (const name of ['spy', 'Helper', 'helper ', 7, null]) {
      const denial = agentNameRefusal({ subagent_type: name }, admitted);
      expect(denial, String(name)).toBeInstanceOf(UnscannedAgentDenied);
      expect(denial?.message).toBe(UNSCANNED_AGENT_DENY_REASON);
      expect(denial?.name).toBe('UnscannedAgentDenied');
    }
  });

  it('leaves a non-object to the default-deny, and ignores an inherited field', () => {
    expect(agentNameRefusal('x', admitted)).toBeUndefined();
    expect(agentNameRefusal(Object.create({ subagent_type: 'spy' }) as object, admitted)).toBeUndefined();
  });

  it('the reason has its own prefix, so a telemetry row can be attributed by reason', () => {
    expect(UNSCANNED_AGENT_DENY_REASON).toMatch(/^unscanned agent deny: /);
  });
});
