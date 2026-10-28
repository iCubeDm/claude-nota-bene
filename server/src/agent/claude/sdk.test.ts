import { expect, it } from 'vitest';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { toModelOption } from './sdk.ts';

it('toModelOption: the effort levels only for a model that supports effort; the resolved id when there is one', () => {
  const base = { value: 'sonnet', displayName: 'Sonnet', description: 'd' } satisfies ModelInfo;
  expect(toModelOption({ ...base, resolvedModel: 'claude-sonnet-5', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }))
    .toEqual({ value: 'sonnet', name: 'Sonnet', description: 'd', resolved: 'claude-sonnet-5', efforts: ['low', 'high'] });
  expect(toModelOption({ ...base, supportsEffort: false, supportedEffortLevels: ['low'] })).toEqual({ value: 'sonnet', name: 'Sonnet', description: 'd' });
  expect(toModelOption({ ...base, supportsEffort: true, supportedEffortLevels: [] })).toEqual({ value: 'sonnet', name: 'Sonnet', description: 'd' });
});
