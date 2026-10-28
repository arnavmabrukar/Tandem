import { describe, expect, it } from 'vitest';
import { createDemoApi, STORAGE_KEY } from '../src/api/demo';
import { workspaceSchema, type Command, type MutationRequest } from '../src/types/domain';

function harness() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const api = createDemoApi(storage, 0);
  async function request(
    command: Command,
    actorId = 'arnav',
    projectId = 'tandem',
  ): Promise<MutationRequest> {
    const data = await api.load(actorId);
    return {
      actorId,
      projectId,
      operationId: crypto.randomUUID(),
      expectedVersion: data.projects.find((p) => p.id === projectId)?.version ?? null,
      command,
    };
  }
  return { values, storage, api, request };
}
const newTask: Command = {
  type: 'create-task',
  title: 'A new test task',
  description: 'Test task description',
  agentId: 'codex',
  paths: ['apps/web/src/example.ts'],
  criteria: ['A demonstrable result'],
};

describe('browser-only demo adapter (not backend correctness tests)', () => {
  it('loads valid fixtures and retains a write across adapter instances', async () => {
    const { api, storage, request } = harness();
    expect(workspaceSchema.safeParse(await api.load('arnav')).success).toBe(true);
    const result = await api.execute(await request(newTask));
    const reloaded = await createDemoApi(storage, 0).load('arnav');
    const task = reloaded.projects[0].tasks.find((t) => t.id === result.entityId)!;
    expect(task.receipt).toBe('pending');
    expect(task.acceptance).toBe('pending');
    expect(reloaded.projects[0].claims.some((c) => c.taskId === task.id)).toBe(false);
  });
  it('replays an identical operation once and rejects reuse with different content', async () => {
    const { api, request } = harness();
    const mutation = await request(newTask);
    const first = await api.execute(mutation);
    expect(await api.execute(mutation)).toEqual(first);
    expect(
      (await api.load('arnav')).projects[0].tasks.filter((t) => t.title === newTask.title),
    ).toHaveLength(1);
    await expect(
      api.execute({ ...mutation, command: { ...newTask, title: 'Different' } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('preserves the exact review target when another tab changes the head', async () => {
    const { api, request } = harness();
    const approval = (await api.load('arnav')).projects[0].approvals[0];
    const mutation = await request({
      type: 'decide',
      approvalId: approval.id,
      decision: 'approved',
      note: 'Reviewed',
      target: {
        taskVersion: approval.taskVersion,
        contractVersion: approval.contractVersion,
        head: approval.head,
      },
    });
    await api.changeReviewHead('tandem');
    await expect(api.execute(mutation)).rejects.toMatchObject({ code: 'conflict' });
    const updated = (await api.load('arnav')).projects[0];
    expect(updated.approvals.find((a) => a.id === approval.id)?.status).toBe('stale');
    expect(
      updated.approvals.filter((a) => a.taskId === approval.taskId && a.status === 'approved'),
    ).toHaveLength(0);
    const latestVersionMutation = { ...mutation, expectedVersion: updated.version };
    await expect(api.execute(latestVersionMutation)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('records a decision without manufacturing task completion or merge evidence', async () => {
    const { api, request } = harness();
    const before = (await api.load('arnav')).projects[0];
    const approval = before.approvals[0];
    await api.execute(
      await request({
        type: 'decide',
        approvalId: approval.id,
        decision: 'approved',
        note: 'Exact demo target reviewed',
        target: {
          taskVersion: approval.taskVersion,
          contractVersion: approval.contractVersion,
          head: approval.head,
        },
      }),
    );
    const after = (await api.load('arnav')).projects[0];
    expect(after.approvals[0].status).toBe('approved');
    expect(after.tasks.find((t) => t.id === approval.taskId)?.status).toBe('in_review');
    expect(after.tasks.find((t) => t.id === approval.taskId)?.result?.mergeCommit).toBeNull();
  });
  it('rejects viewer mutations and owner actions from a reviewer', async () => {
    const { api, request } = harness();
    await expect(api.execute(await request(newTask, 'guest'))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      api.execute(await request({ type: 'revoke-agent', agentId: 'codex' }, 'eashan')),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('keeps project memberships and reply targets scoped', async () => {
    const { api, request } = harness();
    const created = await api.execute(
      await request({
        type: 'create-project',
        name: 'Private local project',
        repository: 'test/repo',
        description: '',
      }),
    );
    expect((await api.load('eashan')).projects.some((p) => p.id === created.projectId)).toBe(false);
    await expect(
      api.execute(
        await request({
          type: 'send-message',
          taskId: 'task-auth',
          replyTo: 'message-1',
          body: 'Cross-thread reply',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  it('leaves state unchanged after a failed save and permits the same retry', async () => {
    const { api, request } = harness();
    const mutation = await request(newTask);
    const before = await api.load('arnav');
    api.failNext();
    await expect(api.execute(mutation)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await api.load('arnav')).toEqual(before);
    await api.execute(mutation);
    await api.execute(mutation);
    expect((await api.load('arnav')).projects[0].tasks).toHaveLength(
      before.projects[0].tasks.length + 1,
    );
  });
  it('does not overwrite incompatible saved data without an explicit reset', async () => {
    const { api, values } = harness();
    values.set(STORAGE_KEY, '{broken');
    await expect(api.load('arnav')).rejects.toMatchObject({ code: 'storage' });
    expect(values.get(STORAGE_KEY)).toBe('{broken');
    await api.reset(true);
    expect((await api.load('arnav')).projects[0].tasks).toHaveLength(0);
  });
  it('reports storage failure instead of returning successful writes', async () => {
    const { api, storage, request } = harness();
    const mutation = await request(newTask);
    const failing = createDemoApi(
      {
        getItem: storage.getItem,
        setItem() {
          throw new Error('Quota exceeded');
        },
      },
      0,
    );
    await expect(failing.execute(mutation)).rejects.toMatchObject({ code: 'storage' });
    expect((await api.load('arnav')).projects[0].tasks.some((t) => t.title === newTask.title)).toBe(
      false,
    );
  });
  it('retains claims when a human cancels a task and invalidates its reviews', async () => {
    const { api, request } = harness();
    const before = (await api.load('arnav')).projects[0];
    await api.execute(await request({ type: 'cancel-task', taskId: 'task-auth' }));
    const after = (await api.load('arnav')).projects[0];
    expect(after.claims).toEqual(before.claims);
    expect(after.approvals[0].status).toBe('stale');
    expect(after.tasks[1].status).toBe('cancelled');
  });
  it('rejects traversal paths and invalid repositories without partial writes', async () => {
    const { api, request } = harness();
    const before = await api.load('arnav');
    await expect(
      api.execute(await request({ ...newTask, paths: ['../secret'] })),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      api.execute(
        await request({
          type: 'update-project',
          name: 'Edited',
          repository: 'https://wrong.example',
          description: '',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await api.load('arnav')).toEqual(before);
  });
});
