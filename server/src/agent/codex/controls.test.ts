import { expect, it } from 'vitest';
import { answerNative, limits, policy } from './controls.ts';
const opts = { cwd: '/tmp', permissionMode: 'codex-configured' as const, ask: async () => false };
it('Codex profiles never reinterpret Claude modes', () => {
  expect(policy('codex-configured', '/tmp')).toEqual({});
  expect(() => policy('auto', '/tmp')).toThrow();
  expect(policy('codex-workspace', '/tmp', true)).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } });
});
it('preserves variable limit windows rather than assuming five hours', () => {
  expect(limits({ rateLimits: { primary: { usedPercent: 23, windowDurationMins: 120, resetsAt: 10 } } })).toMatchObject([{ utilization: 23, minutes: 120 }]);
});
it('returns actual user answers and exact original approval amendments', async () => {
  const signal = new AbortController().signal;
  expect(await answerNative({ id: 1, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', question: 'Which?' }] } }, signal, { ...opts, interact: async () => ({ choice: 'submit', values: { q: 'blue' } }) })).toEqual({ answers: { q: { answers: ['blue'] } } });
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } };
  expect(await answerNative({ id: 2, method: 'item/commandExecution/requestApproval', params: { availableDecisions: [amendment, 'decline'] } }, signal, { ...opts, interact: async () => ({ choice: '0' }) })).toEqual({ decision: amendment });
});
it('validates MCP typed JSON before returning an acceptance', async () => {
  const req = { id: 1, method: 'mcpServer/elicitation/request', params: { requestedSchema: { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 } } } } };
  await expect(answerNative(req, new AbortController().signal, { ...opts, interact: async () => ({ choice: 'accept', values: { json: '{"n":"1"}' } }) })).rejects.toThrow('Invalid field');
  expect(await answerNative(req, new AbortController().signal, { ...opts, interact: async () => ({ choice: 'accept', values: { json: '{"n":1}' } }) })).toEqual({ action: 'accept', content: { n: 1 } });
});
