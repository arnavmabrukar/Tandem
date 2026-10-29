import { describe, expect, it, vi } from 'vitest';
import { commandEndpoint, createApiClient } from '../src/api/client';
import { readConfig, safeReturnTo } from '../src/config';
import type { Command, MutationRequest } from '../src/types/domain';

const request = (command: Command): MutationRequest => ({
  projectId: command.type === 'create-project' ? null : 'project-1',
  expectedVersion: command.type === 'create-project' ? null : 4,
  operationId: 'operation-1',
  command,
});
const success = { projectId: 'project-1', projectVersion: 5, entityId: 'new-entity' };
function setup(response: Response = Response.json(success)) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  const getAccessToken = vi.fn().mockResolvedValue('test-token');
  const onUnauthorized = vi.fn();
  const api = createApiClient({
    baseUrl: 'https://api.example.test',
    fetcher,
    getAccessToken,
    onUnauthorized,
  });
  return { api, fetcher, getAccessToken, onUnauthorized };
}
describe('real HTTP client contract', () => {
  it('reads only server data with a bearer token and validates the snapshot', async () => {
    const { api, fetcher } = setup(Response.json({ schemaVersion: 1, projects: [] }));
    expect(await api.load()).toEqual({ schemaVersion: 1, projects: [] });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example.test/api/workspace',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer test-token' },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      }),
    );
  });
  it('does not replace malformed responses with sample or empty data', async () => {
    const { api } = setup(Response.json({ projects: [] }));
    await expect(api.load()).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('maps every supported command to an explicit REST route', () => {
    const cases: [Command, string, string][] = [
      [
        { type: 'create-project', name: 'P', repository: 'owner/repo', description: '' },
        'POST',
        '/api/projects',
      ],
      [
        { type: 'update-project', name: 'P', repository: 'owner/repo', description: '' },
        'PATCH',
        '/api/projects/project-1',
      ],
      [
        { type: 'invite', email: 'a@example.test', role: 'reviewer' },
        'POST',
        '/api/projects/project-1/invitations',
      ],
      [
        { type: 'revoke-invite', invitationId: 'i-1' },
        'POST',
        '/api/projects/project-1/invitations/i-1/revoke',
      ],
      [
        {
          type: 'add-agent',
          name: 'A',
          client: 'Codex',
          owner: 'Owner',
          machine: 'Laptop',
          capabilities: [],
        },
        'POST',
        '/api/projects/project-1/agents',
      ],
      [
        { type: 'revoke-agent', agentId: 'a-1' },
        'POST',
        '/api/projects/project-1/agents/a-1/revoke',
      ],
      [
        {
          type: 'create-task',
          title: 'T',
          description: 'D',
          agentId: null,
          paths: [],
          criteria: [],
        },
        'POST',
        '/api/projects/project-1/tasks',
      ],
      [{ type: 'cancel-task', taskId: 't-1' }, 'POST', '/api/projects/project-1/tasks/t-1/cancel'],
      [
        { type: 'send-message', taskId: 't-1', body: 'Note', replyTo: null },
        'POST',
        '/api/projects/project-1/tasks/t-1/messages',
      ],
      [
        {
          type: 'decide',
          approvalId: 'r-1',
          decision: 'approved',
          note: 'Checked',
          target: {
            taskVersion: 1,
            contractVersion: 2,
            head: 'a'.repeat(40),
            repository: 'owner/repo',
            action: 'Review result',
          },
        },
        'POST',
        '/api/projects/project-1/approvals/r-1/decisions',
      ],
    ];
    for (const [command, method, path] of cases)
      expect(commandEndpoint(request(command))).toMatchObject({ method, path });
  });
  it('sends the same operation ID on retries, expected version and exact review target without a client actor ID', async () => {
    const { api, fetcher } = setup();
    fetcher.mockImplementation(async () => Response.json(success));
    const mutation = request({
      type: 'decide',
      approvalId: 'r-1',
      decision: 'approved',
      note: 'Checked',
      target: {
        taskVersion: 1,
        contractVersion: 2,
        head: 'a'.repeat(40),
        repository: 'owner/repo',
        action: 'Review result',
      },
    });
    await api.execute(mutation);
    await api.execute(mutation);
    for (const [, options] of fetcher.mock.calls) {
      expect(options?.headers).toMatchObject({
        'Idempotency-Key': 'operation-1',
        Authorization: 'Bearer test-token',
      });
      const body = JSON.parse(options!.body as string);
      expect(body).toMatchObject({
        operationId: 'operation-1',
        expectedVersion: 4,
        target: mutation.command.type === 'decide' ? mutation.command.target : {},
      });
      expect(body).not.toHaveProperty('actorId');
      expect(body).not.toHaveProperty('type');
    }
  });
  it('rejects missing IDs before issuing a request and encodes path segments', async () => {
    const { api, fetcher } = setup();
    await expect(
      api.execute({ ...request({ type: 'cancel-task', taskId: 't-1' }), projectId: null }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(commandEndpoint(request({ type: 'revoke-agent', agentId: 'a/b' })).path).toContain(
      'a%2Fb',
    );
  });
  it('expires unauthorized sessions, exposes conflicts and never logs server response details', async () => {
    const denied = setup(new Response('sensitive server traceback', { status: 401 }));
    await expect(denied.api.load()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    expect(denied.onUnauthorized).toHaveBeenCalledOnce();
    const conflict = setup(new Response('', { status: 409 }));
    await expect(
      conflict.api.execute(request({ type: 'cancel-task', taskId: 't-1' })),
    ).rejects.toMatchObject({ code: 'conflict', outcomeUnknown: false });
  });
  it('never sends an unauthenticated request when token retrieval fails', async () => {
    const { api, getAccessToken, fetcher, onUnauthorized } = setup();
    getAccessToken.mockRejectedValue(new Error('login required'));
    await expect(api.load()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
  it('marks lost or malformed write responses as uncertain', async () => {
    const broken = setup();
    broken.fetcher.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      broken.api.execute(request({ type: 'cancel-task', taskId: 't-1' })),
    ).rejects.toMatchObject({ code: 'network', outcomeUnknown: true });
    const invalid = setup(Response.json({ projectId: 'project-1' }));
    await expect(
      invalid.api.execute(request({ type: 'cancel-task', taskId: 't-1' })),
    ).rejects.toMatchObject({ code: 'invalid_response', outcomeUnknown: true });
    const missingId = setup(Response.json({ projectId: 'project-1', projectVersion: 5 }));
    await expect(
      missingId.api.execute(
        request({
          type: 'create-task',
          title: 'T',
          description: 'D',
          agentId: null,
          paths: [],
          criteria: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response', outcomeUnknown: true });
  });
  it('bounds token acquisition time and never dispatches after timeout', async () => {
    const fetcher = vi.fn<typeof fetch>();
    let release!: (token: string) => void;
    const api = createApiClient({
      baseUrl: 'https://api.example.test',
      timeoutMs: 10,
      fetcher,
      getAccessToken: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await expect(api.load()).rejects.toMatchObject({ code: 'timeout' });
    release('token');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cancels in-flight reads without replacing data', async () => {
    const { api } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(api.load(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('connection configuration', () => {
  const settings = {
    VITE_API_BASE_URL: 'https://api.example.test/',
    VITE_AUTH0_DOMAIN: 'team.auth0.com',
    VITE_AUTH0_CLIENT_ID: 'public-client-id',
    VITE_AUTH0_AUDIENCE: 'https://tandem-api',
  };
  it('requires every real connection setting', () => {
    expect(readConfig({}).errors).toHaveLength(4);
  });
  it('accepts HTTPS or loopback origins and rejects paths, credentials and insecure remote URLs', () => {
    expect(readConfig(settings).config?.apiBaseUrl).toBe('https://api.example.test');
    expect(
      readConfig({ ...settings, VITE_API_BASE_URL: 'http://localhost:8000' }).config,
    ).not.toBeNull();
    for (const url of [
      'http://api.example.test',
      'https://api.example.test/api',
      'https://user:pass@api.example.test',
      'https://api.example.test/?secret=x',
    ])
      expect(readConfig({ ...settings, VITE_API_BASE_URL: url }).config).toBeNull();
    expect(
      readConfig({ ...settings, VITE_AUTH0_DOMAIN: 'https://team.auth0.com/path' }).config,
    ).toBeNull();
  });
  it('restores only internal project routes after sign-in', () => {
    expect(safeReturnTo('/projects/p/tasks/t')).toBe('/projects/p/tasks/t');
    expect(safeReturnTo('//outside.example')).toBe('/');
    expect(safeReturnTo('https://outside.example')).toBe('/');
  });
});
