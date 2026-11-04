import { expect, test, type Page, type Request } from '@playwright/test';
import { testProject, testTask } from './support/data';
import { readFileSync } from 'node:fs';

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
    if (path.endsWith('/plans')) {
      await route.fulfill({ json: [] });
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

test('workflow combines stages, preserves drafts and task filters, and keeps task links', async ({ page }) => {
  await connect(page);
  await page.goto('/#/projects/project-1/tasks?status=in_review&q=API');
  await expect(page).toHaveURL(/workflow\?status=in_review&q=API&stage=execute$/);
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('link', { name: 'Workflow', exact: true })).toBeVisible();
  for (const name of ['Tasks', 'Plans', 'Approvals']) await expect(navigation.getByRole('link', { name, exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Task status', { exact: true })).toHaveValue('in_review');
  const stages = page.getByRole('navigation', { name: 'Workflow stages' });
  await stages.getByRole('button', { name: /1 Plan/ }).click();
  await page.getByRole('button', { name: 'Write a plan manually' }).click();
  await page.getByLabel('Goal', { exact: true }).fill('Keep this unsaved goal');
  await stages.getByRole('button', { name: /3 Execute/ }).click();
  await page.getByLabel('Search tasks', { exact: true }).fill('Task returned');
  await stages.getByRole('button', { name: /1 Plan/ }).click();
  await expect(page.getByLabel('Goal', { exact: true })).toHaveValue('Keep this unsaved goal');
  await stages.getByRole('button', { name: /4 Review & finish/ }).click();
  await expect(page.getByRole('region', { name: 'Submitted work' })).toContainText('Task returned by test API');
  await page.getByRole('region', { name: 'Submitted work' }).getByRole('link').click();
  await expect(page).toHaveURL(/tasks\/task-1$/);
  await expect(navigation.getByRole('link', { name: 'Workflow', exact: true })).toHaveClass('active');
  await page.getByRole('link', { name: 'Back to workflow' }).click();
  await expect(page).toHaveURL(/workflow\?stage=execute$/);
});

test('workflow separates scope approvals from result reviews and respects viewer permissions', async ({ page }) => {
  const state = await connect(page);
  state.project.approvals.push({ ...state.project.approvals[0], id: 'scope-1', action: 'Approve contract', head: null });
  await page.goto('/#/projects/project-1/approvals?status=pending');
  await expect(page).toHaveURL(/workflow\?approvalStatus=pending&stage=scope$/);
  const stages = page.getByRole('navigation', { name: 'Workflow stages' });
  await expect(stages.getByRole('button', { name: /2 Approve scope/ })).toContainText('1 pending');
  await expect(page.locator('#workflow-scope .approval-card')).toHaveCount(1);
  await expect(page.locator('#workflow-scope .approval-card')).toContainText('Approve contract');
  await page.getByRole('button', { name: 'Review target', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Approve contract');
  await expect(page.getByRole('button', { name: 'Record approval', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#workflow-scope').getByLabel('Approval status', { exact: true }).selectOption('all');
  await expect(page).toHaveURL(/stage=scope/);
  await stages.getByRole('button', { name: /4 Review & finish/ }).click();
  await expect(page.locator('#workflow-review .approval-card')).toHaveCount(1);
  await expect(page.locator('#workflow-review .approval-card')).toContainText('Review result');
  await expect(stages.locator('[aria-current="step"]')).toHaveCount(1);
  await page.screenshot({ path: `/tmp/tandem-workflow-${page.viewportSize()!.width}.png`, fullPage: true, animations: 'disabled' });
  state.project.members[0].role = 'viewer';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review target', exact: true })).toBeDisabled();
  await stages.getByRole('button', { name: /1 Plan/ }).click();
  await expect(page.getByRole('button', { name: 'Write a plan manually' })).toBeDisabled();
});

test('approving a plan hands off to scope review without bypassing confirmation', async ({ page }) => {
  const state = await connect(page);
  const projectId = '11111111-1111-4111-8111-111111111111';
  const planId = '22222222-2222-4222-8222-222222222222';
  state.project.id = projectId;
  state.project.tasks = [];
  state.project.approvals = [];
  const plan = { projectId, planId, projectVersion: 4, planVersion: 1, approvedPlanVersion: null as number | null,
    createdBy: '33333333-3333-4333-8333-333333333333', createdAt: '2026-11-03T12:00:00Z',
    proposal: { goal: 'Ship the new feature', summary: 'One small task', tasks: [{ key: 'build', title: 'Build it', description: '', contractSummary: 'Small scope', paths: [], criteria: ['It works'], dependencies: [] }] } };
  await page.route(`**/api/projects/${projectId}/plans`, route => route.fulfill({ json: [plan] }));
  await page.route(`**/api/projects/${projectId}/plans/${planId}/approve`, async route => {
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ expectedVersion: 4, expectedPlanVersion: 1, startNow: false, note: 'Reviewed the scope' });
    plan.approvedPlanVersion = 1;
    state.project.version = 5;
    await route.fulfill({ json: { projectId, planId, projectVersion: 5, planVersion: 1, taskIds: {} } });
  });
  await page.goto(`/#/projects/${projectId}/plans`);
  await expect(page).toHaveURL(/workflow\?stage=plan$/);
  await page.getByRole('button', { name: 'Review and create tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve and create tasks', exact: true })).toBeDisabled();
  await page.getByLabel('Review note', { exact: true }).fill('Reviewed the scope');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Approve and create tasks', exact: true }).click();
  await expect(page).toHaveURL(/workflow\?stage=scope$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

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

test('clear chat confirms deletion, retries the same boundary, and keeps newer messages', async ({ page }) => {
  const state = await connect(page);
  const old = { id: 'old', operationId: 'check-1', senderUserId: null, sender: 'Agent', kind: 'agent',
    body: 'Previous message', state: 'complete', createdAt: new Date().toISOString(), response: null };
  let exchanges = [old];
  const deleted: string[] = [];
  await page.route('**/api/projects/project-1/room', async route => {
    if (route.request().method() === 'DELETE') {
      deleted.push(route.request().postDataJSON().throughId);
      if (deleted.length === 1) {
        await route.fulfill({ status: 503, json: { detail: 'Room unavailable' } });
      } else {
        exchanges = exchanges.filter(item => item.id !== 'old');
        await route.fulfill({ json: { cleared: true } });
      }
    } else await route.fulfill({ json: { exchanges } });
  });
  await page.goto('/#/projects/project-1/agents');
  await expect(page.getByText('Previous message', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear chat', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('permanently deletes');
  expect(deleted).toEqual([]);
  exchanges.push({ ...old, id: 'new', operationId: 'check-2', body: 'New arrival' });
  await page.getByRole('button', { name: 'Delete messages', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await expect(page.getByText('Previous message', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete messages', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Previous message', { exact: true })).toHaveCount(0);
  await expect(page.getByText('New arrival', { exact: true })).toBeVisible();
  expect(deleted).toEqual(['old', 'old']);
  await page.reload();
  await expect(page.getByText('Previous message', { exact: true })).toHaveCount(0);
  await expect(page.getByText('New arrival', { exact: true })).toBeVisible();
  state.project.members[0].role = 'viewer';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear chat', exact: true })).toHaveCount(0);
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

for (const editDraft of [false, true]) test(`agent room reconciles its completed operation (${editDraft ? 'edited' : 'unchanged'} draft)`, async ({ page }) => {
  await connect(page);
  let request: { operationId: string; body: string } | undefined;
  let confirmed = false;
  await page.route('**/api/projects/project-1/room', async route => {
    if (route.request().method() === 'POST') {
      request = route.request().postDataJSON();
      await route.fulfill({ status: 503 });
    } else {
      const exchange = { id: 'saved-message', operationId: 'older-operation', senderUserId: 'user-1', sender: 'Test owner', kind: 'human', body: 'ping agents', state: 'complete', createdAt: new Date().toISOString(),
        response: { reply: 'Presence requested.', proposal: null, cancelTaskIds: [] } };
      await route.fulfill({ json: { exchanges: [exchange, ...(request ? [{ ...exchange, id: 'matching-operation', operationId: request.operationId, senderUserId: confirmed ? 'user-1' : 'another-user' }] : [])] } });
    }
  });
  await page.goto('/#/projects/project-1/agents');
  const composer = page.getByRole('textbox', { name: 'Message mediator' });
  await composer.fill('ping agents');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('The API could not complete the request (HTTP 503).')).toBeVisible();
  // Neither repeated text nor another sender's operation proves this send succeeded.
  await expect(composer).toHaveValue('ping agents');
  if (editDraft) await composer.fill('My next question');
  confirmed = true;
  await expect(page.getByText('The API could not complete the request (HTTP 503).')).toHaveCount(0, { timeout: 12000 });
  await expect(composer).toHaveValue(editDraft ? 'My next question' : '');
  await expect(page.getByRole('button', { name: 'Retry previous message' })).toHaveCount(0);
});

test('agent room retries an uncertain send with its original operation and body', async ({ page }) => {
  await connect(page);
  const requests: { operationId: string; body: string }[] = [];
  await page.route('**/api/projects/project-1/room', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { exchanges: [] } });
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.fulfill({ status: 503 });
    await route.fulfill({ json: { id: 'saved', ...requests[0], senderUserId: 'user-1', sender: 'Test owner', kind: 'human', state: 'complete', createdAt: new Date().toISOString(), response: { reply: 'Done.', proposal: null, cancelTaskIds: [] } } });
  });
  await page.goto('/#/projects/project-1/agents');
  const composer = page.getByRole('textbox', { name: 'Message mediator' });
  await composer.fill('ping agents');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry previous message' })).toBeVisible();
  await composer.fill('My next question');
  await page.getByRole('button', { name: 'Retry previous message' }).click();
  await expect(page.getByRole('button', { name: 'Retry previous message' })).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(composer).toHaveValue('My next question');
});

test('worker onboarding generates isolated setup and continuous commands for each engine', async ({ page }) => {
  await connect(page);
  await page.route('**/.well-known/oauth-protected-resource/mcp/', route => route.fulfill({ json: { resource: 'https://api.tandem.test/mcp/' } }));
  await page.route('**/api/mcp/oauth/connections', route => route.fulfill({ json: [] }));
  await page.route('**/api/projects/project-1/room', route => route.fulfill({ json: { exchanges: [] } }));
  await page.goto('/#/projects/project-1/agents');
  await page.getByRole('button', { name: 'Connect agent', exact: true }).click();
  const worker = page.getByRole('region', { name: 'Continuous worker setup' });
  const script = await page.request.get('/downloads/tandem_runner.py');
  expect(script.status()).toBe(200);
  expect(await script.text()).toBe(readFileSync(new URL('../../../agent-integrations/runner/tandem_runner.py', import.meta.url), 'utf8'));
  await expect(worker).not.toContainText('agent-integrations/runner/');
  await expect(worker).toContainText('No access to Tandem’s private repository is needed.');
  await expect(worker.locator('pre')).toHaveCount(1);
  await expect(worker.locator('pre')).toContainText('$HOME/Downloads/tandem_runner.py');
  await expect(worker.locator('pre')).toContainText("--repository 'team/tandem'");
  await expect(worker.getByLabel('Project folder', { exact: true })).toHaveCount(0);
  const headings = page.getByRole('dialog').getByRole('heading', { level: 3 });
  await expect(headings).toHaveText(['1. Connect your agent', '2. Choose your worker', '3. Get your agent token', '4. Download and start']);
  await expect(worker.locator('pre')).toHaveCount(1);
  await expect(worker.getByRole('button', { name: 'Copy download and start command' })).toBeEnabled();
  for (const name of ['Copy clone command', 'Copy setup check', 'Copy worker command', 'Copy listener command']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  const install = worker.getByRole('region', { name: 'Download and start worker' });
  await expect(install.locator('pre')).toContainText("curl -fLsS 'http://127.0.0.1:4173/downloads/tandem_runner.py'");
  await expect(install.locator('pre')).toContainText('--project \'project-1\'');
  await expect(install.locator('pre')).toContainText('--agent codex');
  await expect(install.locator('pre')).toContainText('--prompt-token');
  await expect(install.locator('pre')).not.toContainText('git clone');
  await page.getByLabel('Your agent', { exact: true }).selectOption('Claude Code');
  await expect(worker.getByLabel('Worker engine')).toHaveValue('claude');
  await expect(install.locator('pre')).toContainText('--agent claude');
  await worker.getByLabel('Worker engine').selectOption('custom');
  await expect(worker.getByRole('button', { name: 'Copy worker command' })).toHaveCount(0);
  await expect(install.locator('pre')).toContainText('YOUR_AGENT_COMMAND');
  await expect(worker.getByRole('button', { name: 'Copy download and start command' })).toBeDisabled();
  await worker.getByLabel('Agent command', { exact: true }).fill('my-agent --headless');
  await expect(worker.getByRole('button', { name: 'Copy download and start command' })).toBeEnabled();
  await expect(install.locator('pre')).toContainText("--agent-command 'my-agent --headless'");
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
  await expect(page.getByRole('region', { name: 'Continuous worker setup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy listener command', exact: true })).toHaveCount(0);
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

async function mockGitHub(page: Page, connection: { connected: boolean; login: string | null }) {
  const installUrl = 'https://github.com/apps/tandem/installations/new';
  const repo = (id: number, name: string) => ({
    id, name, fullName: `octo/${name}`, defaultBranch: 'main', description: `About ${name}`,
  });
  const completed: unknown[] = [];
  await page.route('https://api.tandem.test/api/github/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/github/connection') {
      await route.fulfill({ json: { ...connection, installUrl } });
    } else if (url.pathname === '/api/github/complete') {
      completed.push(route.request().postDataJSON());
      connection.connected = true;
      connection.login = 'octo';
      await route.fulfill({ json: { login: 'octo' } });
    } else if (url.pathname === '/api/github/installations') {
      await route.fulfill({ json: { items: [{ id: 7, name: 'octo' }], hasMore: false, installUrl } });
    } else if (url.searchParams.get('page') === '1') {
      await route.fulfill({ json: { items: [repo(1, 'alpha'), repo(2, 'beta')], hasMore: true } });
    } else {
      await route.fulfill({ json: { items: [repo(3, 'on-page-two')], hasMore: false } });
    }
  });
  return completed;
}

test('create project sends an unlinked person to Settings, and an expired link says so', async ({ page }) => {
  await connect(page);
  const connection = { connected: false, login: null as string | null };
  await mockGitHub(page, connection);
  await page.goto('/#/projects/new');
  await expect(page.getByText('No GitHub account linked')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Repository' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import repository' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Link in Settings' }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();

  connection.login = 'octo';
  await page.reload();
  await expect(page.getByText('Expired', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect GitHub' })).toBeVisible();
});

test('one repository control searches every page and accepts a pasted URL', async ({ page }) => {
  await connect(page);
  await mockGitHub(page, { connected: true, login: 'octo' });
  await page.goto('/#/projects/new');
  await expect(page.getByText('Linked', { exact: true })).toBeVisible();
  await expect(page.getByText('Missing a repository?')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(1); // Only the top bar's.
  const importButton = page.getByRole('button', { name: 'Import repository' });
  await expect(importButton).toBeDisabled();
  await expect(page.getByText('Optional settings')).toHaveCount(0);

  const combobox = page.getByRole('combobox', { name: 'Repository' });
  await combobox.fill('https://github.com/octo/on-page-two.git');
  await expect(page.getByRole('option')).toHaveCount(1);
  await combobox.press('Enter');
  await expect(combobox).toHaveValue('octo/on-page-two');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(importButton).toBeEnabled();
  await expect(page.getByText('Optional settings')).toBeVisible();

  await combobox.fill('nothing-like-this');
  await expect(importButton).toBeDisabled();
  await expect(page.getByText('No repositories match.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Adjust GitHub access' })).toBeVisible();
});

test('settings finishes GitHub authorization and removes the code from the address', async ({ page }) => {
  await connect(page);
  const completed = await mockGitHub(page, { connected: false, login: null });
  await page.goto('/#/settings?github_code=abc&github_state=xyz');
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByText('Linked', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create a project' })).toBeVisible();
  expect(completed).toEqual([{ code: 'abc', state: 'xyz' }]);
});
