import { describe, it, expect, vi } from 'vitest';
import { planProposalSchema } from '../src/types/plans';
import { createApiClient } from '../src/api/client';

const task = (key: string, dependencies: string[] = []) => ({ key, dependencies,
  title: 'Build', description: '', contractSummary: 'Scope', paths: [], criteria: ['Works'] });
const proposal = { goal: 'Feature', summary: 'Build feature', tasks: [task('a'), task('b', ['a'])] };

describe('plan proposals', () => {
  it('allows valid dependencies and rejects cycles, missing keys, and unsafe paths', () => {
    expect(planProposalSchema.safeParse(proposal).success).toBe(true);
    for (const tasks of [[task('a', ['b']), task('b', ['a'])], [task('a', ['missing'])],
      [task('a'), task('a')], [{ ...task('a'), paths: ['../secret'] }],
      [{ ...task('a'), criteria: [] }]]) {
      expect(planProposalSchema.safeParse({ ...proposal, tasks }).success).toBe(false);
    }
  });
  it('sends authenticated saves with matching retry keys and revision versions', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const planId = '22222222-2222-4222-8222-222222222222';
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ projectId, planId,
      projectVersion: 3, planVersion: 2 }), { status: 201 }));
    const api = createApiClient({ baseUrl: 'https://api.example', getAccessToken: async () => 'token', fetcher });
    const body = { operationId: '33333333-3333-4333-8333-333333333333', expectedVersion: 2,
      expectedPlanVersion: 1, proposal };
    await api.savePlan(projectId, planId, body);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(`https://api.example/api/projects/${projectId}/plans/${planId}/revisions`);
    expect(options.headers.Authorization).toBe('Bearer token');
    expect(options.headers['Idempotency-Key']).toBe(body.operationId);
    expect(JSON.parse(options.body)).toEqual(body);
  });
});
