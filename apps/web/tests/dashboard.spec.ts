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

test('delayed session restoration preserves the task route across reload', async ({ page }) => {
  const state = await connect(page);
  await page.goto('/?test-auth=delayed#/projects/project-1/tasks/task-1');
  await expect(page.getByRole('button', { name: 'Sign in with Auth0' })).toHaveCount(0);
  expect(state.reads).toBe(0);
  await expect(page.getByRole('status')).toContainText('Checking your session');
  await page.evaluate(() => window.dispatchEvent(new Event('test-auth-restored')));
  await expect(page.getByRole('heading', { name: 'Task returned by test API', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Checking your session');
  await page.evaluate(() => window.dispatchEvent(new Event('test-auth-restored')));
  await expect(page.getByRole('button', { name: 'Sign in with Auth0' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Task returned by test API', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/projects\/project-1\/tasks\/task-1$/);
});

test('project edits persist after reload and stale tabs cannot overwrite them', async ({ page, context }) => {
  const state = await connect(page);
  const second = await context.newPage();
  const secondState = await connect(second);
  // Share the server record, while keeping each tab's form version independent.
  secondState.project = state.project;
  const writes: Request[] = [];
  for (const tab of [page, second]) {
    await tab.route('**/api/projects/project-1', async (route) => {
      const body = route.request().postDataJSON();
      writes.push(route.request());
      if (body.expectedVersion !== state.project.version) {
        await route.fulfill({ status: 409, json: { detail: 'Project version changed' } });
        return;
      }
      state.project.description = body.description;
      state.project.version++;
      await route.fulfill({ json: {
        projectId: state.project.id, entityId: state.project.id,
        projectVersion: state.project.version,
      } });
    });
    await tab.goto('/#/projects/project-1/setup');
    await expect(tab.getByRole('button', { name: 'Save project', exact: true })).toBeEnabled();
  }
  await second.getByLabel('Description', { exact: true }).fill('Stale tab draft');
  await page.getByLabel('Description', { exact: true }).fill('Saved owner description');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.getByText('Project saved by the backend.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Saved owner description');
  // Refresh exercises the same workspace update that polling delivers.
  await second.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(second.getByText('Newer project data is available.')).toBeVisible();
  await expect(second.getByRole('button', { name: 'Save project', exact: true })).toBeDisabled();
  await expect(second.getByLabel('Description', { exact: true })).toHaveValue('Stale tab draft');
  await second.getByRole('button', { name: 'Reload details', exact: true }).click();
  await expect(second.getByLabel('Description', { exact: true })).toHaveValue('Saved owner description');
  expect(writes).toHaveLength(1);
  expect(state.project.version).toBe(5);
  await second.close();
});

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
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with Auth0' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Task returned by test API', exact: true }),
  ).toHaveCount(0);
});

test('the account menu stays reachable on a short screen and only opens on click', async ({
  page,
}) => {
  await connect(page);
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto('/#/projects/project-1/activity');
  const account = page.getByRole('button', { name: 'Account menu' });
  await expect(account).toBeInViewport({ ratio: 1 });
  await expect(account).toContainText('TO');
  await expect(page.getByRole('menuitem', { name: 'Log out' })).toHaveCount(0);
  await account.click();
  await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeInViewport({ ratio: 1 });
});

test('settings saves a display name through the API and shows how you sign in', async ({
  page,
}) => {
  const user = {
    id: 'user-1',
    name: 'Test owner',
    email: 'test@example.com',
    emailVerified: false,
    signIns: [{ method: 'Email and password', current: true }],
  };
  await connect(page);
  const patches: unknown[] = [];
  await page.route('https://api.tandem.test/api/me', async (route) => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON());
      user.name = 'Renamed Person';
      await route.fulfill({ json: { id: user.id, name: user.name } });
      return;
    }
    await route.fulfill({ json: user });
  });
  await page.goto('/#/projects/project-1/activity');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByText('test@example.com')).toBeVisible();
  await expect(page.getByText('Not verified')).toBeVisible();
  await expect(page.getByText('Email and password')).toBeVisible();

  const save = page.getByRole('button', { name: 'Save name' });
  await expect(save).toBeDisabled();
  await page.getByLabel('Display name').fill('   ');
  await expect(save).toBeDisabled();
  await page.getByLabel('Display name').fill('  Renamed Person ');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Name saved' })).toBeVisible();
  expect(patches).toEqual([{ name: 'Renamed Person' }]);
  await expect(page.getByRole('button', { name: 'Account menu' })).toContainText('RP');
});

test('a failed name change keeps the draft and says so', async ({ page }) => {
  await connect(page);
  await page.route('https://api.tandem.test/api/me', async (route) => {
    if (route.request().method() === 'PATCH') await route.fulfill({ status: 503 });
    else await route.fulfill({ json: { id: 'user-1', name: 'Test owner' } });
  });
  await page.goto('/#/settings');
  await page.getByLabel('Display name').fill('Unsaved Name');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Display name')).toHaveValue('Unsaved Name');
  await expect(page.getByRole('button', { name: 'Account menu' })).toContainText('TO');
});

test('a missing or offline API shows failure without sample records', async ({ page }) => {
  const state = await connect(page);
  state.readStatus = 404;
  await page.goto('/#/dashboard');
  // Multiple sections may report the same backend outage at once. Target the
  // shared 404 message instead of assuming that the page renders one alert.
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'The requested resource or API endpoint was not found' })
      .first(),
  ).toBeVisible();
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

test('agent room renders standalone acknowledgements and groups presence counts', async ({ page }) => {
  const state = await connect(page);
  state.project.agents = (['online', 'stale', 'offline'] as const).map((presence, index) => ({
    id: `agent-${index}`, name: `Agent ${presence}`, client: 'Codex', owner: 'Test owner',
    machine: 'Laptop', capabilities: [], grant: 'active', presence, lastSeen: null, session: null,
  }));
  state.project.agents.push({ ...state.project.agents[0], id: 'revoked', name: 'Revoked agent', grant: 'revoked' });
  await page.route('**/api/projects/project-1/room', route => route.fulfill({ json: { mediatorModel: 'muse-spark-1.3-contributor', exchanges: [{
    id: 'ack-1', operationId: 'check-1', senderUserId: null, senderAgentId: 'agent-0', sender: 'Agent online', kind: 'agent',
    body: "I'm online.", state: 'complete', createdAt: new Date().toISOString(), response: null,
  }] } }));
  await page.goto('/#/projects/project-1/agents');
  await expect(page.getByText("I'm online.", { exact: true })).toBeVisible();
  await expect(page.locator('.room-mediator')).toHaveCount(0);
  await expect(page.getByRole('log').getByRole('img', { name: 'Codex', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Online · 1', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stale · 1', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Offline · 2', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'offline agents' }).getByText('Revoked agent')).toBeVisible();
});

test('agent room sends private human messages and opens connection onboarding', async ({ page }) => {
  await connect(page);
  await page.route('**/.well-known/oauth-protected-resource/mcp/', route => route.fulfill({
    json: { resource: 'https://api.tandem.test/mcp/' },
  }));
  await page.route('**/api/mcp/oauth/connections', route => route.fulfill({ json: [] }));
  const exchanges: Record<string, unknown>[] = [];
  await page.route('**/api/projects/project-1/room', async route => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON();
      const exchange = { id: 'exchange-1', operationId: request.operationId, senderUserId: 'user-1', sender: 'Test owner', kind: 'human', body: request.body, state: 'complete', createdAt: new Date().toISOString(),
        response: { reply: 'Let’s review the next tasks together.', model: 'muse-spark-1.3-contributor', proposal: null, cancelTaskIds: [] } };
      exchanges.push(exchange);
      await route.fulfill({ json: exchange });
    } else await route.fulfill({ json: { exchanges, mediatorModel: 'muse-spark-1.3-contributor' } });
  });
  await page.goto('/#/projects/project-1/agents');
  await expect(page.getByRole('heading', { name: 'Project room', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message mediator' }).fill('Change our next milestone');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Let’s review the next tasks together.')).toBeVisible();
  await expect(page.getByText('Human · hidden from agents', { exact: true })).toBeVisible();
  await expect(page.getByRole('log').getByRole('img', { name: 'Human profile', exact: true })).toBeVisible();
  await expect(page.locator('.room-mediator strong')).toHaveText('muse-spark-1.3-contributor');
  await expect(page.locator('.room-mediator .mediator-tag')).toHaveText('Mediator');
  await page.screenshot({ path: '/tmp/tandem-agent-room-' + page.viewportSize()!.width + '.png', fullPage: true });
  await page.getByRole('button', { name: 'Connect agent', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByText('Automatic room replies while idle', { exact: true }).click();
  await expect(page.getByRole('dialog').locator('pre').filter({ hasText: '--presence-only' })).toContainText('--project');
  await expect(page.getByRole('button', { name: 'Copy listener command', exact: true })).toBeVisible();
});

test('the site root is the public landing page and never waits for the session', async ({ page }) => {
  const state = await connect(page);
  await page.goto('/?test-auth=delayed');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('no collisions');
  await expect(page.getByText('Checking your session')).toHaveCount(0);
  expect(state.reads).toBe(0);
});

test('Open dashboard goes to the dashboard when a session is already cached', async ({ page }) => {
  await connect(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Open dashboard' }).first().click();
  await expect(page).toHaveURL(/#\/projects\/project-1\/activity$/);
});

test('Open dashboard goes to sign-in when there is no session', async ({ page }) => {
  await connect(page);
  await page.goto('/?test-auth=off');
  await page.getByRole('link', { name: 'Open dashboard' }).first().click();
  await expect(page).toHaveURL(/#\/signin$/);
  await expect(page.getByRole('button', { name: 'Sign in with Auth0' })).toBeVisible();
});
