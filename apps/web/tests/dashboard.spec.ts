import { expect, test, type Page, type Request } from '@playwright/test';
import { testProject, testTask } from './support/data';

async function connect(page: Page) {
  const state = { project: testProject(), readStatus: 200, writes: [] as Request[], reads: 0 };
  await page.route('https://api.tandem.test/api/**', async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe('Bearer test-only-access-token');
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      state.writes.push(request);
      await route.fulfill({ status: 501 });
      return;
    }
    if (path === '/api/me') {
      await route.fulfill({ json: { id: 'user-1', name: 'Test owner' } });
      return;
    }
    state.reads++;
    await route.fulfill({
      status: state.readStatus,
      json: { schemaVersion: 1, projects: [state.project] },
    });
  });
  return state;
}
const thread = '/#/projects/project-1/tasks/task-1';

test('missing configuration shows setup, with no network or fabricated workspace', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url());
  });
  await page.goto('http://127.0.0.1:4174');
  await expect(page.getByRole('heading', { name: 'Connect your backend' })).toBeVisible();
  await expect(page.getByText('VITE_API_BASE_URL is missing.', { exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  await expect(page.getByRole('button', { name: 'New task' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('configuration.png'), fullPage: true });
});

test('sign-in gates API requests and restores the requested task', async ({ page }) => {
  const state = await connect(page);
  await page.goto('/?test-auth=off#/projects/project-1/tasks/task-1');
  await expect(page.getByRole('button', { name: 'Sign in with Auth0' })).toBeVisible();
  expect(state.reads).toBe(0);
  await page.getByRole('button', { name: 'Sign in with Auth0' }).click();
  await expect(
    page.getByRole('heading', { name: 'Task returned by test API', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('connected.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with Auth0' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Task returned by test API', exact: true }),
  ).toHaveCount(0);
});

test('a missing or offline API shows failure without sample records', async ({ page }) => {
  const state = await connect(page);
  state.readStatus = 404;
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('API endpoint was not found');
  await expect(page.getByRole('heading', { name: 'Create a shared project' })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'API project' })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('failed refresh shows stale real snapshot; permission loss hides all project data', async ({
  page,
}) => {
  const state = await connect(page);
  await page.goto(thread);
  await expect(
    page.getByRole('heading', { name: 'Task returned by test API', exact: true }),
  ).toBeVisible();
  state.readStatus = 503;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText(/Showing the last successful snapshot/)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Task returned by test API', exact: true }),
  ).toBeVisible();
  state.readStatus = 403;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('do not have permission');
  await expect(
    page.getByRole('heading', { name: 'Task returned by test API', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'API project' })).toHaveCount(0);
  expect(await page.title()).not.toContain('API project');
});

test('401 clears the workspace and asks for real sign-in', async ({ page }) => {
  const state = await connect(page);
  await page.goto(thread);
  await expect(
    page.getByRole('heading', { name: 'Task returned by test API', exact: true }),
  ).toBeVisible();
  state.readStatus = 401;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with Auth0' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'API project' })).toHaveCount(0);
});

test('task creation waits for a confirmed API response and refetches server data', async ({
  page,
}) => {
  const state = await connect(page);
  await page.route('**/api/projects/project-1/tasks', async (route) => {
    const body = route.request().postDataJSON();
    state.writes.push(route.request());
    expect(body).toMatchObject({
      title: 'New backend task',
      description: 'Implement the endpoint',
      expectedVersion: 4,
      agentId: null,
    });
    expect(body.actorId).toBeUndefined();
    expect(route.request().headers()['idempotency-key']).toBe(body.operationId);
    state.project.tasks.push({
      ...testTask(),
      id: 'task-2',
      title: body.title,
      description: body.description,
    });
    state.project.version = 5;
    await route.fulfill({
      json: { projectId: 'project-1', projectVersion: 5, entityId: 'task-2' },
    });
  });
  await page.goto('/#/projects/project-1/tasks');
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Task title', { exact: true }).fill('New backend task');
  await page.getByLabel('Description', { exact: true }).fill('Implement the endpoint');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New backend task', exact: true })).toBeVisible();
  expect(state.reads).toBeGreaterThanOrEqual(2);
  expect(state.writes).toHaveLength(1);
});

test('lost write response retains the draft and retry reuses its operation ID', async ({
  page,
}) => {
  const state = await connect(page);
  const writes: Request[] = [];
  await page.route('**/api/projects/project-1/tasks/task-1/messages', async (route) => {
    writes.push(route.request());
    if (writes.length === 1) {
      await route.abort('failed');
      return;
    }
    const body = route.request().postDataJSON();
    state.project.messages.push({
      id: 'message-1',
      taskId: 'task-1',
      sequence: 1,
      sender: 'Test owner',
      type: 'human_note',
      body: body.body,
      createdAt: '2026-10-28T12:00:00Z',
      replyTo: null,
      receipt: 'pending',
    });
    state.project.version = 5;
    await route.fulfill({
      json: { projectId: 'project-1', projectVersion: 5, entityId: 'message-1' },
    });
  });
  await page.goto(thread);
  await page.getByLabel('Human note', { exact: true }).fill('Persist this note');
  await page.getByRole('button', { name: 'Post note' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not reach the API');
  await expect(page.getByLabel('Human note', { exact: true })).toHaveValue('Persist this note');
  await expect(page.locator('.messages')).toHaveCount(0);
  await page.getByRole('button', { name: 'Post note' }).click();
  await expect(page.locator('.messages')).toContainText('Persist this note');
  await expect(page.getByLabel('Human note', { exact: true })).toHaveValue('');
  expect(writes[0].postDataJSON()).toEqual(writes[1].postDataJSON());
});

test('a conflicting approval never becomes approved locally', async ({ page }) => {
  const state = await connect(page);
  let captured: Record<string, unknown> | undefined;
  await page.route('**/api/projects/project-1/approvals/approval-1/decisions', async (route) => {
    captured = route.request().postDataJSON();
    state.project.tasks[0].version = 3;
    state.project.version = 5;
    await route.fulfill({ status: 409 });
  });
  await page.goto(thread);
  await page.getByRole('button', { name: 'Review target' }).click();
  await page.getByLabel('Review note', { exact: true }).fill('Reviewed this exact head');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Record approval' }).click();
  await expect(page.getByText('This target is no longer current.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record approval' })).toBeDisabled();
  expect(captured).toMatchObject({
    expectedVersion: 4,
    decision: 'approved',
    target: {
      repository: 'team/tandem',
      action: 'Review result',
      taskVersion: 2,
      contractVersion: 1,
      head: 'a'.repeat(40),
    },
  });
  expect(state.project.approvals[0].status).toBe('pending');
});

test('viewer permissions come from the server membership', async ({ page }) => {
  const state = await connect(page);
  state.project.members[0].role = 'viewer';
  await page.goto('/#/projects/project-1/tasks');
  await expect(page.getByRole('button', { name: 'New task' })).toBeDisabled();
  await page.getByRole('link', { name: /Task returned by test API/ }).click();
  await expect(page.getByRole('button', { name: 'Review target' })).toBeDisabled();
  await expect(page.getByLabel('Human note', { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});
